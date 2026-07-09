import { parseFEN, applyMove, legalMoves, outcome, repetitionKey, capturedValue, START_FEN, type Position } from "../runners/chess/engine.js";
import { bestCandidates, adjudicate, engineForTier } from "../runners/chess/search.js";

// Does the chess Compute ladder actually exist?
//
// The claim the product makes is that buying 0G buys chess strength: a tier-5 agent should
// not lose to a tier-0 agent, and every rung should beat the ones below it. That claim was
// never measured, and the complaint that started this work was a level-5 apex losing to
// levels 0 through 3.
//
// This plays the tiers against each other with NO 0G calls. It cannot: a paced, paid call per
// ply would make a single 200-game run take days and cost real money. Instead it models the
// agent's 0G pick as the WORST thing that pick can reasonably be — a uniform random choice
// among the candidates the tier's engine was willing to offer. That is deliberately
// pessimistic (a real model picks better than a coin), so a ladder that survives here is a
// ladder that survives in a live contest. It also puts `slackCp` on trial, because slack is
// exactly what decides how bad a random pick is allowed to be.
//
//   npx tsx src/scripts/chessLadderCheck.ts
//   GAMES=20 TIERS=0,3,5 npx tsx src/scripts/chessLadderCheck.ts
//   PAIR=0,5 GAMES=40 npx tsx src/scripts/chessLadderCheck.ts    # one matchup, deeper sample
//
// Each pair plays GAMES games, colours swapped every other game so no result is an artefact
// of the first move. Same seed -> same games, so a change to the engine is measured against
// an identical opponent, not against noise.

const GAMES = Number(process.env.GAMES ?? "12");
const MAX_PLY = Number(process.env.MAX_PLY ?? "160");
const TIERS = (process.env.TIERS ?? "0,1,2,3,4,5").split(",").map(Number);
const PAIR = process.env.PAIR ? process.env.PAIR.split(",").map(Number) : null;
const ADJ_MARGIN = Number(process.env.ADJ_MARGIN ?? "100");

// A tiny deterministic PRNG (mulberry32). Reproducibility is the whole point: without it,
// "tier 5 improved" and "tier 5 got a luckier opening" are the same measurement.
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type GameResult = { winner: 0 | 1 | null; how: string; plies: number };

// One game. Seat 0 and seat 1 hold the two tiers; each move, the seat's engine produces its
// candidate list and the "agent" picks uniformly from it.
function playGame(tierWhite: number, tierBlack: number, rand: () => number): GameResult {
  let pos: Position = parseFEN(START_FEN);
  const seen = new Map<string, number>();
  let ply = 0;

  while (ply < MAX_PLY) {
    const key = repetitionKey(pos);
    const repeats = (seen.get(key) ?? 0) + 1;
    seen.set(key, repeats);
    const oc = outcome(pos, repeats);
    if (oc.over) {
      if (oc.result === "checkmate" && oc.winner) return { winner: oc.winner === "w" ? 0 : 1, how: "checkmate", plies: ply };
      return decideDrawn(pos, ply, true);
    }
    const tier = pos.turn === "w" ? tierWhite : tierBlack;
    const cands = bestCandidates(pos, tier);
    const pick = cands[Math.floor(rand() * cands.length)] ?? cands[0]!;
    const legal = legalMoves(pos).find((m) => m.from === pick.move.from && m.to === pick.move.to && (m.promo ?? "") === (pick.move.promo ?? ""));
    pos = applyMove(pos, legal ?? legalMoves(pos)[0]!);
    ply += 1;
  }
  return decideDrawn(pos, ply, false);
}

// The same tiebreak ladder the live game uses, so this harness measures the product, not an
// idealised version of it.
function decideDrawn(pos: Position, plies: number, drawnOnBoard: boolean): GameResult {
  const edge = drawnOnBoard ? 0 : adjudicate(pos);
  if (Math.abs(edge) >= ADJ_MARGIN) return { winner: edge > 0 ? 0 : 1, how: "adjudicated", plies };
  const caps = capturedValue(pos);
  if (caps.w !== caps.b) return { winner: caps.w > caps.b ? 0 : 1, how: "material", plies };
  return { winner: null, how: "even", plies };
}

function main() {
  const pairs: [number, number][] = [];
  if (PAIR) pairs.push([PAIR[0]!, PAIR[1]!]);
  else for (let i = 0; i < TIERS.length; i++) for (let j = i + 1; j < TIERS.length; j++) pairs.push([TIERS[i]!, TIERS[j]!]);

  console.log(`\nchess ladder: ${GAMES} games per pair, colours swapped, max ${MAX_PLY} ply, no 0G calls`);
  console.log(`the "agent" picks uniformly at random from its tier's candidate list (worst case)\n`);
  console.log(`  tier  depth  quiesce  checks  endgameKing  slackCp  cands`);
  for (const t of PAIR ?? TIERS) {
    const c = engineForTier(t);
    console.log(
      `  ${String(t).padStart(4)}  ${String(c.depth).padStart(5)}  ${String(c.quiesce).padStart(7)}  ` +
        `${String(c.extendChecks).padStart(6)}  ${String(c.endgameKing).padStart(11)}  ${String(c.slackCp).padStart(7)}  ${String(c.candidates).padStart(5)}`,
    );
  }

  console.log(`\n  matchup       low wins   high wins   even   mates   avg plies   verdict`);
  let taboo = 0;
  for (const [lo, hi] of pairs) {
    const t0 = Date.now();
    let loWins = 0;
    let hiWins = 0;
    let even = 0;
    let mates = 0;
    let plies = 0;
    for (let g = 0; g < GAMES; g++) {
      // Swap colours every other game. Seed by pair+game so a rerun reproduces exactly.
      const hiIsWhite = g % 2 === 0;
      const rand = rng(1000 * (lo * 6 + hi) + g);
      const r = playGame(hiIsWhite ? hi : lo, hiIsWhite ? lo : hi, rand);
      plies += r.plies;
      if (r.how === "checkmate") mates += 1;
      if (r.winner === null) even += 1;
      else {
        const winnerIsHigh = (r.winner === 0) === hiIsWhite;
        if (winnerIsHigh) hiWins += 1;
        else loWins += 1;
      }
    }
    // The taboo: a lower tier taking a game off a higher one.
    const broken = loWins > 0;
    if (broken) taboo += 1;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `  L${lo} vs L${hi}   ${String(loWins).padStart(8)}   ${String(hiWins).padStart(9)}   ${String(even).padStart(4)}   ` +
        `${String(mates).padStart(5)}   ${String(Math.round(plies / GAMES)).padStart(9)}   ` +
        `${broken ? `TABOO BROKEN (${secs}s)` : `holds (${secs}s)`}`,
    );
  }

  console.log(
    taboo === 0
      ? `\nEvery higher tier swept every lower one. The ladder holds under the worst-case pick.`
      : `\n${taboo} of ${pairs.length} matchups let the lower tier win at least one game.\n` +
          `Raise the higher tier's depth, or narrow its slackCp so a random pick cannot lose.`,
  );
}

main();
