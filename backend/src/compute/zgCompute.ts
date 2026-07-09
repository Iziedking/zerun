import { ethers } from "ethers";
import { createRequire } from "node:module";
import { config } from "../config/index.js";
import { modelsMatch } from "./modelMatch.js";

// The serving broker ships a broken ESM re-export, so load its CommonJS build
// through require. The types still resolve from the package's type entry.
const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

// The 0G Compute brain. Every agent answer in Zerun is produced by a call that
// runs here: a paid, TEE-verifiable inference request to a provider on the 0G
// Compute Network. The on-chain ledger payment and the TEE verdict are what we
// surface to the UI as proof that the agent actually thought on 0G.
//
// Two NETWORKS, tried in order per call: MAINNET first (real 0G, the real model
// catalog) when it is configured, then the TESTNET compute wallet as an automatic
// fallback so a mainnet outage never stalls a contest. Each network runs its own
// broker, ledger, and provider handles; the arena's smart contracts are unaffected
// (they live on the testnet chain in config.chain — inference is decoupled from them).
//
// Lifecycle per network, matching the 0G serving-broker SDK (0.6.2):
//   1. createZGComputeNetworkBroker(wallet)
//   2. ledger.addLedger(n) once, or ledger.depositFund(n) to top up. `n` is the AVAILABLE
//      float; mainnet rejects a first deposit under 3 0G.
//   3. inference.listService() -> pick a provider
//   4. inference.acknowledgeProviderSigner(provider)  (accept its TEE signer)
//   5. inference.getServiceMetadata(provider) -> { endpoint, model }
//   6. once per provider: GET {endpoint}/attestation/report -> can it sign a response at all?
//   7. once per provider, IF it lacks headroom: ledger.transferFund(provider, "inference", n).
//      getRequestHeaders (step 8) funds the sub-account itself on first use, but only to
//      max(2e6 * (inputPrice + outputPrice), 1 0G) — and 1 0G is exactly the provider's own
//      minimum reserve, so it can pay no fees. Check the balance before topping up: this
//      code runs on every process start, and each top-up locks 1 0G for 24 hours.
//   8. per request: inference.getRequestHeaders(provider, content) -> headers
//   9. POST {endpoint}/chat/completions with those single-use headers
//  10. inference.processResponse(provider, id, answer) -> TEE verified boolean, but only
//      when step 6 said the provider attests. No live provider does, today.

type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

export interface ProviderHandle {
  provider: string;
  endpoint: string;
  model: string;
  // Whether this provider can sign an individual response, i.e. whether processResponse
  // could ever return true. Most 0G providers advertise `verifiability: "TeeML"` but proxy
  // to a centralized API, and their attestation endpoint answers 501: the TEE covers their
  // gateway, not the inference. Asking such a provider to sign every answer costs a doomed
  // HTTP round trip on the hot path and always yields `verified: null`. Checked once, here.
  attests: boolean;
}

