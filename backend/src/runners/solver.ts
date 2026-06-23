import { callModel } from "../compute/client.js";
import type { ComputeSource } from "../compute/client.js";
import { extractAnswer, isCorrect, type Puzzle } from "./puzzles.js";
import { tierParams, type TierParams } from "./tierConfig.js";

// One agent solving one puzzle. The whole point of Zerun lives in callModel:
// the answer is produced by a paid, verifiable call on 0G Compute. Everything
// here is the thin shell around that one call.

export interface SolveOutcome {
  puzzleIdx: number;
  prompt: string;
  expected: string;
  answer: string | null;
  verdict: "correct" | "wrong" | "error";
  raw: string;
  source: ComputeSource;
  provider: string;
  model: string;
  chatID: string | null;
  verified: boolean | null;
  latencyMs: number;
}

const SYSTEM_PROMPT =
  "You are a competitor in a solving arena. Work through the problem step by step, " +
  "then end your reply with a line in exactly this form: ANSWER: <integer>. " +
  "Give a single whole number with no units or extra words after it.";

// Solve one puzzle at the agent's tier. The tier sets the reasoning budget and
// steadiness; a higher tier also gets a retry when the answer cannot be parsed,
// so it fails less often on the hard puzzles. The accumulated latency across all
// attempts is what the contest uses as the speed tiebreak.
export async function solvePuzzle(puzzle: Puzzle, tier: TierParams): Promise<SolveOutcome> {
  const attempts = tier.retries + 1;
  let latencyMs = 0;
  let last: Awaited<ReturnType<typeof callModel>> | null = null;
  let lastErr = "";

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await callModel({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: puzzle.prompt,
        maxTokens: tier.maxTokens,
        temperature: tier.temperature,
      });
      latencyMs += res.latencyMs;
      last = res;
      const answer = extractAnswer(res.text);
      if (answer !== null) {
        return outcome(puzzle, res, answer, isCorrect(answer, puzzle.expected) ? "correct" : "wrong", latencyMs);
      }
      // No number came back; spend a retry if the tier has one.
    } catch (err) {
      lastErr = (err as Error).message ?? "error";
    }
  }

  if (last) {
    // The model answered every time but never with a parseable number.
    return outcome(puzzle, last, null, "wrong", latencyMs);
  }
  return {
    puzzleIdx: puzzle.idx,
    prompt: puzzle.prompt,
    expected: puzzle.expected,
    answer: null,
    verdict: "error",
    raw: lastErr || "error",
    source: "offline-dev",
    provider: "error",
    model: "error",
    chatID: null,
    verified: null,
    latencyMs,
  };
}

function outcome(
  puzzle: Puzzle,
  res: Awaited<ReturnType<typeof callModel>>,
  answer: string | null,
  verdict: "correct" | "wrong" | "error",
  latencyMs: number,
): SolveOutcome {
  return {
    puzzleIdx: puzzle.idx,
    prompt: puzzle.prompt,
    expected: puzzle.expected,
    answer,
    verdict,
    raw: res.text,
    source: res.source,
    provider: res.provider,
    model: res.model,
    chatID: res.chatID,
    verified: res.verified,
    latencyMs,
  };
}
