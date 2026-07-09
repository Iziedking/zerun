import { legalMoves, applyMove, moveToUci, inCheck, type Position, type Move } from "./engine.js";

// The engine half of the Hybrid brain. A negamax alpha-beta search evaluates the
// position so the runner can hand an agent a short list of strong candidate moves with
// scores; the agent then reasons on 0G to pick among them. Search strength scales with the
// agent's tier, so a higher tier sees deeper tactics — the same "more 0G buys more
// thinking" ladder as the other kinds, expressed as chess strength.

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 1_000_000;

// Piece-square tables (white's view, a1..h8), centipawns. They reward development,
// central control, and sane king/pawn structure, so a shallow search still plays
// natural-looking chess rather than shuffling. Black mirrors vertically.
// prettier-ignore
const PST: Record<string, number[]> = {
  p: [ 0,0,0,0,0,0,0,0, 5,10,10,-20,-20,10,10,5, 5,-5,-10,0,0,-10,-5,5, 0,0,0,20,20,0,0,0,
       5,5,10,25,25,10,5,5, 10,10,20,30,30,20,10,10, 50,50,50,50,50,50,50,50, 0,0,0,0,0,0,0,0 ],
  n: [ -50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,5,5,0,-20,-40, -30,5,10,15,15,10,5,-30,
       -30,0,15,20,20,15,0,-30, -30,5,15,20,20,15,5,-30, -30,0,10,15,15,10,0,-30,
       -40,-20,0,0,0,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50 ],
  b: [ -20,-10,-10,-10,-10,-10,-10,-20, -10,5,0,0,0,0,5,-10, -10,10,10,10,10,10,10,-10,
       -10,0,10,10,10,10,0,-10, -10,5,5,10,10,5,5,-10, -10,0,5,10,10,5,0,-10,
       -10,0,0,0,0,0,0,-10, -20,-10,-10,-10,-10,-10,-10,-20 ],
  r: [ 0,0,0,5,5,0,0,0, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
       -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 5,10,10,10,10,10,10,5, 0,0,0,0,0,0,0,0 ],
  q: [ -20,-10,-10,-5,-5,-10,-10,-20, -10,0,5,0,0,0,0,-10, -10,5,5,5,5,5,0,-10, 0,0,5,5,5,5,0,-5,
       -5,0,5,5,5,5,0,-5, -10,0,5,5,5,5,0,-10, -10,0,0,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20 ],
  k: [ 20,30,10,0,0,10,30,20, 20,20,0,0,0,0,20,20, -10,-20,-20,-20,-20,-20,-20,-10,
       -20,-30,-30,-40,-40,-30,-30,-20, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
       -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30 ],
};

// The king's table above is a MIDDLEGAME table: it rewards hiding on the back rank behind
// pawns. In an endgame that is exactly wrong — the king is a strong piece and must march to
// the centre to escort pawns and drive the enemy king to the edge. An engine that keeps its
// king home in a king-and-pawn ending cannot convert a won position, which is precisely the
// phase where a high tier is supposed to grind a low tier down. Only the top tier gets this.
// prettier-ignore
const KING_ENDGAME: number[] = [
  -50,-30,-30,-30,-30,-30,-30,-50, -30,-30,0,0,0,0,-30,-30, -30,-10,20,30,30,20,-10,-30,
  -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30,
  -30,-20,-10,0,0,-10,-20,-30, -50,-40,-30,-20,-20,-30,-40,-50,
];

// Non-pawn material left on the board, in centipawns, both sides. Below this the position is
// an endgame and the king switches tables. (Roughly: both queens gone, or down to rook+minor.)
const ENDGAME_MATERIAL = 1300;

/**
 * Static evaluation in centipawns, from the side-to-move's point of view (positive = good
 * for the mover). Material plus piece-square placement.
 *
 * `endgameAware` swaps the king's table once the heavy pieces are off. It is a tier-5
 * privilege: the apex agent knows how to use its king, the low tiers do not.
 */
export function evaluate(p: Position, endgameAware = false): number {
  let white = 0;
  let heavy = 0;
  if (endgameAware) {
    for (let s = 0; s < 64; s++) {
      const piece = p.board[s]!;
      if (piece === "" || piece === "p" || piece === "P" || piece === "k" || piece === "K") continue;
      heavy += VALUE[piece.toLowerCase()]!;
    }
  }
  const endgame = endgameAware && heavy <= ENDGAME_MATERIAL;
  for (let s = 0; s < 64; s++) {
    const piece = p.board[s]!;
    if (piece === "") continue;
    const kind = piece.toLowerCase();
    const white_ = piece === piece.toUpperCase();
    const idx = white_ ? s : 63 - s;
    const table = endgame && kind === "k" ? KING_ENDGAME : PST[kind]!;
    const base = VALUE[kind]! + table[idx]!;
    white += white_ ? base : -base;
  }
  return p.turn === "w" ? white : -white;
}

