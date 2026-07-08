import { toFEN, type Position } from "./engine.js";
import type { Candidate } from "./search.js";

// The 0G half of the Hybrid brain. The engine hands the agent a shortlist of strong,
// already-legal candidate moves with evaluations; the agent reasons on 0G Compute and
// returns its pick. Because the choice is constrained to the candidate list, the move is
// always legal and reasonable — the "think on 0G" moment can never produce an illegal or
// blundering move, only choose among good ones.

export const CHESS_SYSTEM = [
  "You are the decision head of a chess agent.",
  "You are given the position and a short list of strong candidate moves, already legal,",
  "each with the engine's evaluation in pawns from your point of view (higher is better).",
  "Choose the single best move for your side.",
  "Reply with ONLY the move in UCI notation on the first line (for example e2e4, g1f3, or",
  "e7e8q for a promotion), then optionally a very short reason on the next line.",
].join(" ");

export function buildChessPrompt(p: Position, candidates: Candidate[], youAre: "white" | "black"): string {
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.uci}  (eval ${(c.score / 100).toFixed(2)})`)
    .join("\n");
  return [
    `You are playing ${youAre}.`,
    `Position (FEN): ${toFEN(p)}`,
    "",
    "Candidate moves, best-first by engine evaluation:",
    list,
    "",
    "Reply with the UCI of your chosen move on the first line.",
  ].join("\n");
}

// Parse the agent's reply into one of the candidate moves. Any UCI in the text that
// matches a candidate is taken; otherwise fall back to the engine's top candidate, so a
// vague or malformed answer still yields the best legal move rather than stalling.
export function parseChessChoice(text: string, candidates: Candidate[]): { pick: Candidate; matched: boolean } {
  const matches = text.toLowerCase().match(/[a-h][1-8][a-h][1-8][qrbn]?/g) ?? [];
  for (const uci of matches) {
    const hit = candidates.find((c) => c.uci === uci);
    if (hit) return { pick: hit, matched: true };
  }
  return { pick: candidates[0]!, matched: false };
}