// One bounded GET to the provider's attestation report. This is exactly what the SDK's
// verifier fetches first, so if it fails, processResponse cannot succeed either.
async function checkAttestation(endpoint: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/attestation/report?model=${encodeURIComponent(model)}`, {
      method: "GET",
      signal: AbortSignal.timeout(ATTESTATION_CHECK_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
const ATTESTATION_CHECK_MS = Number(process.env.COMPUTE_ATTESTATION_CHECK_MS ?? "8000");

// The provider's own floor, and the on-chain MIN_TRANSFER_AMOUNT: a sub-account funded to
// exactly this can pay no fees at all.
const PROVIDER_RESERVE_OG = 1;
// How much spare a sub-account must hold above that reserve before we stop topping it up.
// A call costs on the order of 0.001-0.007 0G, so 0.5 0G is several hundred answers at the
// base tier. Sized against the worst case we actually run: a chess tournament is ~300 calls
// in one contest, and a sub-account that runs dry mid-bracket starts returning 400s and the
// tier silently falls back for the rest of the game.
const MIN_HEADROOM_OG = Number(process.env.COMPUTE_MIN_HEADROOM_OG ?? "0.5");

// The 0G actually spendable in a provider's sub-account: its balance less anything already
// requested as a refund (a pending refund is not available to pay fees).
async function currentHeadroomOg(broker: Broker, provider: string): Promise<number | null> {
  try {
    const acct = (await withTimeout("getAccount", broker.inference.getAccount(provider))) as unknown as {
      balance: bigint;
      pendingRefund: bigint;
    };
    return Number(ethers.formatEther(acct.balance - acct.pendingRefund));
  } catch {
    return null; // no sub-account yet
  }
}

export interface ComputeAnswer {
  text: string;
  chatID: string | null;
  verified: boolean | null;
  provider: string;
  model: string;
  endpoint: string;
  latencyMs: number;
  // Which 0G network actually answered ("mainnet" | "testnet"), for the logs/feed.
  network?: string;
}

// ---------------------------------------------------------------------------
// Shared, network-agnostic helpers (rate limiting, timeouts, the raw HTTP call).
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// MEASURED, not guessed (src/scripts/rateProbe.ts, 2026-07-09):
//
//   testnet  qwen2.5-omni   429 after exactly 10 calls: "limit: 10 requests/min". Latency ~3.8s.
//   mainnet  qwen3-vl       45/45 back-to-back, zero refusals, ~48 req/min. Latency ~1.3s.
//
// The 10/min ceiling belongs to the testnet provider, not to 0G. Pacing both networks at 7s
// throttled mainnet to testnet's budget: five times slower than it needed to be, and one 0G
// call per chess ply is what decides whether a game can reach checkmate.
//
// So the queue is PER NETWORK. Each has its own interval and its own in-flight chain. A mainnet
// call and a testnet call may overlap: different brokers, different chains, different provider
// sub-accounts, so the single-use request-header nonces cannot collide.
const TESTNET_MIN_INTERVAL_MS = Number(process.env.COMPUTE_MIN_INTERVAL_MS ?? "7000");
const MAINNET_MIN_INTERVAL_MS = Number(process.env.COMPUTE_MAINNET_MIN_INTERVAL_MS ?? "1500");

// Cap every 0G broker SDK call (broker creation, ledger funding, provider setup, header
// signing, TEE verification). Those calls hit the 0G chain/RPC and have no timeout of
// their own, so a stalled RPC would hang the whole contest run until the settlement
// watchdog fired. This makes a stall fail fast. Tunable via env.
const BROKER_TIMEOUT_MS = Number(process.env.COMPUTE_BROKER_TIMEOUT_MS ?? "45000");
function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`0G broker ${label} timed out after ${BROKER_TIMEOUT_MS}ms`)),
      BROKER_TIMEOUT_MS,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * One serialized, paced queue. The broker signs single-use headers per request and those
 * nonces collide if two requests to the same provider overlap, so calls within a network run
 * one at a time, `minIntervalMs` apart at the start.
 */
function makeQueue(minIntervalMs: number) {
  let inflight: Promise<unknown> = Promise.resolve();
  let lastCallStart = 0;
  return function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const throttled = async (): Promise<T> => {
      const wait = lastCallStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallStart = Date.now();
      return fn();
    };
    const run = inflight.then(throttled, throttled);
    inflight = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

// The serving struct is an ethers tuple; read the fields we care about by index.
// [0] provider, [1] serviceType, [2] url, [3] inputPrice, [4] outputPrice, [5] updatedAt,
// [6] model, [7] verifiability, [8] additionalInfo, [9] TEE signer, [10] healthy
function readService(s: unknown) {
  const t = s as unknown[];

  // The attesting signer. It was read from additionalInfo.TargetTeeAddress, but every live
  // provider on both networks publishes that as an empty string and carries the real signer
  // at tuple index [9]. Reading only the JSON made almost every TeeML provider score as
  // non-attesting, which distorted the ranking. Prefer the JSON when populated, since it is
  // the documented field, then fall back to the struct.
  let teeTarget = "";
  try {
    teeTarget = String(JSON.parse(String(t[8] ?? "{}")).TargetTeeAddress ?? "");
  } catch {
    teeTarget = "";
  }
  if (!teeTarget) {
    const signer = String(t[9] ?? "");
    if (/^0x[0-9a-fA-F]{40}$/.test(signer) && !/^0x0{40}$/.test(signer)) teeTarget = signer;
  }

  return {
    provider: String(t[0]),
    serviceType: String(t[1]),
    model: String(t[6] ?? ""),
    verifiability: String(t[7] ?? ""),
    healthy: t[10] === true,
    teeTarget,
  };
}

// Bound each non-final (premium) attempt so a flagged-unhealthy provider that is truly
// down fails fast and the healthy fallback still runs within the contest's budget.
const PREMIUM_ATTEMPT_TIMEOUT_MS = Number(process.env.COMPUTE_PREMIUM_ATTEMPT_MS ?? "30000");

// One request to a single provider. Throws on any failure (HTTP error, timeout, or an
// empty answer) so the caller can fall back to the next candidate.
async function attemptProvider(
  broker: Broker,
  h: ProviderHandle,
  params: { systemPrompt: string; userPrompt: string; maxTokens: number; temperature: number },
  timeoutMs: number,
): Promise<ComputeAnswer> {
  const messages = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: params.userPrompt },
  ];
  const headers = await withTimeout(
    "getRequestHeaders",
    broker.inference.getRequestHeaders(h.provider, params.userPrompt),
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let data: { id?: string; choices?: Array<{ message?: { content?: string } }> };
  try {
    const res = await fetch(`${h.endpoint}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
      body: JSON.stringify({ model: h.model, messages, max_tokens: params.maxTokens, temperature: params.temperature }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`0G provider ${h.model} responded ${res.status}: ${body.slice(0, 200)}`);
    }
    data = (await res.json()) as typeof data;
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - t0;

  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error(`0G provider ${h.model} returned an empty answer`);
  const chatID = data.id ?? null;

  // Verify the TEE-signed response on chain. This is the proof the answer came from the
  // provider we paid, not a substitute. Only a provider that runs the model INSIDE the
  // enclave can attest; one that proxies to a centralized API cannot, and `h.attests` says
  // which. `verified: null` therefore means "this provider cannot attest", not "we failed".
  let verified: boolean | null = null;
  if (chatID && h.attests) {
    try {
      verified = await withTimeout("processResponse", broker.inference.processResponse(h.provider, chatID, text));
    } catch {
      verified = null;
    }
  }

  return { text, chatID, verified, provider: h.provider, model: h.model, endpoint: h.endpoint, latencyMs };
}

