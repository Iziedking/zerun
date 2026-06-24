import type { InferencePlan } from "./traits.js";

// The single skill dial: Compute, bought with 0G. Every agent starts at level 0
// and is identical at claim. Each level adds a self-consistency pass and a bigger
// token budget, so the agent reasons harder on 0G and wins measurably more. 0G is
// scarce (the faucet gives ~0.5 a day and also pays gas), so leveling up is a
// real, competitive investment, not a free stat.

export const MAX_COMPUTE_LEVEL = 5;

// 0G to go from level i to level i+1 (index 0 = reach level 1). A ~2.5x climb:
// an easy on-ramp, then a real wall, then genuinely rare at the top.
export const COMPUTE_COSTS_OG = [0.8, 2, 5, 12, 30] as const;

// Each level's real 0G inference plan. The accuracy lever is self-consistency:
// take several independent reasoning attempts and keep the majority answer. That
// only works if the attempts are DIVERSE, so the temperature stays moderate at
// every level (cold sampling makes the passes identical and voting pointless).
// Training buys more passes and a bigger token budget, so a higher level votes
// across more diverse attempts and reliably out-scores the baseline. Level 0 is
// one hot single shot, where the house sits. Passes are 0G calls and the provider
// caps at 10/min, so the climb is deliberate.
const LEVELS: InferencePlan[] = [
  { maxTokens: 280, temperature: 0.7, samples: 1, retries: 1, hint: "" },
  { maxTokens: 440, temperature: 0.65, samples: 3, retries: 1, hint: " Think step by step." },
  { maxTokens: 620, temperature: 0.62, samples: 4, retries: 1, hint: " Think step by step, then check your answer." },
  { maxTokens: 760, temperature: 0.6, samples: 5, retries: 1, hint: " Think step by step, then check your answer." },
  { maxTokens: 900, temperature: 0.58, samples: 6, retries: 1, hint: " Reason step by step, then verify your answer before committing." },
  { maxTokens: 1024, temperature: 0.58, samples: 7, retries: 1, hint: " Reason step by step, then verify your answer before committing." },
];

export function computeLevelClamp(level: number): number {
  return Math.max(0, Math.min(MAX_COMPUTE_LEVEL, Math.floor(level || 0)));
}

// The inference plan for a compute level.
export function computePlan(level: number): InferencePlan {
  return LEVELS[computeLevelClamp(level)]!;
}

// 0G (in wei, 18 decimals) needed to reach the next level from `current`, or null
// at the cap.
export function nextLevelCostWei(current: number): bigint | null {
  const l = computeLevelClamp(current);
  if (l >= MAX_COMPUTE_LEVEL) return null;
  const og = COMPUTE_COSTS_OG[l]!;
  // 0G has 18 decimals; keep 6 decimals of precision in the cost.
  return BigInt(Math.round(og * 1_000_000)) * 1_000_000_000_000n;
}