/**
 * How each tier searches. This is the chess expression of the Compute ladder, and the four
 * dials compound, which is the point: a tier-5 agent is not "a tier-0 agent that looks one
 * ply further", it is a categorically better player.
 *
 *   depth        how far the main search looks.
 *   quiesce      keep searching captures past the horizon until the position is quiet.
 *                Without this, a search that stops mid-exchange counts the capture it just
 *                made and never sees the recapture — it hangs pieces at the horizon and
 *                calls it winning material. This single flag is worth more than a ply.
 *   extendChecks search one deeper whenever the side to move is in check, so a forcing line
 *                is followed to its end instead of being cut off inside a mating net.
 *   slackCp      how far from the engine's best a move may be and still be OFFERED to the
 *                agent as a candidate. The 0G pick is where a game is won or thrown: a wide
 *                list lets the model choose a genuinely bad move. Tier 5 is handed near-
 *                equivalent options and cannot ruin the position; tier 0 is handed rope.
 *   candidates   how many moves reach the prompt at all.
 *
 * Together these make it a taboo for a low tier to beat a high one: the low tier searches
 * shallower, blunders at the horizon, mishandles its king in the ending, and picks from a
 * list that contains real mistakes.
 */
export interface TierEngine {
  depth: number;
  quiesce: boolean;
  extendChecks: boolean;
  endgameKing: boolean;
  slackCp: number;
  candidates: number;
}

// Every rung must add a lever the rung below does not have, or the two are the same player.
// Measured, not guessed, and it took three tries. Tiers 1 and 2 first shared a depth with no
// quiescence, separated only by slack, and split 2-2-2. Giving tier 4 a third ply then collapsed
// it onto tier 3, and tier 3 took a game off it. Slack alone does not separate two engines.
//
// So tier 5's lever is a slack of ZERO: it is offered only moves the engine scores identically
// to its best. It still reasons on 0G over that choice — a real tie is a real judgment call —
// but it cannot be handed a move that loses material. Every tier below it can.
//
// Tier 2 sits at 260 rather than 200 for the same reason: one extra ply of depth was not enough
// to keep tier 3 clear of it, and widening the LOWER tier's rope is the safe correction. It
// leaves every rung above untouched, where narrowing tier 3 would have collapsed it toward 4.
//
// Depths are set by MEASURED cost per ply, not by ambition. A ply must finish inside the
// mainnet call interval (~1.5s) or the engine, not 0G, becomes what a chess game waits for.
// `legalMoves` replays every move onto a fresh board to test the king, so it dominates every
// node, and quiescence calls it once per capture node. Measured from an 8-ply opening:
//
//   tier 0 (d1)                   9 ms      tier 3 (d3+q)             1428 ms
//   tier 1 (d2)                 130 ms      tier 4 (d3+q+king)        ~1400 ms
//   tier 2 (d2+q)               139 ms      tier 5 (d3+q+king+chk)    1706 ms
//
// Note tier 2 costs LESS than a raw depth-3 search while playing far better: quiescence is the
// cheapest strength in the table, and a tighter slack window also prunes that tier's own root
// harder. The obvious table — depth 4 and 5 at the top — measured 43s and 133s per ply. It was
// never shippable, and the number nobody had measured was the reason it looked reasonable.
const TIERS: TierEngine[] = [
  { depth: 1, quiesce: false, extendChecks: false, endgameKing: false, slackCp: 400, candidates: 4 },
  { depth: 2, quiesce: false, extendChecks: false, endgameKing: false, slackCp: 300, candidates: 4 },
  { depth: 2, quiesce: true, extendChecks: false, endgameKing: false, slackCp: 260, candidates: 3 },
  { depth: 3, quiesce: true, extendChecks: false, endgameKing: false, slackCp: 120, candidates: 3 },
  { depth: 3, quiesce: true, extendChecks: true, endgameKing: true, slackCp: 60, candidates: 3 },
  { depth: 3, quiesce: true, extendChecks: true, endgameKing: true, slackCp: 0, candidates: 2 },
];

export function engineForTier(tier: number): TierEngine {
  return TIERS[Math.max(0, Math.min(5, Math.floor(tier || 0)))]!;
}

// Kept for callers that only want the number.
export function depthForTier(tier: number): number {
  return engineForTier(tier).depth;
}

// A capture, en-passant included (the target square is empty on an ep capture, so the
// board test alone would miss it), or a promotion. These are the forcing moves quiescence
// follows.
function isNoisy(p: Position, m: Move): boolean {
  return p.board[m.to] !== "" || !!m.promo || (p.ep >= 0 && m.to === p.ep && p.board[m.from]!.toLowerCase() === "p");
}

