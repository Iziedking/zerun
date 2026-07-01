import { ethers } from "ethers";
import { createRequire } from "node:module";
import { config } from "../config/index.js";

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
// Lifecycle, matching the 0G serving-broker SDK (0.6.2):
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
}

export interface ComputeAnswer {
  text: string;
  chatID: string | null;
  verified: boolean | null;
  provider: string;
  model: string;
  endpoint: string;
  latencyMs: number;
}

let brokerPromise: Promise<Broker> | null = null;
let handle: ProviderHandle | null = null;
let readyPromise: Promise<ProviderHandle> | null = null;

// Set up (acknowledge + fund + fetch metadata) is done once per provider and the
// handle cached, so tier-based routing can hold several providers ready at once
// without re-acknowledging on every call.
const handles = new Map<string, ProviderHandle>();
const setupPromises = new Map<string, Promise<ProviderHandle>>();

// The broker signs single-use headers per request, and those nonces collide if
// two requests overlap. Run the per-request work one at a time so concurrent
// agents queue instead of stepping on each other.
//
// Crucially, also pace the queue: the 0G provider rate-limits at 10 requests a
// minute, and a contest fires many calls, so without a minimum gap the later
// calls get a 429 and fall back to an unfair error verdict. Holding ~6.5s between
// call starts keeps the whole field under the limit, so every agent gets a real
// answer. Tunable with COMPUTE_MIN_INTERVAL_MS.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_CALL_INTERVAL_MS = Number(process.env.COMPUTE_MIN_INTERVAL_MS ?? "7000");
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

function getWallet(): ethers.Wallet {
  if (!config.signerKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not set; the 0G Compute broker needs a funded wallet");
  }
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  return new ethers.Wallet(config.signerKey, provider);
}

async function getBroker(): Promise<Broker> {
  if (!brokerPromise) {
    brokerPromise = createZGComputeNetworkBroker(getWallet());
  }
  return brokerPromise;
}

// Read the current ledger balance in 0G, or null if no ledger exists yet.
async function ledgerBalanceOg(broker: Broker): Promise<number | null> {
  try {
    const ledger = await broker.ledger.getLedger();
    // The ledger stores balances at 1e18. Be tolerant of the exact field name
    // across SDK minor versions.
    const raw =
      (ledger as { balance?: bigint; totalBalance?: bigint }).balance ??
      (ledger as { totalBalance?: bigint }).totalBalance ??
      0n;
    return Number(ethers.formatEther(raw));
  } catch {
    return null;
  }
}

// Make sure the broker ledger holds at least the configured amount of 0G.
export async function ensureLedger(): Promise<number> {
  const broker = await getBroker();
  const target = config.compute.ledgerOg;
  const current = await ledgerBalanceOg(broker);
  if (current === null) {
    await broker.ledger.addLedger(target);
    return target;
  }
  if (current < target) {
    await broker.ledger.depositFund(target - current);
    return target;
  }
  return current;
}

