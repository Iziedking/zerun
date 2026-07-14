import { query, closePool } from "../db/pool.js";
import { currentChessSeason } from "../runners/chess/ratings.js";

// Scrap the chess competition records so a public launch starts from an empty board.
//
// By default it clears every rating (games, wins, draws, losses, mu/sigma) for the CURRENT season,
// which zeroes the leaderboard while leaving the uploaded agents in place. Add PURGE_AGENTS=1 to
// also remove the uploaded agents themselves, so the board stays empty until real players upload
// after your announcement (recommended for a fresh public start; each rating row cascades away with
// its agent). Nothing is changed until you pass CONFIRM=wipe: without it you get a safe dry run.
//
//   # 1. see exactly what would be cleared (changes nothing):
//   npx tsx src/scripts/chessReset.ts
//
//   # 2a. zero the leaderboard for the current season, keep the uploaded agents:
//   CONFIRM=wipe npx tsx src/scripts/chessReset.ts
//
//   # 2b. full fresh start: also remove the uploaded agents (empty board until new uploads):
//   CONFIRM=wipe PURGE_AGENTS=1 npx tsx src/scripts/chessReset.ts
//
//   # optional: clear ratings across ALL seasons, not just the current one:
//   CONFIRM=wipe ALL_SEASONS=1 npx tsx src/scripts/chessReset.ts
//
// Tip: stop the ladder first (CHESS_LADDER=off, restart the backend) so no new games are played
// while you reset and announce, then turn it back on (CHESS_LADDER=on) when you go live.

const CONFIRM = process.env.CONFIRM === "wipe";
const PURGE_AGENTS = process.env.PURGE_AGENTS === "1";
const ALL_SEASONS = process.env.ALL_SEASONS === "1";

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? "0");
}

async function main(): Promise<void> {
  const season = currentChessSeason();
  const scope = ALL_SEASONS ? "all seasons" : `season ${season}`;

  const ratingRows = ALL_SEASONS
    ? await count("select count(*)::text as n from chess_ratings")
    : await count("select count(*)::text as n from chess_ratings where season = $1", [season]);
  const uploadAgents = await count(
    "select count(*)::text as n from chess_agents where kind = 'upload'",
  );

  console.log(`chess reset (${scope})`);
  console.log(`  rating rows to clear: ${ratingRows}`);
  if (PURGE_AGENTS) console.log(`  uploaded agents to remove: ${uploadAgents}`);

  if (!CONFIRM) {
    console.log("\nDRY RUN: nothing was changed. Re-run with CONFIRM=wipe to apply.");
    await closePool();
    process.exit(0);
  }

  if (ALL_SEASONS) await query("delete from chess_ratings");
  else await query("delete from chess_ratings where season = $1", [season]);
  console.log(`cleared ${ratingRows} rating row(s).`);

  if (PURGE_AGENTS) {
    // The FK is `on delete cascade`, so any remaining ratings for these agents (e.g. other seasons)
    // go with them. After this the board is empty until fresh entries arrive.
    await query("delete from chess_agents where kind = 'upload'");
    console.log(`removed ${uploadAgents} uploaded agent(s).`);
  }

  console.log("\nDone. The leaderboard is clear. Announce, and new uploads start fresh.");
  await closePool();
  process.exit(0);
}

main().catch((e) => {
  console.error("chess reset failed:", (e as Error).message);
  process.exit(1);
});