// ---------------------------------------------------------------------------
// One 0G network (its own wallet, broker, ledger, and provider handles).
// ---------------------------------------------------------------------------

export interface NetworkConfig {
  label: string; // "mainnet" | "testnet"
  rpcUrl: string;
  signerKey: string;
  /** The AVAILABLE ledger float to maintain. Mainnet enforces a 3 0G minimum first deposit. */
  ledgerOg: number;
  /** Hard ceiling on the ledger's TOTAL balance. We never deposit past this. */
  ledgerMaxOg: number;
  /** Minimum gap between the START of two calls on this network. Measured, see above. */
  minIntervalMs: number;
  /**
   * Extra 0G locked into each provider's sub-account ON TOP of the 1 0G the SDK transfers,
   * which is itself exactly the provider's minimum reserve. Without headroom the account
   * cannot cover its own unsettled fees and the provider rejects every call after the first.
   * Floored at 1 by the contract's MIN_TRANSFER_AMOUNT, so budget 2 0G per provider.
   */
  perProviderOg: number;
  pinnedProvider: string;
}

// How long a successful ledger check stays trusted. Without this every inference call
// re-reads the ledger over RPC, which is both slow and a needless failure surface.
const LEDGER_RECHECK_MS = Number(process.env.COMPUTE_LEDGER_RECHECK_MS ?? "60000");

// The 0G ledger contract rejects a first deposit below the network's floor with a custom
// error carrying (sent, minimum). Mainnet's floor is 3 0G. Without decoding it, the SDK
// surfaces only "execution reverted (unknown custom error)", which sends you hunting for a
// bug in your own code when the chain is simply telling you the number.
const LEDGER_BELOW_MINIMUM = "0x54443ec4";

function explainLedgerRevert(err: unknown, label: string, sentOg: number): string {
  const e = err as { data?: string; info?: { error?: { data?: string } }; message?: string };
  const data = e?.data ?? e?.info?.error?.data ?? "";
  if (typeof data === "string" && data.startsWith(LEDGER_BELOW_MINIMUM) && data.length >= 138) {
    try {
      const sent = ethers.formatEther(BigInt(`0x${data.slice(10, 74)}`));
      const min = ethers.formatEther(BigInt(`0x${data.slice(74, 138)}`));
      return (
        `0G ${label} requires a minimum first ledger deposit of ${min} 0G, but ${sent} 0G was offered. ` +
        `Raise COMPUTE_${label.toUpperCase()}_LEDGER_OG to at least ${min}.`
      );
    } catch {
      /* fall through to the raw message */
    }
  }
  return `${(e?.message ?? String(err))} (offered ${sentOg} 0G)`;
}