// The serving struct is an ethers tuple; read the fields we care about by index.
// [0] provider, [1] serviceType, [6] model, [7] verifiability, [8] additionalInfo, [10] healthy
function readService(s: unknown) {
  const t = s as unknown[];
  let teeTarget = "";
  try {
    teeTarget = JSON.parse(String(t[8] ?? "{}")).TargetTeeAddress ?? "";
  } catch {
    teeTarget = "";
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

// Pick the best chatbot provider. A higher score is a stronger proof story: a
// healthy provider whose responses carry a real TEE attestation verifies on
// chain, so the "Verified on 0G" badge lights up. When none is available we
// still fall back to a working provider so the agents keep thinking on 0G.
async function pickProvider(broker: Broker): Promise<string> {
  if (config.compute.pinnedProvider) return config.compute.pinnedProvider;

  const services = (await broker.inference.listService()).map(readService);
  if (!services.length) throw new Error("0G Compute returned no live providers");

  const chat = services.filter((s) => s.serviceType === "chatbot");
  const pool = chat.length ? chat : services;

  const score = (s: ReturnType<typeof readService>) =>
    (s.verifiability === "TeeML" ? 2 : 0) + (s.healthy ? 1 : 0) + (s.teeTarget ? 1 : 0);

  pool.sort((a, b) => score(b) - score(a));
  return pool[0]!.provider;
}

// Every live 0G Compute provider with its model, verifiability, health, and TEE
// target. Use it to see which providers can attest (TeeML + a teeTarget) so you can
// pin one with COMPUTE_PINNED_PROVIDER.
export async function listProviders(): Promise<
  { provider: string; model: string; serviceType: string; verifiability: string; healthy: boolean; teeTarget: string }[]
> {
  const broker = await getBroker();
  return (await broker.inference.listService()).map(readService);
}

// Bring one provider to a ready state (acknowledge signer, fund its sub-account,
// cache its metadata) and return its handle. Single-flight per provider, so
// concurrent calls that want the same provider share one setup.
async function getHandleFor(broker: Broker, provider: string): Promise<ProviderHandle> {
  const cached = handles.get(provider);
  if (cached) return cached;

  let p = setupPromises.get(provider);
  if (!p) {
    p = (async () => {
      // Accept the provider's TEE signer so its responses can be verified. This
      // is best effort: if it is already acknowledged, or the provider does not
      // require it, the inference still works, so a failure here must not stop us.
      try {
        await broker.inference.acknowledgeProviderSigner(provider);
      } catch (err) {
        console.warn(`acknowledgeProviderSigner skipped: ${(err as Error).message}`);
      }

      // Lock a small amount to the provider sub-account. Also best effort: the
      // broker funds the sub-account on demand during a request, so an explicit
      // transfer reverting here does not block inference.
      try {
        const locked = BigInt(config.compute.perProviderOg) * 10n ** 18n;
        await broker.ledger.transferFund(provider, "inference", locked);
      } catch (err) {
        console.warn(`transferFund skipped: ${(err as Error).message}`);
      }

      const { endpoint, model } = await broker.inference.getServiceMetadata(provider);
      const h: ProviderHandle = { provider, endpoint, model };
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

// Bring the broker to a ready state on the best available provider: ledger
// funded, a provider chosen and acknowledged, its sub-account funded, metadata
// cached. Idempotent and single-flight so concurrent agent calls share one setup.
export async function ensureReady(): Promise<ProviderHandle> {
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

// Resolve a handle for a tier's preferred models. Walks the preference list in
// order and takes the first model that a HEALTHY provider is currently serving,
// so a higher tier reaches its stronger (TEE-capable) model. If none of the
// preferred models has a healthy provider right now, it falls back to the default
// best provider, so routing can never stall an agent: the worst case is exactly
// today's behaviour.
export async function ensureReadyFor(preferredModels?: string[]): Promise<ProviderHandle> {
  if (!preferredModels || preferredModels.length === 0) return ensureReady();

  const broker = await getBroker();
  await ensureLedger();

  const services = (await broker.inference.listService()).map(readService);
  for (const want of preferredModels) {
    const match = services.find((s) => s.serviceType === "chatbot" && s.model === want && s.healthy);
    if (match) return getHandleFor(broker, match.provider);
  }

  // Nothing preferred is healthy — use the default best provider.
  return ensureReady();
}

// One paid, verifiable inference call on 0G Compute.
export async function computeChat(params: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  // Ordered model preference (a tier's ladder). The first one a healthy provider
  // serves is used; otherwise it falls back to the default best provider.
  models?: string[];
}): Promise<ComputeAnswer> {
  const h = await ensureReadyFor(params.models);
  const broker = await getBroker();

  const messages = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: params.userPrompt },
  ];

  // One request at a time. Latency is measured around the actual call, not the
  // time spent waiting in the queue, so the speed tiebreak stays fair.
  return serialize(async () => {
    const headers = await broker.inference.getRequestHeaders(h.provider, params.userPrompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.compute.callTimeoutMs);
    const t0 = Date.now();
    let data: { id?: string; choices?: Array<{ message?: { content?: string } }> };
    try {
      const res = await fetch(`${h.endpoint}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
        body: JSON.stringify({
          model: h.model,
          messages,
          max_tokens: params.maxTokens,
          temperature: params.temperature,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`0G provider responded ${res.status}: ${body.slice(0, 200)}`);
      }
      data = (await res.json()) as typeof data;
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - t0;

    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    const chatID = data.id ?? null;

    // Verify the TEE-signed response on chain. This is the proof the answer came
    // from the provider we paid, not a substitute.
    let verified: boolean | null = null;
    if (chatID) {
      try {
        verified = await broker.inference.processResponse(h.provider, chatID, text);
      } catch {
        verified = null;
      }
    }

    return {
      text,
      chatID,
      verified,
      provider: h.provider,
      model: h.model,
      endpoint: h.endpoint,
      latencyMs,
    };
  });
}

export function brokerConfigured(): boolean {
  return Boolean(config.signerKey);
}
