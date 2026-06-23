import { keccak256, toHex } from "viem";
import { tierParams } from "./tierConfig.js";

// Agent traits are the build that decides how an agent reasons. They are not
// cosmetic: each trait maps onto a real 0G Compute parameter, so the outcome is
// a measured function of the build, not a dice roll. Tier (bought on chain) is
// the compute budget; traits decide how that budget is spent.
//
//   Precision  -> lower temperature and a self-check, so fewer careless misses
//   Focus      -> more tokens and more self-consistency passes, so it cracks harder items
//   Speed      -> a concise bias and the latency tiebreak
//   Resilience -> retries and steadiness, so it fails to finish less often
export interface Traits {
  precision: number;
  focus: number;
  speed: number;
  resilience: number;
}

export const TRAIT_KEYS = ["precision", "focus", "speed", "resilience"] as const;
export const BASE_TRAIT_TOTAL = 200; // budget distributed across the four at birth
const TRAIT_FLOOR = 25; // no trait starts below this

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const clampF = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// A deterministic genome from the agent id. Every agent is born with a distinct
// build (so two agents rarely tie), but the total is fixed so no rookie is
// strictly dominant. Training later raises individual traits past this baseline.
export function rollTraits(agentId: number): Traits {
  const h = keccak256(toHex(`zerun:agent:${agentId}:genome`)).slice(2);
  const w = [0, 1, 2, 3].map((i) => parseInt(h.slice(i * 4, i * 4 + 4), 16) + 1);
  const sum = w[0]! + w[1]! + w[2]! + w[3]!;
  const spendable = BASE_TRAIT_TOTAL - TRAIT_FLOOR * 4;
  const t = w.map((wi) => TRAIT_FLOOR + (wi / sum) * spendable);
  return { precision: clamp(t[0]!), focus: clamp(t[1]!), speed: clamp(t[2]!), resilience: clamp(t[3]!) };
}

export interface InferencePlan {
  maxTokens: number;
  temperature: number;
  samples: number; // self-consistency passes; the majority answer wins
  retries: number; // extra attempts on an errored pass
  hint: string; // appended to the system prompt
}

// Self-consistency passes allowed by the compute budget (tier). Kept small so a
// contest does not blow the 0G ledger; traits can add one within this cap.
const TIER_SAMPLES = [1, 1, 2, 3, 3];

// Combine the compute budget (tier) with the build (traits) into the real 0G
// inference parameters used for every answer.
export function traitInferencePlan(traits: Traits, tier: number): InferencePlan {
  const tp = tierParams(tier);
  const ti = Math.max(0, Math.min(4, Math.floor(tier)));

  const maxTokens = Math.round(tp.maxTokens * (0.7 + traits.focus * 0.006)); // focus 0->0.7x, 100->1.3x
  const temperature = clampF(tp.temperature * (1.1 - traits.precision * 0.008), 0.05, 1.0); // precision lowers temp

  let samples =
    TIER_SAMPLES[ti]! + (traits.focus >= 50 ? 1 : 0) + (traits.focus >= 75 ? 1 : 0) - (traits.speed >= 85 ? 1 : 0);
  samples = Math.max(1, Math.min(5, samples));

  const retries = tp.retries + (traits.resilience >= 60 ? 1 : 0);

  const hint =
    traits.speed >= 70
      ? " Be direct and answer quickly."
      : traits.precision >= 70
        ? " Check your work before giving the final answer."
        : "";

  return { maxTokens, temperature, samples, retries, hint };
}