function makeNetwork(net: NetworkConfig) {
  // This network's own paced queue. Not shared: their rate limits differ by 5x.
  const serialize = makeQueue(net.minIntervalMs);
  let brokerPromise: Promise<Broker> | null = null;
  let handle: ProviderHandle | null = null;
  let readyPromise: Promise<ProviderHandle> | null = null;
  const handles = new Map<string, ProviderHandle>();
  const setupPromises = new Map<string, Promise<ProviderHandle>>();

  // Every wallet-writing broker call (addLedger, depositFund, acknowledgeProviderSigner,
  // transferFund) is a transaction signed by ONE key. Concurrent agents would otherwise
  // build several transactions on the same nonce and all but one would revert, killing a
  // whole contest's inference before a single request is even sent. Serialize them.
  let walletChain: Promise<unknown> = Promise.resolve();
  function walletWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = walletChain.then(fn, fn);
    walletChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function getWallet(): ethers.Wallet {
    if (!net.signerKey) {
      throw new Error(`${net.label} 0G Compute needs a funded wallet key`);
    }
    const provider = new ethers.JsonRpcProvider(net.rpcUrl);
    return new ethers.Wallet(net.signerKey, provider);
  }

  async function getBroker(): Promise<Broker> {
    if (!brokerPromise) {
      // Reset the cached promise if creation fails or times out, so the next call rebuilds
      // a fresh broker instead of forever returning the same rejected promise.
      brokerPromise = withTimeout("createBroker", createZGComputeNetworkBroker(getWallet())).catch((e) => {
        brokerPromise = null;
        throw e;
      });
    }
    return brokerPromise;
  }

  // The ledger's AVAILABLE balance, not its total.
  //
  // `totalBalance` counts 0G already locked into provider sub-accounts; `availableBalance`
  // is what can still fund a new provider. Reading the total meant that once the ledger was
  // fully locked across a few providers, `ensureLedger` saw "balance >= target" and never
  // deposited again — so a new tier's provider could never be set up, its
  // `acknowledgeProviderSigner` reverted, and every agent at that tier silently fell back to
  // the base model. The old code read `.balance`, which does not exist on the struct at all,
  // and so always landed on `totalBalance`.
  async function readLedger(broker: Broker): Promise<{ available: number; total: number } | null> {
    try {
      const ledger = (await withTimeout("getLedger", broker.ledger.getLedger())) as unknown as {
        availableBalance?: bigint;
        totalBalance?: bigint;
      };
      const total = ledger.totalBalance ?? 0n;
      const available = ledger.availableBalance ?? total;
      return { available: Number(ethers.formatEther(available)), total: Number(ethers.formatEther(total)) };
    } catch {
      return null;
    }
  }

  async function ledgerBalanceOg(broker: Broker): Promise<number | null> {
    const l = await readLedger(broker);
    return l ? l.available : null;
  }

  // Single-flight and cached: every inference call funnels through here, and three agents
  // run concurrently. A funding hiccup must not kill a call the existing balance can pay
  // for, so a failed top-up falls through to whatever the ledger already holds.
  let ledgerInflight: Promise<number> | null = null;
  let ledgerBalance = 0;
  let ledgerFreshUntil = 0;

  async function ensureLedger(force = false): Promise<number> {
    if (!force && Date.now() < ledgerFreshUntil) return ledgerBalance;
    if (ledgerInflight) return ledgerInflight;

    ledgerInflight = (async () => {
      const broker = await getBroker();
      const target = net.ledgerOg;
      const current = await ledgerBalanceOg(broker);

      if (current === null) {
        try {
          await walletWrite(() => withTimeout("addLedger", broker.ledger.addLedger(target)));
          return target;
        } catch (err) {
          // The read may simply have failed on a flaky RPC while the ledger exists. Re-read
          // before giving up, so a stale read cannot bring the whole contest down.
          console.warn(`[${net.label}] addLedger failed: ${explainLedgerRevert(err, net.label, target)}`);
          const retry = await ledgerBalanceOg(broker);
          if (retry === null) throw err;
          return retry;
        }
      }

      if (current < target) {
        // `ledgerOg` is the AVAILABLE float we keep, and every new provider permanently
        // locks at least 1 0G out of it, so total deposits grow as tiers are set up. On
        // mainnet that is real money, so refuse to deposit past a hard ceiling rather than
        // top up forever if something is draining the ledger.
        const total = (await readLedger(broker))?.total ?? 0;
        if (total >= net.ledgerMaxOg) {
          console.warn(
            `[${net.label}] ledger total is ${total} 0G, at or above the ${net.ledgerMaxOg} 0G ceiling; ` +
              `not depositing (available ${current} 0G). Raise COMPUTE_${net.label.toUpperCase()}_LEDGER_MAX_OG if this is expected.`,
          );
          return current;
        }
        try {
          await walletWrite(() => withTimeout("depositFund", broker.ledger.depositFund(target - current)));
          return target;
        } catch (err) {
          console.warn(
            `[${net.label}] depositFund failed, continuing on the existing ${current} OG: ` +
              explainLedgerRevert(err, net.label, target - current),
          );
          return current;
        }
      }
      return current;
    })()
      .then((bal) => {
        ledgerBalance = bal;
        ledgerFreshUntil = Date.now() + LEDGER_RECHECK_MS;
        return bal;
      })
      .finally(() => {
        ledgerInflight = null;
      });

    return ledgerInflight;
  }

  // Pick the best chatbot provider (healthy + real TEE attestation ranks highest), or the
  // pinned one. Falls back to any working provider so agents keep thinking on 0G.
  async function pickProvider(broker: Broker): Promise<string> {
    if (net.pinnedProvider) return net.pinnedProvider;

    const services = (await withTimeout("listService", broker.inference.listService())).map(readService);
    if (!services.length) throw new Error(`0G Compute (${net.label}) returned no live providers`);

    const chat = services.filter((s) => s.serviceType === "chatbot");
    const pool = chat.length ? chat : services;
    // Health dominates. The old weights let an UNHEALTHY TEE provider tie or beat a healthy
    // one, and this is the guaranteed tail every tier falls back to — the last provider that
    // should be down. Same weights as resolveCandidates, so the two agree on "best".
    const score = (s: ReturnType<typeof readService>) =>
      (s.healthy ? 4 : 0) + (s.verifiability === "TeeML" ? 2 : 0) + (s.teeTarget ? 1 : 0);
    pool.sort((a, b) => score(b) - score(a));
    return pool[0]!.provider;
  }

  async function listProviders(): Promise<
    { provider: string; model: string; serviceType: string; verifiability: string; healthy: boolean; teeTarget: string }[]
  > {
    const broker = await getBroker();
    return (await withTimeout("listService", broker.inference.listService())).map(readService);
  }

  // Bring one provider to a ready state (acknowledge signer, fund its sub-account, cache
  // its metadata). Single-flight per provider.
  async function getHandleFor(broker: Broker, provider: string): Promise<ProviderHandle> {
    const cached = handles.get(provider);
    if (cached) return cached;

    let p = setupPromises.get(provider);
    if (!p) {
      p = (async () => {
        try {
          await walletWrite(() =>
            withTimeout("acknowledgeProviderSigner", broker.inference.acknowledgeProviderSigner(provider)),
          );
        } catch (err) {
          console.warn(`[${net.label}] acknowledgeProviderSigner skipped: ${(err as Error).message}`);
        }
        // Give the sub-account HEADROOM above the provider's minimum reserve.
        //
        // The SDK funds each sub-account itself inside getRequestHeaders
        // (`topUpAccountIfNeeded` transfers `max(2e6 * (inputPrice + outputPrice), 1 0G)`),
        // and for every model we route to, that formula lands on the 1 0G floor. But 1 0G is
        // exactly the provider's own `minimum reserve`, so the account has nothing to pay
        // fees from. The first call accrues an unsettled fee and the provider then rejects
        // every request:
        //
        //   400 validate request: insufficient balance: your locked balance is 1.000000 0G,
        //   but the required minimum is 1.001362 0G (breakdown: minimum reserve 1.000000 0G
        //   + unsettled fees 0.001362 0G + ...)
        //
        // A tier looked healthy in `models:list` and served exactly one answer before
        // silently falling back to the base model forever. So we top the account up.
        //
        // The amount is contract-floored: MIN_TRANSFER_AMOUNT is 1 0G on chain, so anything
        // smaller reverts. Budget 2 0G of ledger per provider (the SDK's reserve plus this).
        //
        // CHECK FIRST. This runs on every handle setup, and handles are per-process, so a
        // restarted backend would top every provider up again. Locking a further 1 0G per
        // provider per restart drains a ledger fast, and it is not recoverable for 24 hours.
        try {
          const locked = await currentHeadroomOg(broker, provider);
          if (locked !== null && locked >= PROVIDER_RESERVE_OG + MIN_HEADROOM_OG) {
            // Already has headroom. Do nothing: another 1 0G would be locked for 24 hours.
          } else {
            const topUpOg = Math.max(1, net.perProviderOg);
            await walletWrite(() =>
              withTimeout(
                "transferFund",
                broker.ledger.transferFund(provider, "inference", ethers.parseEther(String(topUpOg))),
              ),
            );
            console.log(`[${net.label}] locked ${topUpOg} 0G of fee headroom into ${provider.slice(0, 10)}…`);
          }
        } catch (err) {
          // Not fatal: the account may already hold headroom. If it does not, the provider's
          // 400 above tells us plainly, and the tier falls back to the next candidate.
          console.warn(`[${net.label}] fee headroom top-up skipped for ${provider}: ${(err as Error).message}`);
        }
        const { endpoint, model } = await withTimeout(
          "getServiceMetadata",
          broker.inference.getServiceMetadata(provider),
        );
        // Once per provider, not once per answer.
        const attests = await checkAttestation(endpoint, model);
        if (!attests) {
          console.warn(
            `[${net.label}] ${model} cannot sign responses (its attestation endpoint declines), so its answers ` +
              `will be paid and recorded on 0G but never TEE-verified`,
          );
        }
        const h: ProviderHandle = { provider, endpoint, model, attests };
        handles.set(provider, h);
        return h;
      })();
      setupPromises.set(provider, p);
    }

    try {
      return await p;
    } catch (err) {
      setupPromises.delete(provider);
      throw err;
    }
  }

  async function ensureReady(): Promise<ProviderHandle> {
    if (handle) return handle;
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      const broker = await getBroker();
      await ensureLedger();
      const provider = await pickProvider(broker);
      handle = await getHandleFor(broker, provider);
      return handle;
    })();

    try {
      return await readyPromise;
    } catch (err) {
      readyPromise = null;
      throw err;
    }
  }

  // The ORDERED list of provider handles to try for a tier: providers serving the tier's
  // preferred models first (healthy + TEE + attesting ranks highest), then the default
  // best as a guaranteed tail. Includes providers the broker flags unhealthy, because on
  // 0G the TEE-capable chat providers are often flagged unhealthy yet still serve.
  async function resolveCandidates(preferredModels?: string[]): Promise<ProviderHandle[]> {
    const broker = await getBroker();
    await ensureLedger();

    const out: ProviderHandle[] = [];
    const seen = new Set<string>();
    const push = async (provider: string) => {
      if (seen.has(provider)) return;
      seen.add(provider);
      try {
        out.push(await getHandleFor(broker, provider));
      } catch (err) {
        console.warn(`[${net.label}] provider ${provider} setup skipped: ${(err as Error).message}`);
      }
    };

    if (preferredModels && preferredModels.length > 0) {
      const services = (await withTimeout("listService", broker.inference.listService())).map(readService);
      const chat = services.filter((s) => s.serviceType === "chatbot");
      const score = (s: ReturnType<typeof readService>) =>
        (s.healthy ? 4 : 0) + (s.verifiability === "TeeML" ? 2 : 0) + (s.teeTarget ? 1 : 0);
      for (const want of preferredModels) {
        const matches = chat.filter((s) => modelsMatch(want, s.model)).sort((a, b) => score(b) - score(a));
        for (const m of matches) await push(m.provider);
      }
    }

    // Guaranteed tail: the default best provider, so a tier can never stall.
    try {
      await push((await ensureReady()).provider);
    } catch (err) {
      console.warn(`[${net.label}] default provider unavailable: ${(err as Error).message}`);
    }
    return out;
  }

  // One paid, verifiable inference call on THIS network. Tries the tier's preferred models
  // in order (their providers first, then the default best), keeping the first that
  // actually answers. Throws if no provider on this network answers, so the caller can try
  // the next network.
  async function computeChat(params: {
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
    models?: string[];
  }): Promise<ComputeAnswer> {
    const broker = await getBroker();
    const candidates = await resolveCandidates(params.models);
    if (candidates.length === 0) candidates.push(await ensureReady());

    return serialize(async () => {
      let lastErr: unknown;
      for (let i = 0; i < candidates.length; i++) {
        const isLast = i === candidates.length - 1;
        const timeoutMs = isLast
          ? config.compute.callTimeoutMs
          : Math.min(config.compute.callTimeoutMs, PREMIUM_ATTEMPT_TIMEOUT_MS);
        try {
          const ans = await attemptProvider(broker, candidates[i]!, params, timeoutMs);
          return { ...ans, network: net.label };
        } catch (err) {
          lastErr = err;
          // Log the LAST candidate too. Without this a fully failed call is silent, and the
          // agent shows a bare "error" in the feed with no way to learn why.
          console.warn(
            `[${net.label}] 0G ${candidates[i]!.model} failed${isLast ? "" : ", falling back"}: ${(err as Error).message}`,
          );
        }
      }
      throw (lastErr as Error) ?? new Error(`no 0G provider answered on ${net.label}`);
    });
  }

  async function logTierRouting(tierModels: string[][]): Promise<void> {
    try {
      const providers = await listProviders();
      const healthy = providers.filter((p) => p.serviceType === "chatbot" && p.healthy);
      console.log(`0G models live on ${net.label} (healthy chatbot): ${healthy.map((p) => p.model || "?").join(", ") || "(none)"}`);
      tierModels.forEach((models, lvl) => {
        const hit = models.find((want) => healthy.some((p) => modelsMatch(want, p.model)));
        const resolved = hit
          ? healthy.find((p) => modelsMatch(hit, p.model))!.model
          : "(default best / base fallback)";
        console.log(`  [${net.label}] tier ${lvl}: prefers [${models.join(" > ") || "default"}]  ->  ${resolved}`);
      });
    } catch (err) {
      console.warn(`[${net.label}] logTierRouting skipped: ${(err as Error).message}`);
    }
  }

  function configured(): boolean {
    return Boolean(net.signerKey && net.rpcUrl);
  }

  return { label: net.label, ensureLedger, ensureReady, listProviders, resolveCandidates, computeChat, logTierRouting, configured };
}

