import { bestCandidates } from "./search.js";
import { CHESS_SYSTEM, buildChessPrompt, parseChessChoice } from "./decide.js";
import { callModel } from "../../compute/client.js";
import { computePlan } from "../computeLevels.js";
import type { Mover } from "./movers.js";
import type { Position } from "./engine.js";

// A model-driven HOUSE showcase agent for the chess ladder. The engine shortlists strong, already
// legal candidate moves; 0G Compute chooses among them. Because the choice is constrained to the
// shortlist, the model can only pick a good move, never blunder or play illegally. It escalates
// like every other house call (house-only, tiers 4-5), so different 0G models visibly play chess.
//
// This is the ONE place the chess ladder spends 0G on a house agent: the negamax house field
// (engineMover) makes no call at all. So it is bounded: a small daily call cap per agent, and the
// whole roster is gated behind CHESS_SHOWCASE. One call per move, and none when the engine's
// shortlist is a single forced move.

const CHESS_TOK = Number(process.env.CHESS_SHOWCASE_MAX_TOKENS ?? "64");
const DAILY_CALLS = Number(process.env.CHESS_SHOWCASE_DAILY_CALLS ?? "800");
// When the top two candidates are within this many centipawns, the choice is a genuine decision, so
// flag it hard and let the agent escalate to a pool model on it. A runaway-best move is not worth a
// premium call.
const HARD_MARGIN_CP = Number(process.env.CHESS_SHOWCASE_HARD_CP ?? "60");

// Per-agent daily 0G call budget (in-memory; resets on restart). Caps the mainnet bill a showcase
// agent can run up in a day. When spent, it plays the engine's top move for free.
const calls = new Map<number, { day: string; n: number }>();
function withinBudget(id: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const e = calls.get(id);
  if (!e || e.day !== day) {
    calls.set(id, { day, n: 0 });
    return true;
  }
  return e.n < DAILY_CALLS;
}
function noteCall(id: number): void {
  const e = calls.get(id);
  if (e) e.n += 1;
}

export function modelMover(agent: { id: number; tier: number }): Mover {
  const plan = computePlan(agent.tier);
  return async (pos: Position) => {
    const cands = bestCandidates(pos, agent.tier);
    if (cands.length === 0) return "";
    // A single candidate is forced, and a spent budget falls back to the engine's pick: no call.
    if (cands.length === 1 || !withinBudget(agent.id)) return cands[0]!.uci;

    const youAre = pos.turn === "w" ? "white" : "black";
    const hard = Math.abs(cands[0]!.score - cands[1]!.score) <= HARD_MARGIN_CP;
    noteCall(agent.id);
    try {
      const res = await callModel({
        systemPrompt: CHESS_SYSTEM,
        userPrompt: buildChessPrompt(pos, cands, youAre),
        maxTokens: CHESS_TOK,
        temperature: 0.4,
        models: plan.models,
        tier: agent.tier,
        escalate: { house: true, key: agent.id, hard },
      });
      // parseChessChoice always returns a legal candidate (the engine's top on a vague reply).
      return parseChessChoice(res.text ?? "", cands).pick.uci;
    } catch {
      return cands[0]!.uci;
    }
  };
}
