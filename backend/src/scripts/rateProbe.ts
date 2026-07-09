import { createRequire } from "node:module";
import { ethers } from "ethers";
import "../config/index.js";

// What is a 0G provider's ACTUAL request rate limit?
//
// `COMPUTE_MIN_INTERVAL_MS` paces every call 7s apart, globally, to respect a limit nobody has
// measured. That single number is what bounds a chess game: one ply is one call, so a 300s
// match reaches ~43 plies and can never checkmate. If the provider tolerates 3s, chess gets
// 2.3x faster for free. If it does not, 7s is protecting us and we should stop guessing.
//
// This bypasses `computeChat` entirely — that would queue behind the serializer we are trying
// to measure — and calls the provider directly at a fixed cadence, counting failures and
// separating a rate limit (429, or a body that says so) from any other error.
//
//   PROBE_RPC=https://evmrpc-testnet.0g.ai PROBE_PROVIDER=0x... npx tsx src/scripts/rateProbe.ts
//
// Each call is a real, paid inference. Defaults to 10 calls per interval across five intervals
// = 50 calls. On testnet that is free-ish; on mainnet, know the price first.

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INTERVALS = (process.env.INTERVALS ?? "7000,5000,3000,2000,1000").split(",").map(Number);
const N = Number(process.env.N ?? "10");
// Time between call STARTS, matching how `serialize()` paces things.
const RECOVER_MS = Number(process.env.RECOVER_MS ?? "20000");

interface Outcome {
  ok: boolean;
  rateLimited: boolean;
  status: number;
  ms: number;
  detail: string;
}

function isRateLimit(status: number, body: string): boolean {
  if (status === 429) return true;
  return /rate.?limit|too many requests|quota|slow down/i.test(body);
}

async function main() {
  const rpc = process.env.PROBE_RPC ?? "https://evmrpc-testnet.0g.ai";
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, new ethers.JsonRpcProvider(rpc));
  const broker = await createZGComputeNetworkBroker(wallet);

  const services = (await broker.inference.listService()) as unknown as unknown[][];
  const chat = services.filter((s) => String(s[1]) === "chatbot" && s[10] === true);
  const provider = process.env.PROBE_PROVIDER ?? String(chat[0]?.[0] ?? "");
  if (!provider) throw new Error("no healthy chatbot provider found");

  const { endpoint, model } = await broker.inference.getServiceMetadata(provider);
  console.log(`\nrpc:      ${rpc}`);
  console.log(`provider: ${provider}`);
  console.log(`model:    ${model}`);
  console.log(`probing ${N} calls at each of ${INTERVALS.join(", ")}ms between call starts\n`);

  const call = async (i: number): Promise<Outcome> => {
    const t0 = Date.now();
    try {
      // Single-use headers, signed per request. Sequential by construction here, so the nonces
      // cannot collide the way concurrent calls would.
      const headers = await broker.inference.getRequestHeaders(provider, `ping ${i}`);
      const res = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: `What is ${i} plus 1? Answer with the number only.` }],
          max_tokens: 32,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.text();
      const ms = Date.now() - t0;
      if (!res.ok) {
        return { ok: false, rateLimited: isRateLimit(res.status, body), status: res.status, ms, detail: body.slice(0, 220) };
      }
      return { ok: true, rateLimited: false, status: res.status, ms, detail: "" };
    } catch (err) {
      return { ok: false, rateLimited: false, status: 0, ms: Date.now() - t0, detail: (err as Error).message.slice(0, 90) };
    }
  };

  // CROSS mode: is the 10/min budget per PROVIDER, or shared across the account?
  //
  // Our serialize() queue is global, so if the budget is per provider we are throttling the
  // whole app to one provider's allowance -- and a tournament, whose tiers route to different
  // models, is paying for that mistake with wall-clock. Burst provider A until it refuses, then
  // immediately call provider B. If B answers, the budget is per provider.
  const providerB = process.env.PROBE_PROVIDER_B;
  if (providerB) {
    const metaB = await broker.inference.getServiceMetadata(providerB);
    console.log(`second provider: ${providerB}  (${metaB.model})
`);

    let limitedAt = -1;
    for (let i = 0; i < 14 && limitedAt < 0; i++) {
      const o = await call(i);
      console.log(`  A #${i}: ${o.ok ? "ok" : o.rateLimited ? "RATE LIMITED" : "err " + o.status}  ${o.ms}ms`);
      if (o.rateLimited) limitedAt = i;
    }
    if (limitedAt < 0) {
      console.log(`
  provider A never rate-limited in 14 calls; inconclusive.`);
      return;
    }

    const t0 = Date.now();
    const headers = await broker.inference.getRequestHeaders(providerB, "cross");
    const res = await fetch(`${metaB.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(headers as unknown as Record<string, string>) },
      body: JSON.stringify({
        model: metaB.model,
        messages: [{ role: "user", content: "What is 2 plus 2? Answer with the number only." }],
        max_tokens: 32,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.text();
    const ok = res.ok;
    console.log(`
  B, immediately after A was limited: ${res.status} in ${Date.now() - t0}ms`);
    if (!ok) console.log(`     ${body.slice(0, 160)}`);
    console.log(
      ok
        ? `
  VERDICT: the 10/min budget is PER PROVIDER. A global queue throttles the whole app
` +
            `  to one provider's allowance; the queue should be keyed by provider.`
        : `
  VERDICT: the budget is shared across providers (per account). The global queue is right.`,
    );
    return;
  }

  console.log(`  interval   ok/total   rate-limited   other errors   median ms   effective req/min`);
  const notes: string[] = [];

  for (const interval of INTERVALS) {
    // Let any prior burst's window drain, so one interval cannot poison the next.
    await sleep(RECOVER_MS);

    const outs: Outcome[] = [];
    for (let i = 0; i < N; i++) {
      const started = Date.now();
      outs.push(await call(i));
      const wait = interval - (Date.now() - started);
      if (i < N - 1 && wait > 0) await sleep(wait);
    }

    const ok = outs.filter((o) => o.ok);
    const limited = outs.filter((o) => o.rateLimited);
    const other = outs.filter((o) => !o.ok && !o.rateLimited);
    const lat = ok.map((o) => o.ms).sort((a, b) => a - b);
    const med = lat.length ? lat[Math.floor(lat.length / 2)]! : 0;
    // A call takes max(interval, latency), so this is the real ceiling at this cadence.
    const perMin = Math.round(60000 / Math.max(interval, med || 1));

    console.log(
      `  ${String(interval + "ms").padStart(8)}   ${String(ok.length + "/" + N).padStart(8)}   ` +
        `${String(limited.length).padStart(12)}   ${String(other.length).padStart(12)}   ` +
        `${String(med).padStart(9)}   ${String(perMin).padStart(17)}`,
    );
    for (const o of other.slice(0, 1)) notes.push(`  ${interval}ms: non-rate-limit error, status ${o.status}: ${o.detail}`);
    for (const o of limited.slice(0, 1)) notes.push(`  ${interval}ms: RATE LIMITED, status ${o.status}: ${o.detail}`);
  }

  if (notes.length) {
    console.log(`\nsamples:`);
    for (const n of notes) console.log(n);
  }
  console.log(
    `\nThe fastest interval with 0 rate-limited calls is what COMPUTE_MIN_INTERVAL_MS can safely be.\n` +
      `Leave headroom: a live contest runs several agents through the same queue.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("rateProbe failed:", (e as Error).message);
    process.exit(1);
  });
