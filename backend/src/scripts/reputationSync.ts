import { query, closePool } from "../db/pool.js";
import { reputationConfigured } from "../identity/reputation.js";
import { postChessReputation } from "../runners/chess/submissions.js";
import { postArenaReputation } from "../identity/arenaAgents.js";

// Post each identity-bearing agent's CURRENT standing to the ERC-8004 ReputationRegistry on 0G mainnet.
//
// Claiming posts an agent's reputation once; run this to refresh it (a fresh feedback entry per agent),
// for example at a season close or on a schedule. Covers both chess uploads and arena agents that have
// an identity minted. Safe by default: a dry run that lists what it would post until CONFIRM=post.
//
//   # 1. see how many agents would get a reputation post (changes nothing):
//   npx tsx src/scripts/reputationSync.ts
//
//   # 2. post them (real 0G mainnet gas, one giveFeedback tx per agent):
//   CONFIRM=post npx tsx src/scripts/reputationSync.ts
//
//   # limit scope: KIND=chess or KIND=arena (default: both)
//
// Requires AGENT_IDENTITY=on and the identity wallet funded (same wallet posts feedback).

const CONFIRM = process.env.CONFIRM === "post";
const KIND = (process.env.KIND ?? "both").toLowerCase();

async function main(): Promise<void> {
  const doChess = KIND === "both" || KIND === "chess";
  const doArena = KIND === "both" || KIND === "arena";

  const chess = doChess
    ? (await query<{ id: string; identity_token_id: string }>(
        "select id, identity_token_id from chess_agents where kind = 'upload' and identity_token_id is not null order by id asc",
      )).rows
    : [];
  const arena = doArena
    ? (await query<{ agent_id: string; identity_token_id: string }>(
        "select agent_id, identity_token_id from agents_meta where identity_token_id is not null and coalesce(is_house,false) = false order by agent_id asc",
      )).rows
    : [];

  console.log(`reputation sync: ${chess.length} chess + ${arena.length} arena agent(s) with an identity.`);

  if (!reputationConfigured()) {
    console.log("\nReputation is NOT configured. Set AGENT_IDENTITY=on and the IDENTITY_* wallet (funded).");
    await closePool();
    process.exit(chess.length + arena.length === 0 ? 0 : 1);
  }
  if (!CONFIRM) {
    console.log("\nDRY RUN: nothing was posted. Re-run with CONFIRM=post to apply.");
    await closePool();
    process.exit(0);
  }

  let posted = 0;
  for (const r of chess) {
    try {
      await postChessReputation(Number(r.id), Number(r.identity_token_id));
      posted++;
      console.log(`  chess #${r.id} -> agentId ${r.identity_token_id}`);
    } catch (err) {
      console.error(`  FAILED chess #${r.id}: ${(err as Error).message}`);
    }
  }
  for (const r of arena) {
    try {
      await postArenaReputation(Number(r.agent_id), Number(r.identity_token_id));
      posted++;
      console.log(`  arena #${r.agent_id} -> agentId ${r.identity_token_id}`);
    } catch (err) {
      console.error(`  FAILED arena #${r.agent_id}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Posted ${posted}/${chess.length + arena.length} reputation update(s).`);
  await closePool();
  process.exit(0);
}

main().catch((e) => {
  console.error("reputation sync failed:", (e as Error).message);
  process.exit(1);
});
