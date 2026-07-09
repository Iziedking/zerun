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
// `intel` is the Analyst research perk, gated to the top tiers so reaching level
// 4-5 unlocks real research power: low levels forecast blind, the top tiers pull
// and reason over real sources. Solver contests ignore it.
// 0G Compute model names, exactly as the providers advertise them via
// listService(). The top two tiers prefer a stronger, TEE-capable model; every
// tier lists the base model as its fallback so an unhealthy premium provider
// never leaves an agent unable to think.
// TESTNET catalog (chain 16602). Only qwen2.5-omni is healthy; the two premium models are
// flagged unhealthy yet usually still serve, which is why they stay listed.
const MODEL_BASE = "qwen/qwen2.5-omni-7b"; // levels 0-3
const MODEL_GEMMA = "google/gemma-3-27b-it"; // level 4 (TEE)
const MODEL_GPT_OSS = "openai/gpt-oss-20b"; // level 5 (TEE)

// MAINNET catalog (chain 16661). Entirely different names, so a tier that listed only the
// testnet models matched nothing on mainnet and every level collapsed onto the same
// "default best" provider — the Compute ladder silently flattening the moment mainnet led.
//
// Each tier therefore lists its MAINNET model first and its testnet model after. A name
// only matches on the network that serves it, so one list drives both, and the order means
// mainnet never has to fail through a testnet name to find its model.
//
// Chosen from the live catalog (all healthy, all attesting TeeML), by advertised output
// price per 1k tokens: flash ~0.0012, pro ~0.0150, max ~0.0175. Deliberately avoiding the
// `glm-*` names: the tolerant matcher does substring matching, so "glm-5" would also match
// "glm-5.1", "glm-5.2", and "GLM-5-FP8".
const MODEL_BASE_MAINNET = "deepseek-v4-flash"; // levels 0-3
const MODEL_PRO_MAINNET = "deepseek-v4-pro"; // level 4
const MODEL_MAX_MAINNET = "qwen3.7-max"; // level 5

// Higher tiers keep their bigger compute (more self-consistency passes and a
// bigger token budget) AND route to a stronger model, so the advantages compound:
// more 0G invested buys both more thinking and a better brain.
const BASE_MODELS = [MODEL_BASE_MAINNET, MODEL_BASE];

const LEVELS: InferencePlan[] = [
  { maxTokens: 280, temperature: 0.7, samples: 1, retries: 1, hint: "", intel: 0, models: BASE_MODELS },
  { maxTokens: 440, temperature: 0.65, samples: 3, retries: 1, hint: " Think step by step.", intel: 0, models: BASE_MODELS },
  { maxTokens: 620, temperature: 0.62, samples: 4, retries: 1, hint: " Think step by step, then check your answer.", intel: 0, models: BASE_MODELS },
  { maxTokens: 760, temperature: 0.6, samples: 5, retries: 1, hint: " Think step by step, then check your answer.", intel: 2, models: BASE_MODELS },
  { maxTokens: 900, temperature: 0.58, samples: 6, retries: 1, hint: " Reason step by step, then verify your answer before committing.", intel: 5, liveInsight: true, models: [MODEL_PRO_MAINNET, MODEL_GEMMA, ...BASE_MODELS] },
  { maxTokens: 1024, temperature: 0.58, samples: 7, retries: 1, hint: " Reason step by step, then verify your answer before committing.", intel: 8, liveInsight: true, models: [MODEL_MAX_MAINNET, MODEL_GPT_OSS, ...BASE_MODELS] },
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
