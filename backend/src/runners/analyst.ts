import { callModel } from "../compute/client.js";
import type { ComputeSource } from "../compute/client.js";
import { extractProbability, brier, type Market } from "./markets.js";
import { gatherIntel } from "./intel.js";
import type { InferencePlan } from "./traits.js";

// One agent forecasting one resolved market. A high-Compute agent first researches
// the market (its `intel` budget pulls real sources via Exa), then reasons on 0G
// Compute across several passes and commits an averaged probability. An untrained
// agent forecasts blind from its prior. We grade against the real outcome, so the
// agent that researched and grounded its call beats the one that guessed.

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
  samples: number; // reasoning passes averaged
  sources: number; // research sources gathered before forecasting
}

const SYSTEM_PROMPT =
  "You are an analyst in a prediction-market arena. These markets have already " +
  "resolved; if research snippets are provided they describe what ACTUALLY " +
  "happened, so trust them over your own memory. Work in steps: (1) name the exact " +
  "thing the question asks for, the specific winner, party, person, number, or " +
  "event; (2) from the sources, state what actually occurred; (3) decide Yes only " +
  "if what occurred matches the question. A named person appearing in the sources " +
  "does NOT mean Yes, the sources may show they LOST or a DIFFERENT result, in " +
  "which case answer No. Do not default to Yes; many markets resolve No. Watch for " +
  "look-alikes (an earlier, unrelated event). If the sources do not settle it, stay " +
  "near 50. End with a line in exactly this form: PROB: <0-100>, the percent chance " +
  "it resolves Yes.";

// Stable per-question hash, so the research depth varies market to market but is
// the same on every reload (and across agents at the same level).
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function buildPrompt(market: Market, research: string): string {
  const ctx = research
    ? `\n\nResearch (recent sources):\n${research}\n`
    : market.description
      ? `\nContext: ${market.description.slice(0, 300)}`
      : "";
  return `Market: ${market.question}${ctx}\nFrom the sources, what actually happened, and does that make the market resolve "${market.outcomes[0]}"? Then give the percent chance it resolves "${market.outcomes[0]}".`;
}

export async function predictMarket(market: Market, plan: InferencePlan): Promise<PredictOutcome> {
  // Research first (a top-tier perk): pull real sources about the market so a
  // trained agent grounds its call instead of guessing. Untrained agents get none.
  // Search for the OUTCOME, not the bare question: "Will Kamala Harris be
  // inaugurated?" alone pulls her 2021 VP swearing-in; adding "actual result and
  // outcome" surfaces that Trump won and she was not.
  // The level sets the research ceiling; the actual depth varies per market within
  // a band below it, so the source count reads as organic, not a fixed number.
  // Level 5 (ceil 8) -> 5-8, level 4 (5) -> 3-5, level 3 (2) -> 1-2.
  const maxIntel = plan.intel ?? 0;
  const spread = Math.ceil(maxIntel / 3);
  const intelBudget = maxIntel > 0 ? maxIntel - (hashStr(market.question) % (spread + 1)) : 0;
  const query = `${market.question} actual result and outcome, what happened`;
  const sources = intelBudget > 0 ? await gatherIntel(query, intelBudget) : [];
  const research = sources
    .map((s, i) => `[${i + 1}] ${s.title}: ${s.text}`)
    .join("\n")
    .slice(0, 2400);

  // Then forecast across a few passes and average, capped so the Analyst stays
  // snappier than the Solver (research, not passes, is the Analyst's lever).
  const passes = Math.max(1, Math.min(plan.samples, 3));
  const probs: number[] = [];
  let latencyMs = 0;
  let last: Awaited<ReturnType<typeof callModel>> | null = null;
  let lastErr = "";

  for (let i = 0; i < passes; i++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await callModel({
          systemPrompt: SYSTEM_PROMPT + plan.hint,
          userPrompt: buildPrompt(market, research),
          maxTokens: plan.maxTokens,
          temperature: plan.temperature,
        });
        latencyMs += res.latencyMs;
        last = res;
        const p = extractProbability(res.text);
        if (p !== null) probs.push(p);
        break;
      } catch (err) {
        lastErr = (err as Error).message ?? "error";
        if (attempt === 0) await new Promise((r) => setTimeout(r, 350));
      }
    }
  }

  const base = {
    marketIdx: market.idx,
    question: market.question,
    winnerLabel: market.winnerLabel,
    latencyMs,
    samples: passes,
    sources: sources.length,
  };

  if (probs.length > 0 && last) {
    const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
    const predictedYes = avg >= 0.5;
    const correct = predictedYes === (market.winnerIndex === 0);
    return {
      ...base,
      prediction: `${predictedYes ? market.outcomes[0] : market.outcomes[1]} ${Math.round(avg * 100)}%`,
      probYes: avg,
      brier: brier(avg, market.winnerIndex),
      verdict: correct ? "correct" : "wrong",
      raw: last.text,
      source: last.source,
      provider: last.provider,
      model: last.model,
      chatID: last.chatID,
      verified: last.verified,
    };
  }

  if (last) {
    return {
      ...base,
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
    };
  }

  return {
    ...base,
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
  };
}
