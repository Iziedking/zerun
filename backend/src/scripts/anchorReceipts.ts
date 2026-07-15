import { query, closePool } from "../db/pool.js";
import { receiptsConfigured, anchorAgentReceipts, anchorChessAgentReceipts } from "../identity/receipts.js";

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
  const kind = (process.env.KIND ?? "both").toLowerCase();
  const doArena = kind === "both" || kind === "arena";
  const doChess = kind === "both" || kind === "chess";

  // Arena agents with an identity and at least one un-anchored 0G inference (solve_runs).
  const arena = doArena
    ? (await query<{ agent_id: string; n: string }>(
        `select m.agent_id, count(*)::text as n
           from solve_runs s join agents_meta m on m.agent_id = s.agent_id
          where s.source in ('0g-compute','0g-compute-router','0g-router') and s.receipt_root is null
            and m.identity_token_id is not null
          group by m.agent_id order by m.agent_id asc`,
      )).rows
    : [];
  // Chess agents with an identity and un-anchored call_model calls (chess_inferences).
  const chess = doChess
    ? (await query<{ agent_id: string; n: string }>(
        `select a.id as agent_id, count(*)::text as n
           from chess_inferences ci join chess_agents a on a.id = ci.agent_id
          where ci.receipt_root is null and a.identity_token_id is not null
          group by a.id order by a.id asc`,
      )).rows
    : [];

  console.log(`receipt anchoring: ${arena.length} arena + ${chess.length} chess agent(s) with un-anchored inferences.`);
  for (const r of arena) console.log(`  arena #${r.agent_id}: ${r.n} inference(s)`);
  for (const r of chess) console.log(`  chess #${r.agent_id}: ${r.n} inference(s)`);

  if (!receiptsConfigured()) {
    console.log("\nReceipts are NOT configured. Set AGENT_IDENTITY=on and the IDENTITY_* wallet (funded).");
    await closePool();
    process.exit(arena.length + chess.length === 0 ? 0 : 1);
  }
  if (!CONFIRM) {
    console.log("\nDRY RUN: nothing was anchored. Re-run with CONFIRM=anchor to apply.");
    await closePool();
    process.exit(0);
  }

  let anchored = 0;
  for (const r of arena) {
    const id = Number(r.agent_id);
    try {
      const res = await anchorAgentReceipts(id);
      if (res) {
        anchored++;
        console.log(`  arena #${id}: ${res.leafCount} receipts -> ${res.merkleRoot} | storage ${res.storageRoot ?? "none"} | on-chain ${res.onChain ? "yes" : "no"}`);
      }
    } catch (err) {
      console.error(`  FAILED arena #${id}: ${(err as Error).message}`);
    }
  }
  for (const r of chess) {
    const id = Number(r.agent_id);
    try {
      const res = await anchorChessAgentReceipts(id);
      if (res) {
        anchored++;
        console.log(`  chess #${id}: ${res.leafCount} receipts -> ${res.merkleRoot} | storage ${res.storageRoot ?? "none"} | on-chain ${res.onChain ? "yes" : "no"}`);
      }
    } catch (err) {
      console.error(`  FAILED chess #${id}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Anchored ${anchored}/${arena.length + chess.length} agent batch(es).`);
  await closePool();
  process.exit(0);
}

main().catch((e) => {
  console.error("receipt anchoring failed:", (e as Error).message);
  process.exit(1);
});
