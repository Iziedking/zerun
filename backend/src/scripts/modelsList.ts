import { listProviders } from "../compute/zgCompute.js";
import { computePlan, MAX_COMPUTE_LEVEL } from "../runners/computeLevels.js";
import { modelsMatch } from "../compute/modelMatch.js";

// Read-only: list live 0G Compute providers and show which model each compute tier
// resolves to under the tolerant matcher. No ledger funding, no inference, no spend.
async function main() {
  const providers = await listProviders();
  console.log(`\nlive 0G providers (${providers.length}):`);
  for (const p of providers) {
    const tee = p.verifiability === "TeeML" && p.teeTarget ? "TEE" : "no-TEE";
    console.log(
      `  ${(p.model || "?").padEnd(28)} [${p.serviceType}]  ${p.healthy ? "healthy " : "UNHEALTHY"}  ${tee}  ${p.provider}`,
    );
  }
  const healthy = providers.filter((p) => p.serviceType === "chatbot" && p.healthy);
  console.log(`\ntier -> resolved model (what an agent at each level would actually run):`);
  for (let l = 0; l <= MAX_COMPUTE_LEVEL; l++) {
    const want = computePlan(l).models ?? [];
    const hit = want.find((w) => healthy.some((p) => modelsMatch(w, p.model)));
    const resolved = hit ? healthy.find((p) => modelsMatch(hit, p.model))!.model : "(default best / qwen fallback)";
    console.log(`  L${l}: [${want.join(" > ")}]  ->  ${resolved}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("modelsList failed:", (e as Error).message);
    process.exit(1);
  });
