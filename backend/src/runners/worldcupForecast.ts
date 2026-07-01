import { callModel } from "../compute/client.js";
import type { ComputeSource } from "../compute/client.js";
import { extractProbability } from "./markets.js";
import type { InferencePlan } from "./traits.js";
import type { WorldCupMarket } from "./worldcup.js";

// One agent forecasting one FUTURE World Cup event. Unlike the Analyst (which grades
// already-resolved markets), these events have not happened yet, so the prompt is
// forward looking and we only record the probability now; grading waits until the
// real event resolves on Polymarket. The research (the tiered x402 intel pack) is
// acquired by the runner and passed in, so this stays a pure forecast over 0G Compute.

export interface WcForecast {
  probYes: number | null;
  prediction: string; // human readable, e.g. "Spain 42%"
  raw: string;
  source: ComputeSource;
  provider: string;
  model: string;
  chatID: string | null;
  verified: boolean | null;
  latencyMs: number;
  samples: number;
  sources: number;
}

const SYSTEM_PROMPT =
  "You are a football analyst forecasting an UPCOMING 2026 FIFA World Cup event that " +
  "has NOT happened yet. Reason from team strength, recent form, the draw and path, " +
  "injuries, and what the research says the market and pundits expect. Do not claim " +
  "to know the result; estimate a calibrated probability. If the research does not " +
  "settle it, stay near a sensible prior, not 50 by reflex. End with a line in " +
  "exactly this form: PROB: <0-100>, the percent chance the event resolves Yes.";

function buildPrompt(market: WorldCupMarket, research: string): string {
  const ctx = research
    ? `\n\nResearch (recent sources):\n${research}\n`
    : market.description
      ? `\nContext: ${market.description.slice(0, 300)}`
      : "";
  const subject = market.groupTitle ? ` (subject: ${market.groupTitle})` : "";
  return `Upcoming World Cup event${subject}: ${market.question}${ctx}\nGive the percent chance it resolves Yes.`;
}

export async function forecastWorldCup(
  market: WorldCupMarket,
  plan: InferencePlan,
  research: string,
  sourcesCount: number,
): Promise<WcForecast> {
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
          models: plan.models,
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

  if (probs.length > 0 && last) {
    const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
    const label = market.groupTitle || (avg >= 0.5 ? "Yes" : "No");
    return {
      probYes: avg,
      prediction: `${label} ${Math.round(avg * 100)}%`,
      raw: last.text,
      source: last.source,
      provider: last.provider,
      model: last.model,
      chatID: last.chatID,
      verified: last.verified,
      latencyMs,
      samples: passes,
      sources: sourcesCount,
    };
  }

  return {
    probYes: null,
    prediction: last ? "no call" : "error",
    raw: last ? last.text : lastErr || "error",
    source: last ? last.source : "offline-dev",
    provider: last ? last.provider : "error",
    model: last ? last.model : "error",
    chatID: last ? last.chatID : null,
    verified: last ? last.verified : null,
    latencyMs,
    samples: passes,
    sources: sourcesCount,
  };
}
