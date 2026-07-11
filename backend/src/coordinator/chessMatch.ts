import {
  parseFEN,
  toFEN,
  applyMove,
  legalMoves,
  outcome,
  repetitionKey,
  capturedValue,
  moveToUci,
  START_FEN,
  type Position,
  type Move,
} from "../runners/chess/engine.js";
import { adjudicate } from "../runners/chess/search.js";
import type { Mover, MoveContext } from "../runners/chess/movers.js";

// The referee for a competition game. The engine is the umpire: it generates the legal moves,
// validates every move a player returns, and decides the result. A player is just a `Mover`, so
// the same referee runs house engine stand-ins today and sandboxed uploaded agents later with no
// change. Nothing here trusts the player: an illegal move, a crash, or a blown clock forfeits.
//
// Result rules (the ones the event promises):
//   - checkmate wins.
//   - a real draw (stalemate, insufficient material, fifty-move, threefold) is a draw.
//   - if the game runs out of ply ("time beats you"), the better position wins: neutral
//     adjudication first, then captured material, and only a dead-level game is a draw.

export type MatchWinner = "w" | "b" | null;

export type MatchHow =
  | "checkmate"
  | "adjudicated"
  | "material"
  | "draw"
  | "forfeit";

export interface MatchResult {
  winner: MatchWinner;
  how: MatchHow;
  /** Set only on a forfeit: the side that failed to produce a legal move in time. */
  forfeit?: "w" | "b";
  plies: number;
  finalFen: string;
}

export interface MatchOptions {
  maxPly?: number;
  /** Per-move wall-clock budget handed to each mover, and enforced as a backstop timeout. */
  moveBudgetMs?: number;
  /** Centipawn edge (white POV) needed for the adjudication tiebreak to name a winner. */
  adjMargin?: number;
  /** Seeded RNG for reproducibility; defaults to Math.random. */
  rand?: () => number;
  /** Called after each accepted move, for a live board feed. */
  onMove?: (info: { ply: number; mover: "w" | "b"; uci: string; fen: string }) => void;
}

const DEFAULT_MAX_PLY = Number(process.env.CHESS_LADDER_MAX_PLY ?? "160");
const DEFAULT_MOVE_MS = Number(process.env.CHESS_LADDER_MOVE_MS ?? "5000");
const DEFAULT_ADJ = Number(process.env.CHESS_ADJUDICATION_MARGIN ?? "100");

/** The legal move matching a UCI string, or null if it is illegal or unparseable. */
function matchUci(pos: Position, uci: string): Move | null {
  if (typeof uci !== "string") return null;
  const u = uci.trim().toLowerCase();
  for (const m of legalMoves(pos)) if (moveToUci(m) === u) return m;
  return null;
}

/** Resolve `p`, or reject once `ms` elapses. The backstop for a mover that hangs. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("move timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Decide a game that hit the ply cap without a natural end: position, then material, then draw. */
function decideOnClock(pos: Position, plies: number, adjMargin: number): MatchResult {
  const finalFen = toFEN(pos);
  const edge = adjudicate(pos); // centipawns, white POV
  if (Math.abs(edge) >= adjMargin) {
    return { winner: edge > 0 ? "w" : "b", how: "adjudicated", plies, finalFen };
  }
  const caps = capturedValue(pos);
  if (caps.w !== caps.b) {
    return { winner: caps.w > caps.b ? "w" : "b", how: "material", plies, finalFen };
  }
  return { winner: null, how: "draw", plies, finalFen };
}

export async function playRefereedGame(white: Mover, black: Mover, opts: MatchOptions = {}): Promise<MatchResult> {
  const maxPly = opts.maxPly ?? DEFAULT_MAX_PLY;
  const moveMs = opts.moveBudgetMs ?? DEFAULT_MOVE_MS;
  const adjMargin = opts.adjMargin ?? DEFAULT_ADJ;
  const rand = opts.rand ?? Math.random;

  let pos = parseFEN(START_FEN);
  const seen = new Map<string, number>();
  let ply = 0;

  while (ply < maxPly) {
    const key = repetitionKey(pos);
    const repeats = (seen.get(key) ?? 0) + 1;
    seen.set(key, repeats);

    const oc = outcome(pos, repeats);
    if (oc.over) {
      const finalFen = toFEN(pos);
      if (oc.result === "checkmate") {
        return { winner: oc.winner, how: "checkmate", plies: ply, finalFen };
      }
      // stalemate / insufficient / fifty-move / threefold: a genuine draw.
      return { winner: null, how: "draw", plies: ply, finalFen };
    }

    const side = pos.turn;
    const mover = side === "w" ? white : black;
    const ctx: MoveContext = { ply, deadlineMs: moveMs, rand };

    let uci: string;
    try {
      uci = await withTimeout(mover(pos, ctx), moveMs);
    } catch {
      // Crash or blown clock: the side to move forfeits.
      return { winner: side === "w" ? "b" : "w", how: "forfeit", forfeit: side, plies: ply, finalFen: toFEN(pos) };
    }

    const legal = matchUci(pos, uci);
    if (!legal) {
      // Illegal or unparseable move: forfeit.
      return { winner: side === "w" ? "b" : "w", how: "forfeit", forfeit: side, plies: ply, finalFen: toFEN(pos) };
    }

    pos = applyMove(pos, legal);
    ply += 1;
    opts.onMove?.({ ply, mover: side, uci, fen: toFEN(pos) });
  }

  return decideOnClock(pos, ply, adjMargin);
}
