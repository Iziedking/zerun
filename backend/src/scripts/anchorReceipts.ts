import { query, closePool } from "../db/pool.js";
import { receiptsConfigured, anchorAgentReceipts } from "../identity/receipts.js";

// Anchor verifiable inference receipts for every agent with un-anchored 0G-compute answers.
//
// Each agent's new inferences (rows in solve_runs) are Merkle-rooted into a batch, the batch is anchored
// on 0G Storage, and its root is recorded on the ERC-8004 ValidationRegistry keyed to the agent's
// identity. Run it on a schedule (e.g. hourly cron) or by hand after contests settle. Safe by default:
// a dry run that lists what it would anchor until CONFIRM=anchor.
//
//   # 1. see how many agents have un-anchored inferences (changes nothing):
//   npx tsx src/scripts/anchorReceipts.ts
//
//   # 2. anchor them (0G Storage upload + best-effort mainnet ValidationRegistry writes):
//   CONFIRM=anchor npx tsx src/scripts/anchorReceipts.ts
//
// Requires AGENT_IDENTITY=on and the IDENTITY_* wallet funded. STORAGE_MODE=on for the 0G Storage
// anchor (without it, batches still record their root and mark their runs).

const CONFIRM = process.env.CONFIRM === "anchor";

async function main(): Promise<void> {
  // Agents that have an identity and at least one un-anchored 0G-compute inference.
  const { rows } = await query<{ agent_id: string; n: string }>(
    `select m.agent_id, count(*)::text as n
       from solve_runs s
       join agents_meta m on m.agent_id = s.agent_id
      where s.source in ('0g-compute','0g-router') and s.receipt_root is null
        and m.identity_token_id is not null
      group by m.agent_id
      order by m.agent_id asc`,
  );

  console.log(`receipt anchoring: ${rows.length} agent(s) with un-anchored inferences.`);
  for (const r of rows) console.log(`  agent #${r.agent_id}: ${r.n} inference(s)`);

  if (!receiptsConfigured()) {
    console.log("\nReceipts are NOT configured. Set AGENT_IDENTITY=on and the IDENTITY_* wallet (funded).");
    await closePool();
    process.exit(rows.length === 0 ? 0 : 1);
  }
  if (!CONFIRM) {
    console.log("\nDRY RUN: nothing was anchored. Re-run with CONFIRM=anchor to apply.");
    await closePool();
    process.exit(0);
  }

  let anchored = 0;
  for (const r of rows) {
    const id = Number(r.agent_id);
    try {
      const res = await anchorAgentReceipts(id);
      if (res) {
        anchored++;
        console.log(
          `  agent #${id}: ${res.leafCount} receipts -> root ${res.merkleRoot}` +
            ` | storage ${res.storageRoot ?? "none"} | on-chain ${res.onChain ? "yes" : "no (owner-gated or failed)"}`,
        );
      }
    } catch (err) {
      console.error(`  FAILED agent #${id}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Anchored ${anchored}/${rows.length} agent batch(es).`);
  await closePool();
  process.exit(0);
}

main().catch((e) => {
  console.error("receipt anchoring failed:", (e as Error).message);
  process.exit(1);
});
