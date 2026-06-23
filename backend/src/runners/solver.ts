import { callModel } from "../compute/client.js";
import type { ComputeSource } from "../compute/client.js";
import { extractAnswer, isCorrect, type Puzzle } from "./puzzles.js";
import type { InferencePlan } from "./traits.js";

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
  /// How many self-consistency passes ran and how many backed the winning answer.
  samples: number;
  agreement: number;
}

const SYSTEM_PROMPT =
  "You are a competitor in a solving arena. Work through the problem step by step, " +
  "then end your reply with a line in exactly this form: ANSWER: <integer>. " +
  "Give a single whole number with no units or extra words after it.";

// 0G Compute calls occasionally drop a connection or hit the rate limit. A short
// backoff and retry turns most of those transient failures into real answers
// instead of error verdicts. The retry budget comes from the agent's Resilience.
async function callWithRetry(
  opts: Parameters<typeof callModel>[0],
  retries: number,
): Promise<Awaited<ReturnType<typeof callModel>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callModel(opts);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Solve one puzzle with self-consistency: run the agent's plan several times and
// take the majority answer. More passes (high Focus, higher tier) make the agent
// both more correct and more consistent, so better builds pull ahead instead of
// coin-flipping. The accumulated latency across every pass is the speed tiebreak.
export async function solvePuzzle(puzzle: Puzzle, plan: InferencePlan): Promise<SolveOutcome> {
  const votes = new Map<string, number>();
  const repByAnswer = new Map<string, Awaited<ReturnType<typeof callModel>>>();
  let latencyMs = 0;
  let anyRes: Awaited<ReturnType<typeof callModel>> | null = null;
  let lastErr = "";
  let errors = 0;
  const maxErrors = plan.retries + 1;

  for (let pass = 0; pass < plan.samples; pass++) {
    try {
      const res = await callWithRetry(
        {
          systemPrompt: SYSTEM_PROMPT + plan.hint,
          userPrompt: puzzle.prompt,
          maxTokens: plan.maxTokens,
          temperature: plan.temperature,
        },
        Math.max(1, plan.retries),
      );
      latencyMs += res.latencyMs;
      anyRes = res;
      const answer = extractAnswer(res.text);
      if (answer !== null) {
        votes.set(answer, (votes.get(answer) ?? 0) + 1);
        if (!repByAnswer.has(answer)) repByAnswer.set(answer, res);
      }
    } catch (err) {
      lastErr = (err as Error).message ?? "error";
      errors++;
      if (errors >= maxErrors && votes.size === 0) break;
    }
  }

  if (votes.size > 0) {
    let best = "";
    let bestN = -1;
    for (const [a, n] of votes) if (n > bestN) ((best = a), (bestN = n));
    const res = repByAnswer.get(best)!;
    const verdict = isCorrect(best, puzzle.expected) ? "correct" : "wrong";
    return outcome(puzzle, res, best, verdict, latencyMs, plan.samples, bestN);
  }

  if (anyRes) {
    // The model answered but never with a parseable number.
    return outcome(puzzle, anyRes, null, "wrong", latencyMs, plan.samples, 0);
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
    samples: plan.samples,
    agreement: 0,
  };
}

function outcome(
  puzzle: Puzzle,
  res: Awaited<ReturnType<typeof callModel>>,
  answer: string | null,
  verdict: "correct" | "wrong" | "error",
  latencyMs: number,
  samples: number,
  agreement: number,
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
    samples,
    agreement,
  };
}
