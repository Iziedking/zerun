import { callModel } from "../compute/client.js";
import type { ComputeSource } from "../compute/client.js";
import { extractProbability, brier, type Market } from "./markets.js";
import type { TierParams } from "./tierConfig.js";

// One agent forecasting one resolved market. The agent reasons on 0G Compute and
// commits a probability that the market resolves Yes. We grade against the real
// outcome with a Brier score, so both being right and being well calibrated
// matter. The tier sets the reasoning budget, same as the Solver.

export interface PredictOutcome {
  marketIdx: number;
  question: string;
  winnerLabel: string;
  prediction: string; // human readable, e.g. "Yes 72%"
  probYes: number | null;
  brier: number; // 0 best, 1 worst
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
  "You are a forecaster in a prediction arena. Read the question, weigh the " +
  "evidence briefly, then end with a line in exactly this form: PROB: <0-100>, " +
  "the percent chance the answer is Yes. Give a single number from 0 to 100.";

function buildPrompt(market: Market): string {
  const ctx = market.description ? `\nContext: ${market.description}` : "";
  return `Question: ${market.question}${ctx}\nWhat is the percent chance this resolves "${market.outcomes[0]}"?`;
}

export async function predictMarket(market: Market, tier: TierParams): Promise<PredictOutcome> {
  const attempts = tier.retries + 1;
  let latencyMs = 0;
  let last: Awaited<ReturnType<typeof callModel>> | null = null;
  let lastErr = "";

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await callModel({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildPrompt(market),
        maxTokens: tier.maxTokens,
        temperature: tier.temperature,
      });
      latencyMs += res.latencyMs;
      last = res;
      const prob = extractProbability(res.text);
      if (prob !== null) {
        const predictedYes = prob >= 0.5;
        const correct = predictedYes === (market.winnerIndex === 0);
        return {
          marketIdx: market.idx,
          question: market.question,
          winnerLabel: market.winnerLabel,
          prediction: `${predictedYes ? market.outcomes[0] : market.outcomes[1]} ${Math.round(prob * 100)}%`,
          probYes: prob,
          brier: brier(prob, market.winnerIndex),
          verdict: correct ? "correct" : "wrong",
          raw: res.text,
          source: res.source,
          provider: res.provider,
          model: res.model,
          chatID: res.chatID,
          verified: res.verified,
          latencyMs,
        };
      }
    } catch (err) {
      lastErr = (err as Error).message ?? "error";
    }
  }

  // No parseable probability, or every attempt errored. Worst Brier either way.
  if (last) {
    return {
      marketIdx: market.idx,
      question: market.question,
      winnerLabel: market.winnerLabel,
      prediction: "no call",
      probYes: null,
      brier: 1,
      verdict: "wrong",
      raw: last.text,
      source: last.source,
      provider: last.provider,
      model: last.model,
      chatID: last.chatID,
      verified: last.verified,
      latencyMs,
    };
  }
  return {
    marketIdx: market.idx,
    question: market.question,
    winnerLabel: market.winnerLabel,
    prediction: "error",
    probYes: null,
    brier: 1,
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
