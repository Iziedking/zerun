import { fetchMarkets } from "../runners/markets.js";
import { predictMarket } from "../runners/analyst.js";
import { tierParams } from "../runners/tierConfig.js";

// Fetch a few resolved markets and have a tier 4 agent forecast each on 0G
// Compute, then grade against the real outcome.  pnpm tsx src/scripts/analystCheck.ts
async function main() {
  const markets = await fetchMarkets(4);
  console.log(`fetched ${markets.length} resolved markets\n`);
  const tier = tierParams(4);

  let correct = 0;
  let totalBrier = 0;
  for (const m of markets) {
    const r = await predictMarket(m, tier);
    if (r.verdict === "correct") correct++;
    totalBrier += r.brier;
    console.log(`Q: ${m.question.slice(0, 70)}`);
    console.log(`   actual=${m.winnerLabel}  agent=${r.prediction}  ${r.verdict}  brier=${r.brier.toFixed(3)}  via=${r.source}`);
  }
  console.log(`\n${correct}/${markets.length} correct, total Brier ${totalBrier.toFixed(3)}`);
}

main().catch((e) => {
  console.error("analyst check failed:", e);
  process.exit(1);
});
