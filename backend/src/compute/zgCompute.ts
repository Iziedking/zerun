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
//   2. ledger.addLedger(n) once, or ledger.depositFund(n) to top up
//   3. inference.listService() -> pick a provider
//   4. inference.acknowledgeProviderSigner(provider)  (accept its TEE signer)
//   5. ledger.transferFund(provider, "inference", lockedAmount)
//   6. inference.getServiceMetadata(provider) -> { endpoint, model }
//   7. per request: inference.getRequestHeaders(provider, content) -> headers
//   8. POST {endpoint}/chat/completions with those single-use headers
//   9. inference.processResponse(provider, id, answer) -> TEE verified boolean

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

// The broker signs single-use headers per request, and those nonces collide if two
// requests overlap. Run the per-request work one at a time so concurrent agents queue
// instead of stepping on each other. This queue is GLOBAL across both networks: it is
// deliberately conservative (a per-call mainnet->testnet fallback then queues once more),
// which is safe, and it keeps the 0G provider rate limit honoured. ~6.5s between call
// starts keeps a full field under the ~10 req/min cap. Tunable via COMPUTE_MIN_INTERVAL_MS.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_CALL_INTERVAL_MS = Number(process.env.COMPUTE_MIN_INTERVAL_MS ?? "7000");

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

let inflight: Promise<unknown> = Promise.resolve();
let lastCallStart = 0;
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const throttled = async (): Promise<T> => {
    const wait = lastCallStart + MIN_CALL_INTERVAL_MS - Date.now();
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
  ledgerOg: number;
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

  async function ledgerBalanceOg(broker: Broker): Promise<number | null> {
    try {
      const ledger = await withTimeout("getLedger", broker.ledger.getLedger());
      const raw =
        (ledger as { balance?: bigint; totalBalance?: bigint }).balance ??
        (ledger as { totalBalance?: bigint }).totalBalance ??
        0n;
      return Number(ethers.formatEther(raw));
    } catch {
      return null;
    }
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
        try {
          // parseEther, not BigInt(n) * 1e18: BigInt() throws on a fractional amount, and
          // that throw lands in the catch below as a mere "skipped" warning, leaving the
          // provider's sub-account unfunded so every request 402s. On mainnet the sane
          // amounts are fractions of a real 0G, so this has to accept 0.5.
          const locked = ethers.parseEther(String(net.perProviderOg));
          await walletWrite(() =>
            withTimeout("transferFund", broker.ledger.transferFund(provider, "inference", locked)),
          );
        } catch (err) {
          console.warn(`[${net.label}] transferFund skipped: ${(err as Error).message}`);
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
  rpcUrl: config.chain.rpcUrl,
  signerKey: config.signerKey,
  ledgerOg: config.compute.ledgerOg,
  perProviderOg: config.compute.perProviderOg,
  pinnedProvider: config.compute.pinnedProvider,
});

// Mainnet is active only when its RPC + a wallet key are set. It always leads, with the
// testnet network as the automatic per-call fallback.
const mainnetEnabled = Boolean(config.compute.mainnet.rpcUrl && config.compute.mainnet.signerKey);
const mainnetNetwork: Network | null = mainnetEnabled
  ? makeNetwork({
      label: "mainnet",
      rpcUrl: config.compute.mainnet.rpcUrl,
      signerKey: config.compute.mainnet.signerKey,
      ledgerOg: config.compute.mainnet.ledgerOg,
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

// The per-call network order, honouring the breaker: mainnet first unless it is tripped.
function callOrder(): Network[] {
  if (!mainnetNetwork) return [testnetNetwork];
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
}): Promise<ComputeAnswer> {
  const nets = callOrder();
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

// Log tier -> model routing for every configured network at startup.
export async function logTierRouting(tierModels: string[][]): Promise<void> {
  for (const n of networks()) await n.logTierRouting(tierModels);
}

export function brokerConfigured(): boolean {
  return networks().some((n) => n.configured());
}
