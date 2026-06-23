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

// Each level's real 0G inference plan. Level 0 is the weak baseline (one hot
// pass, high variance), where the house sits. Training adds self-consistency
// passes (the real accuracy lever: more passes vote down a wrong answer), a
// bigger token budget, and a steadier temperature, so a trained agent reliably
// out-scores the baseline. Passes are 0G calls and the provider caps at 10/min,
// so the climb is deliberate and the gradient stays clear.
const LEVELS: InferencePlan[] = [
  { maxTokens: 240, temperature: 0.5, samples: 1, retries: 1, hint: "" },
  { maxTokens: 420, temperature: 0.45, samples: 2, retries: 1, hint: " Check your work before the final answer." },
  { maxTokens: 600, temperature: 0.35, samples: 3, retries: 1, hint: " Check your work before the final answer." },
  { maxTokens: 760, temperature: 0.28, samples: 3, retries: 1, hint: " Check your work before the final answer." },
  { maxTokens: 900, temperature: 0.22, samples: 4, retries: 1, hint: " Reason step by step and verify before the final answer." },
  { maxTokens: 1024, temperature: 0.18, samples: 5, retries: 1, hint: " Reason step by step and verify before the final answer." },
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
