import { legalMoves, applyMove, outcome, moveToUci, type Position, type Move } from "./engine.js";

// The engine half of the Hybrid brain. A negamax alpha-beta search evaluates the
// position so the runner can hand an agent a short list of strong candidate moves with
// scores; the agent then reasons on 0G to pick among them. Search depth scales with the
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

// Static evaluation in centipawns, from the side-to-move's point of view (positive =
// good for the mover). Material plus piece-square placement.
export function evaluate(p: Position): number {
  let white = 0;
  for (let s = 0; s < 64; s++) {
    const piece = p.board[s]!;
    if (piece === "") continue;
    const kind = piece.toLowerCase();
    const base = VALUE[kind]! + PST[kind]![piece === piece.toUpperCase() ? s : 63 - s]!;
    white += piece === piece.toUpperCase() ? base : -base;
  }
  return p.turn === "w" ? white : -white;
}

function negamax(p: Position, depth: number, alpha: number, beta: number, ply: number): number {
  const oc = outcome(p);
  if (oc.over) {
    // Side to move is mated -> very bad; a faster mate scores worse, so the search
    // prefers mating sooner and avoids being mated as long as possible. Draws are 0.
    if (oc.result === "checkmate") return -MATE + ply;
    return 0;
  }
  if (depth === 0) return evaluate(p);
  let best = -Infinity;
  for (const m of orderedMoves(p)) {
    const score = -negamax(applyMove(p, m), depth - 1, -beta, -alpha, ply + 1);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // cutoff
  }
  return best;
}

// Move ordering: try captures first (most-valuable victim), which makes alpha-beta prune
// far more, so a given depth is much cheaper.
function orderedMoves(p: Position): Move[] {
  return legalMoves(p)
    .map((m) => {
      const victim = p.board[m.to]!;
      const score = victim === "" ? 0 : (VALUE[victim.toLowerCase()] ?? 0) + (m.promo ? 800 : 0);
      return { m, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);
}

export interface Candidate {
  move: Move;
  uci: string;
  score: number; // centipawns, side-to-move POV; higher is better
}

// The top `k` moves by a depth-`depth` search, best first. This is the candidate list
// the agent reasons over on 0G. Deterministic: same position + depth -> same list.
export function bestCandidates(p: Position, depth: number, k = 4): Candidate[] {
  const scored = orderedMoves(p).map((move) => ({
    move,
    uci: moveToUci(move),
    score: -negamax(applyMove(p, move), Math.max(0, depth - 1), -Infinity, Infinity, 1),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}

// Search depth per compute tier. Kept shallow so a full 300s game stays responsive; the
// gradient still separates tiers (deeper sees more tactics), and the 0G pick adds on top.
const TIER_DEPTH = [1, 2, 2, 3, 3, 4];
export function depthForTier(tier: number): number {
  return TIER_DEPTH[Math.max(0, Math.min(5, Math.floor(tier)))]!;
}
