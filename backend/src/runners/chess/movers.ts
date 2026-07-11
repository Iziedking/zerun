import { bestCandidates } from "./search.js";
import type { Position } from "./engine.js";

// A mover is a side of a chess game: given a position, it returns a move in UCI (e2e4, e7e8q).
// It is deliberately the ONLY thing the referee needs from a player. A house stand-in wraps the
// tiered engine; an uploaded competition agent will wrap the sandbox, behind the exact same type,
// so the referee and the ladder never learn which kind they are running.

export interface MoveContext {
  /** Ply count so far (0 = first white move). */
  ply: number;
  /** Wall-clock budget for THIS move. A sandbox mover must return within it or forfeit. */
  deadlineMs: number;
  /** Referee-supplied RNG, so a game is reproducible from its seed. */
  rand: () => number;
}

// Returns a UCI string. It MAY be illegal, empty, or malformed: the referee validates every move
// and forfeits the game on a bad one, so a mover never has to guarantee legality itself.
export type Mover = (pos: Position, ctx: MoveContext) => Promise<string>;

/**
 * A house stand-in mover: the tier's engine produces its candidate shortlist and we pick uniformly
 * from it. This is the same worst-case model `chessLadderCheck` uses — a real 0G model picks better
 * than a coin flip — so a ladder that separates here separates in a live game. Higher tiers offer a
 * tighter, stronger shortlist (that is the whole point of `slackCp`), so the strength gradient is
 * real; the random pick gives game-to-game variety, so two stand-ins never replay one identical
 * game. No 0G call, so the ladder can self-play thousands of games for free while the sandbox and
 * public uploads are still being built.
 */
export function engineMover(tier: number): Mover {
  return async (pos, ctx) => {
    const cands = bestCandidates(pos, tier);
    const pick = cands[Math.floor(ctx.rand() * cands.length)] ?? cands[0]!;
    return pick.uci;
  };
}