type Network = ReturnType<typeof makeNetwork>;

// ---------------------------------------------------------------------------
// The two networks and the mainnet-first / testnet-fallback orchestration.
// ---------------------------------------------------------------------------

const testnetNetwork = makeNetwork({
  label: "testnet",
  minIntervalMs: TESTNET_MIN_INTERVAL_MS,
  rpcUrl: config.chain.rpcUrl,
  signerKey: config.signerKey,
  ledgerOg: config.compute.ledgerOg,
  ledgerMaxOg: config.compute.ledgerMaxOg,
  perProviderOg: config.compute.perProviderOg,
  pinnedProvider: config.compute.pinnedProvider,
});

// Mainnet is active only when its RPC + a wallet key are set. It always leads, with the
// testnet network as the automatic per-call fallback.
const mainnetEnabled = Boolean(config.compute.mainnet.rpcUrl && config.compute.mainnet.signerKey);
const mainnetNetwork: Network | null = mainnetEnabled
  ? makeNetwork({
      label: "mainnet",
      minIntervalMs: MAINNET_MIN_INTERVAL_MS,
      rpcUrl: config.compute.mainnet.rpcUrl,
      signerKey: config.compute.mainnet.signerKey,
      ledgerOg: config.compute.mainnet.ledgerOg,
      ledgerMaxOg: config.compute.mainnet.ledgerMaxOg,
      perProviderOg: config.compute.mainnet.perProviderOg,
      pinnedProvider: config.compute.mainnet.pinnedProvider,
    })
  : null;

