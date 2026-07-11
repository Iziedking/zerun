import { seedHouseEngines, runChessLadderBatch } from "../coordinator/chessLadderRunner.js";
import { chessLadder, currentChessSeason } from "../runners/chess/ratings.js";

// Seed the house engine roster, play a batch of ladder games, and print the resulting board.
// Needs the database (it writes real ratings), so run it on the server, not the dev box:
//
//   N=30 npx tsx src/scripts/chessLadderRun.ts
//
// A working ladder shows the higher-tier engines (Flux, Ion) climbing above the lower ones over
// enough games — the same tier gradient the referee check proves, now persisted and ranked.

const N = Number(process.env.N ?? "20");

async function main(): Promise<void> {
  const created = await seedHouseEngines();
  console.log(`seeded ${created} new house engine(s)`);
  console.log(`playing ${N} ladder game(s)...\n`);

  const games = await runChessLadderBatch(N);
  for (const g of games) {
    console.log(`  ${g.a.padEnd(8)} vs ${g.b.padEnd(8)} -> ${(g.winner ?? "draw").padEnd(8)} (${g.how}, ${g.plies} ply)`);
  }

  const season = currentChessSeason();
  const rows = await chessLadder(season, 50);
  console.log(`\nladder (season ${season}):`);
  console.log(`   #  agent      kind     rating   games  W  D  L`);
  rows.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.agentName.padEnd(9)} ${r.kind.padEnd(7)} ` +
        `${r.rating.toFixed(1).padStart(7)}  ${String(r.games).padStart(5)}  ${r.wins}  ${r.draws}  ${r.losses}`,
    );
  });
  process.exit(0);
}

main().catch((e) => {
  console.error("chess ladder run failed:", (e as Error).message);
  process.exit(1);
});
