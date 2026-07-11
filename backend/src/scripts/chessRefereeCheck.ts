import { playRefereedGame } from "../coordinator/chessMatch.js";
import { engineMover } from "../runners/chess/movers.js";
import { engineForTier } from "../runners/chess/search.js";

// Does the competition referee (chessMatch + movers) reproduce the tier gradient?
//
// chessLadderCheck proves the gradient with its own inline game loop. This proves the SAME
// gradient survives the generalized referee that the ladder will actually run: two `Mover`s, a
// per-move clock, legality validation, forfeits, and the draw/adjudication result rules. If the
// premium band still holds here, the referee is faithful and an uploaded agent can be dropped in
// where the engine mover sits.
//
//   npx tsx src/scripts/chessRefereeCheck.ts
//   GAMES=8 PAIR=0,5 npx tsx src/scripts/chessRefereeCheck.ts

const GAMES = Number(process.env.GAMES ?? "10");
const MAX_PLY = Number(process.env.MAX_PLY ?? "160");
const TIERS = (process.env.TIERS ?? "0,2,3,5").split(",").map(Number);
const PAIR = process.env.PAIR ? process.env.PAIR.split(",").map(Number) : null;
const PREMIUM_TIER = Number(process.env.PREMIUM_TIER ?? "4");

// mulberry32: reproducible games, so a referee change is measured against identical opponents.
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const pairs: [number, number][] = [];
  if (PAIR) pairs.push([PAIR[0]!, PAIR[1]!]);
  else for (let i = 0; i < TIERS.length; i++) for (let j = i + 1; j < TIERS.length; j++) pairs.push([TIERS[i]!, TIERS[j]!]);

  console.log(`\nchess referee check: ${GAMES} games/pair through playRefereedGame, colours swapped, max ${MAX_PLY} ply\n`);
  console.log(`  matchup       low   high   draw   mates   forfeits   avg plies   high%   verdict`);

  let taboo = 0;
  for (const [lo, hi] of pairs) {
    let loWins = 0;
    let hiWins = 0;
    let draws = 0;
    let mates = 0;
    let forfeits = 0;
    let plies = 0;
    for (let g = 0; g < GAMES; g++) {
      const hiIsWhite = g % 2 === 0;
      const rand = rng(1000 * (lo * 6 + hi) + g);
      const white = engineMover(hiIsWhite ? hi : lo);
      const black = engineMover(hiIsWhite ? lo : hi);
      const r = await playRefereedGame(white, black, { maxPly: MAX_PLY, rand });
      plies += r.plies;
      if (r.how === "checkmate") mates += 1;
      if (r.how === "forfeit") forfeits += 1;
      if (r.winner === null) {
        draws += 1;
      } else {
        const winnerIsHigh = (r.winner === "w") === hiIsWhite;
        if (winnerIsHigh) hiWins += 1;
        else loWins += 1;
      }
    }
    const crossesBand = lo < PREMIUM_TIER && hi >= PREMIUM_TIER;
    const broken = crossesBand && loWins > 0;
    if (broken) taboo += 1;
    const decided = loWins + hiWins;
    const rate = decided ? Math.round((100 * hiWins) / decided) : 0;
    console.log(
      `  L${lo} vs L${hi}   ${String(loWins).padStart(3)}   ${String(hiWins).padStart(4)}   ${String(draws).padStart(4)}   ` +
        `${String(mates).padStart(5)}   ${String(forfeits).padStart(8)}   ${String(Math.round(plies / GAMES)).padStart(9)}   ` +
        `${String(rate + "%").padStart(5)}   ${broken ? "TABOO BROKEN" : crossesBand ? "clean" : "ok"}`,
    );
  }

  const band = pairs.filter(([lo, hi]) => lo < PREMIUM_TIER && hi >= PREMIUM_TIER).length;
  console.log(
    taboo === 0
      ? `\nReferee faithful: across ${band} free-vs-premium matchup${band === 1 ? "" : "s"}, no free tier won. Forfeits should be 0.\n`
      : `\nTABOO BROKEN in ${taboo} of ${band} matchups through the referee — investigate before trusting it.\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("referee check failed:", (e as Error).message);
    process.exit(1);
  });
