import { listProvidersOn, mainnetComputeEnabled, tierUsesMainnet } from "../compute/zgCompute.js";
import { computePlan, MAX_COMPUTE_LEVEL } from "../runners/computeLevels.js";
import { modelsMatch } from "../compute/modelMatch.js";

// Read-only: list live 0G Compute providers and show, per Compute level, which NETWORK
// serves it and which model it resolves to there. No ledger funding, no inference, no spend.
//
// Tier decides the network as well as the model: only the premium tiers reason on mainnet,
// so a level-0 house agent never spends real 0G. And the two catalogs share no model names,
// so a tier must be resolved against the catalog that actually answers it — resolving a
// testnet-only tier against mainnet would report a fallback that never happens.

type Svc = Awaited<ReturnType<typeof listProvidersOn>>[number];

function dump(label: string, providers: Svc[]) {
  console.log(`\n${label} providers (${providers.length}):`);
  for (const p of providers) {
    const tee = p.verifiability === "TeeML" ? "TeeML" : "-";
    console.log(
      `  ${(p.model || "?").padEnd(30)} [${p.serviceType}]  ${p.healthy ? "healthy " : "UNHEALTHY"}  ${tee}  ${p.provider}`,
    );
  }
}

function resolve(want: string[], healthy: Svc[]): string {
  const hit = want.find((w) => healthy.some((p) => modelsMatch(w, p.model)));
  return hit ? healthy.find((p) => modelsMatch(hit, p.model))!.model : "(default best / base fallback)";
}

async function main() {
  const [testnet, mainnet] = await Promise.all([listProvidersOn("testnet"), listProvidersOn("mainnet")]);
  dump("testnet", testnet);
  if (mainnetComputeEnabled()) dump("mainnet", mainnet);
  else console.log(`\nmainnet: not configured (every tier is testnet-only, nothing spends real 0G)`);

  const healthyOn = (list: Svc[]) => list.filter((p) => p.serviceType === "chatbot" && p.healthy);

  console.log(`\ntier -> network + resolved model (what an agent at each level would actually run):`);
  for (let l = 0; l <= MAX_COMPUTE_LEVEL; l++) {
    const want = computePlan(l).models ?? [];
    const onMainnet = tierUsesMainnet(l);
    // Resolve against the catalog that actually answers this tier.
    const resolved = resolve(want, healthyOn(onMainnet ? mainnet : testnet));
    const net = onMainnet ? "mainnet (testnet on failure)" : "testnet only";
    console.log(`  L${l}: ${net.padEnd(29)} -> ${resolved.padEnd(30)} [${want.join(" > ")}]`);
  }

  if (mainnetComputeEnabled()) {
    console.log(`\nOnly the premium tiers spend real 0G. Every tier below them stays on testnet.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("modelsList failed:", (e as Error).message);
    process.exit(1);
  });
