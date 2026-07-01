import { config } from "../config/index.js";
import { ensureReady, ensureLedger, listProviders } from "../compute/zgCompute.js";
import { callModel, computeMode } from "../compute/client.js";

// End-to-end check of the 0G Compute path. Run this once the deployer wallet
// holds a few 0G:  pnpm compute:check
//
// It funds the broker ledger, discovers a live provider, runs one inference,
// and prints the answer with its on-chain request id and TEE verdict. If this
// prints `verified: true`, the agents' brain is live on 0G.

async function main() {
  const mode = computeMode();
  console.log(`compute mode: ${mode}`);
  console.log(`rpc: ${config.chain.rpcUrl}  chainId: ${config.chain.chainId}`);

  if (mode === "0g-compute") {
    console.log("funding ledger (this submits an on-chain transaction)...");
    const bal = await ensureLedger();
    console.log(`ledger balance: ~${bal} 0G`);

    console.log("\nlive providers (pin one with COMPUTE_PINNED_PROVIDER):");
    try {
      for (const p of await listProviders()) {
        const attests = p.verifiability === "TeeML" && p.teeTarget ? "TEE ✓" : "no TEE";
        console.log(`  ${p.provider}  ${p.model || "?"}  [${p.serviceType}]  ${attests}  ${p.healthy ? "healthy" : "unhealthy"}`);
      }
    } catch (err) {
      console.log(`  (could not list providers: ${(err as Error).message})`);
    }

    console.log("\ndiscovering a provider...");
    const h = await ensureReady();
    console.log(`provider: ${h.provider}`);
    console.log(`endpoint: ${h.endpoint}`);
    console.log(`model:    ${h.model}`);
  }

  console.log("\nrunning one inference...");
  const res = await callModel({
    systemPrompt: "You are a precise solver. Answer with only the final result, no words.",
    userPrompt: "Compute: 17 + 25",
    maxTokens: 64,
    temperature: 0.2,
  });

  console.log("--- result ---");
  console.log(`source:   ${res.source}`);
  console.log(`provider: ${res.provider}`);
  console.log(`model:    ${res.model}`);
  console.log(`chatID:   ${res.chatID ?? "(none)"}`);
  console.log(`verified: ${res.verified}`);
  console.log(`latency:  ${res.latencyMs}ms`);
  console.log(`answer:   ${res.text}`);

  if (mode === "0g-compute" && res.verified === true) {
    console.log("\n0G Compute is live and the response verified on chain.");
  }
}

main().catch((err) => {
  console.error("compute check failed:", err);
  process.exit(1);
});
