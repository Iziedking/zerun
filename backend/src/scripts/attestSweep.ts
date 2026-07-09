import { createRequire } from "node:module";
import { ethers } from "ethers";
import "../config/index.js";

// Which providers actually serve a per-response TEE attestation?
//
// `verifiability: "TeeML"` in the service listing is NOT the answer. A provider that proxies
// to a centralized API (OpenRouter, OpenAI) still advertises TeeML — the TEE covers its
// gateway, not the inference — and returns 501 from the attestation endpoint. Only a
// provider that runs the model inside the enclave can sign a response, and `processResponse`
// only succeeds for those.
//
// HTTP only. No inference, no chain writes, no spend.
//
//   PROBE_RPC=https://evmrpc.0g.ai npx tsx src/scripts/attestSweep.ts

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

async function attestable(baseUrl: string, model: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/v1/proxy/attestation/report?model=${encodeURIComponent(model)}`, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const body = (await res.json()) as { signing_address?: string };
      return `ATTESTS  signer=${body.signing_address ?? "(none)"}`;
    }
    const body = await res.text();
    const reason = /centralized/i.test(body) ? "centralized proxy" : body.slice(0, 40).replace(/\s+/g, " ");
    return `no       ${res.status} ${reason}`;
  } catch (err) {
    return `no       ${(err as Error).name === "TimeoutError" ? "timeout" : "unreachable"}`;
  }
}

async function main() {
  const rpc = process.env.PROBE_RPC ?? "https://evmrpc.0g.ai";
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, new ethers.JsonRpcProvider(rpc));
  const broker = await createZGComputeNetworkBroker(wallet);

  const services = (await broker.inference.listService()) as unknown as unknown[][];
  const chat = services.filter((s) => String(s[1]) === "chatbot");

  console.log(`\nrpc: ${rpc}\n`);
  console.log("  model                        health     type         attestation");
  let attests = 0;
  for (const s of chat) {
    const model = String(s[6] ?? "?");
    const healthy = s[10] === true;
    let type = "?";
    try {
      type = String(JSON.parse(String(s[8] ?? "{}")).ProviderType ?? "?");
    } catch {
      /* leave unknown */
    }
    const verdict = await attestable(String(s[2]), model);
    if (verdict.startsWith("ATTESTS")) attests += 1;
    console.log(`  ${model.padEnd(28)} ${(healthy ? "healthy" : "UNHEALTHY").padEnd(10)} ${type.padEnd(12)} ${verdict}`);
  }

  console.log(`\nproviders that can sign a response: ${attests} of ${chat.length}`);
  console.log(
    attests === 0
      ? "-> processResponse can never return true on this network, so no answer is TEE-verified."
      : "-> route the tiers at these providers if a verified badge matters.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("attestSweep failed:", (e as Error).message);
    process.exit(1);
  });
