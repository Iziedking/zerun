import { config } from "../config/index.js";
import { ensureLedger } from "../compute/zgCompute.js";

// Top the 0G Compute ledger up to COMPUTE_LEDGER_OG. Run after the wallet has
// enough 0G:  pnpm ledger:fund
async function main() {
  console.log(`funding broker ledger to ~${config.compute.ledgerOg} 0G...`);
  const bal = await ensureLedger();
  console.log(`ledger balance: ~${bal} 0G`);
}

main().catch((err) => {
  console.error("ledger funding failed:", err);
  process.exit(1);
});