// All configured networks (diagnostics/funding use this, ignoring the breaker below).
function networks(): Network[] {
  return mainnetNetwork ? [mainnetNetwork, testnetNetwork] : [testnetNetwork];
}

export function mainnetComputeEnabled(): boolean {
  return mainnetEnabled;
}

// Circuit breaker for the mainnet leg. Without it, a SUSTAINED mainnet outage would make
// every call pay the full mainnet attempt (up to the RPC/ledger timeout) before falling
// back — defeating the point of a fallback. After a run of consecutive mainnet failures we
// skip mainnet for a cooldown so calls go straight to testnet, then probe mainnet again.
const MAINNET_TRIP_THRESHOLD = Number(process.env.COMPUTE_MAINNET_TRIP ?? "2");
const MAINNET_COOLDOWN_MS = Number(process.env.COMPUTE_MAINNET_COOLDOWN_MS ?? "120000");
let mainnetFailStreak = 0;
let mainnetSkipUntil = 0;

// The lowest Compute level allowed to reason on mainnet. The premium tiers are what an
// operator paid real 0G to reach, so they are what spends real 0G to think; levels below
// this never leave testnet, which keeps the house field and every free agent off the bill.
const MAINNET_MIN_TIER = Number(process.env.COMPUTE_MAINNET_MIN_TIER ?? "4");

