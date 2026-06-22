import { callModel } from "../compute/client.js";
import type { ComputeSource } from "../compute/client.js";
import { extractAnswer, isCorrect, type Puzzle } from "./puzzles.js";

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
  "You are a competitor in a solving arena. Read the problem, reason briefly, " +
  "then end your reply with the final answer as a single integer on its own line. " +
  "Do not add units or extra words after the number.";

export async function solvePuzzle(puzzle: Puzzle): Promise<SolveOutcome> {
  try {
    const res = await callModel({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: puzzle.prompt,
      maxTokens: 400,
      temperature: 0.2,
    });
    const answer = extractAnswer(res.text);
    const verdict = isCorrect(answer, puzzle.expected) ? "correct" : "wrong";
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
      latencyMs: res.latencyMs,
    };
  } catch (err) {
    return {
      puzzleIdx: puzzle.idx,
      prompt: puzzle.prompt,
      expected: puzzle.expected,
      answer: null,
      verdict: "error",
      raw: (err as Error).message ?? "error",
      source: "offline-dev",
      provider: "error",
      model: "error",
      chatID: null,
      verified: null,
      latencyMs: 0,
    };
  }
}
