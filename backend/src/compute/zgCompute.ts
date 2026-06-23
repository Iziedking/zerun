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

// The broker signs single-use headers per request, and those nonces collide if
// two requests overlap. Run the per-request work one at a time so concurrent
// agents queue instead of stepping on each other.
//
// Crucially, also pace the queue: the 0G provider rate-limits at roughly 30
// requests a minute, and a contest fires many calls (agents x items x
// self-consistency passes), so without a minimum gap the later calls get
// rejected and fall back to an unfair error verdict. Holding ~2.3s between call
// starts keeps the whole field under the limit, so every agent gets a real
// answer. Tunable with COMPUTE_MIN_INTERVAL_MS.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_CALL_INTERVAL_MS = Number(process.env.COMPUTE_MIN_INTERVAL_MS ?? "2300");
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

// Bring the broker to a ready state: ledger funded, a provider chosen and
// acknowledged, its sub-account funded, metadata cached. Idempotent and
// single-flight so concurrent agent calls share one setup.
export async function ensureReady(): Promise<ProviderHandle> {
  if (handle) return handle;
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const broker = await getBroker();
    await ensureLedger();

    const provider = await pickProvider(broker);

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
    handle = { provider, endpoint, model };
    return handle;
  })();

  try {
    return await readyPromise;
  } catch (err) {
    readyPromise = null;
    throw err;
  }
}

// One paid, verifiable inference call on 0G Compute.
export async function computeChat(params: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}): Promise<ComputeAnswer> {
  const h = await ensureReady();
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