/** Does a call at this Compute level get to use mainnet at all? */
export function tierUsesMainnet(tier: number | undefined): boolean {
  return mainnetEnabled && typeof tier === "number" && tier >= MAINNET_MIN_TIER;
}

// The per-call network order.
//
// A premium tier leads with mainnet and falls back to testnet on any hiccup. Every other
// tier is testnet-only: it is not a fallback for them, it is the whole story. The circuit
// breaker can also send a premium call straight to testnet while mainnet is tripped.
function callOrder(tier: number | undefined): Network[] {
  if (!mainnetNetwork || !tierUsesMainnet(tier)) return [testnetNetwork];
  if (Date.now() < mainnetSkipUntil) return [testnetNetwork];
  return [mainnetNetwork, testnetNetwork];
}

// One paid, verifiable inference call. Tries mainnet first (when configured and not
// tripped); on any failure — provider down, rate-limited, empty answer, RPC stall — it
// falls through to the testnet compute wallet, so a mainnet outage never stalls a contest.
export async function computeChat(params: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  models?: string[];
  /** The agent's Compute level. Only the premium tiers reach mainnet. */
  tier?: number;
}): Promise<ComputeAnswer> {
  const nets = callOrder(params.tier);
  let lastErr: unknown;
  for (let i = 0; i < nets.length; i++) {
    const net = nets[i]!;
    const isMainnet = net === mainnetNetwork;
    try {
      const ans = await net.computeChat(params);
      if (isMainnet) mainnetFailStreak = 0; // mainnet healthy again
      return ans;
    } catch (err) {
      lastErr = err;
      if (isMainnet) {
        mainnetFailStreak += 1;
        if (mainnetFailStreak >= MAINNET_TRIP_THRESHOLD) {
          mainnetSkipUntil = Date.now() + MAINNET_COOLDOWN_MS;
          mainnetFailStreak = 0;
          console.warn(`0G mainnet compute tripped; skipping it for ${MAINNET_COOLDOWN_MS / 1000}s (testnet only)`);
        }
      }
      const next = nets[i + 1];
      if (next) {
        console.warn(`0G ${net.label} compute failed, falling back to ${next.label}: ${(err as Error).message}`);
      }
    }
  }
  const err = (lastErr as Error) ?? new Error("no 0G network answered");
  console.error(`0G compute call failed on every network (${nets.map((n) => n.label).join(", ")}): ${err.message}`);
  throw err;
}