// Most-valuable-victim ordering, plus a promotion bonus. Trying the biggest capture first is
// what makes alpha-beta prune, so a given depth costs a fraction of its raw node count.
//
// Takes the move list rather than generating it. `legalMoves` plays every pseudo-legal move
// onto a fresh board to test the king, so it is by far the most expensive call in the engine
// and every node must make exactly one of them. Generating it here AND in a terminal check
// doubled the cost of the entire search.
function order(p: Position, moves: Move[], noisyOnly = false): Move[] {
  const out: { m: Move; score: number }[] = [];
  for (const m of moves) {
    if (noisyOnly && !isNoisy(p, m)) continue;
    const victim = p.board[m.to]!;
    out.push({ m, score: (victim === "" ? 0 : (VALUE[victim.toLowerCase()] ?? 0)) + (m.promo ? 800 : 0) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((x) => x.m);
}

/**
 * Quiescence: once the main search runs out of depth, keep resolving captures until the
 * position is quiet. The "stand pat" score is the option to stop here — a side is never
 * forced to capture, so it can always take the static eval instead. Delta pruning skips
 * captures that cannot possibly recover the gap to alpha.
 */
function quiesce(p: Position, alpha: number, beta: number, ply: number, endgameKing: boolean): number {
  // Stand pat first, before generating anything: a side is never FORCED to capture, so it can
  // always take the static score instead, and most quiescence nodes cut off right here without
  // ever paying for a move list.
  const standPat = evaluate(p, endgameKing);
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;
  // A capture chain is finite, but cap the recursion anyway so no board can stall a live game.
  if (ply > 24) return alpha;

  // No mate detection here. This search only ever plays captures, so "no captures left" is not
  // "no moves left" -- asking `outcome()` would run the full generator at every node to answer
  // a question quiescence does not need. The main search handles mate.
  for (const m of order(p, legalMoves(p), true)) {
    const victim = p.board[m.to]!;
    const gain = victim === "" ? 100 : VALUE[victim.toLowerCase()]!;
    if (!m.promo && standPat + gain + 200 < alpha) continue; // delta prune: cannot reach alpha
    const score = -quiesce(applyMove(p, m), -beta, -alpha, ply + 1, endgameKing);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(p: Position, depth: number, alpha: number, beta: number, ply: number, cfg: TierEngine): number {
  // One move list per node, reused for the terminal test, the check extension and the ordering.
  const moves = legalMoves(p);
  const checked = inCheck(p);
  if (moves.length === 0) {
    // No legal move: mated if in check, stalemate otherwise. A faster mate scores worse, so the
    // search prefers mating sooner and avoids being mated as long as possible. Draws are 0.
    return checked ? -MATE + ply : 0;
  }
  // Follow a forcing line to its end rather than cutting off inside a mating net.
  if (cfg.extendChecks && checked && ply < 16) depth += 1;

  if (depth <= 0) {
    return cfg.quiesce ? quiesce(p, alpha, beta, ply, cfg.endgameKing) : evaluate(p, cfg.endgameKing);
  }
  let best = -Infinity;
  for (const m of order(p, moves)) {
    const score = -negamax(applyMove(p, m), depth - 1, -beta, -alpha, ply + 1, cfg);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // cutoff
  }
  return best;
}

export interface Candidate {
  move: Move;
  uci: string;
  score: number; // centipawns, side-to-move POV; higher is better
}

/**
 * The moves this tier is allowed to consider, best first. The list is trimmed twice: to the
 * tier's count, and to the tier's `slackCp` window around the best score. The window is the
 * one that matters — it decides how much damage the agent's own pick can do. The best move is
 * always present, so the list is never empty.
 */
export function bestCandidates(p: Position, tier: number, kOverride?: number): Candidate[] {
  const cfg = engineForTier(tier);
  const k = Math.max(1, kOverride ?? cfg.candidates);
  const roots = order(p, legalMoves(p));

  // Search each root move with a window that starts just below "good enough to be offered".
  // A full (-inf, +inf) window at every root, which is what this used to do, throws away
  // alpha-beta exactly where it prunes hardest. We do not need an exact score for a move that
  // is already worse than `best - slackCp`: it will never be offered, so a fail-low upper
  // bound is all the information required, and it arrives many times faster.
  //
  // A pleasing consequence: the tighter a tier's slack, the harder its own search prunes. The
  // apex tier is both the strongest player and the cheapest to compute per ply.
  const scored: Candidate[] = [];
  let best = -Infinity;
  for (const move of roots) {
    const lo = best === -Infinity ? -Infinity : best - cfg.slackCp - 1;
    const score = -negamax(applyMove(p, move), cfg.depth - 1, -Infinity, -lo, 1, cfg);
    if (score > best) best = score;
    scored.push({ move, uci: moveToUci(move), score });
  }
  scored.sort((a, b) => b.score - a.score);
  const cut = scored[0]!.score - cfg.slackCp;
  const near = scored.filter((c) => c.score >= cut);
  return (near.length ? near : scored).slice(0, k);
}

/**
 * A neutral read of who actually stands better, used to adjudicate a game that ran out of
 * clock or died on the board. Deliberately independent of either player's tier: the same
 * depth, the same eval, for both. Returns centipawns from WHITE's point of view.
 */
const ADJUDICATION: TierEngine = { depth: 4, quiesce: true, extendChecks: false, endgameKing: true, slackCp: 0, candidates: 1 };
export function adjudicate(p: Position): number {
  const scoreForMover = negamax(p, ADJUDICATION.depth, -Infinity, Infinity, 0, ADJUDICATION);
  return p.turn === "w" ? scoreForMover : -scoreForMover;
}