// Fund every configured network's ledger (so `pnpm ledger:fund` tops up mainnet AND
// testnet), returning the primary network's balance. Best effort per network.
export async function ensureLedger(): Promise<number> {
  const nets = networks();
  let primary = 0;
  for (const [i, n] of nets.entries()) {
    try {
      // force: the funding script must read the real balance, not a cached one.
      const bal = await n.ensureLedger(true);
      if (i === 0) primary = bal;
    } catch (err) {
      console.warn(`[${n.label}] ledger funding failed: ${(err as Error).message}`);
    }
  }
  return primary;
}

// Diagnostics target the PRIMARY network (mainnet when configured, else testnet).
export async function ensureReady(): Promise<ProviderHandle> {
  return networks()[0]!.ensureReady();
}

export async function listProviders(): Promise<
  { provider: string; model: string; serviceType: string; verifiability: string; healthy: boolean; teeTarget: string }[]
> {
  return networks()[0]!.listProviders();
}

/**
 * The catalog of one specific network, or [] when it is not configured.
 *
 * A tier resolves its model against the network that actually serves it, and those catalogs
 * share no model names. Resolving a testnet-only tier against the mainnet catalog reports
 * "no match, falling back", which is nonsense — that tier never asks mainnet anything.
 */
export async function listProvidersOn(
  label: "mainnet" | "testnet",
): Promise<
  { provider: string; model: string; serviceType: string; verifiability: string; healthy: boolean; teeTarget: string }[]
> {
  const net = networks().find((n) => n.label === label);
  return net ? net.listProviders() : [];
}

// Log tier -> model routing for every configured network at startup.
export async function logTierRouting(tierModels: string[][]): Promise<void> {
  for (const n of networks()) await n.logTierRouting(tierModels);
}

export function brokerConfigured(): boolean {
  return networks().some((n) => n.configured());
}
