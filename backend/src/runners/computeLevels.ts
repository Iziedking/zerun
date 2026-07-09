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
// Chosen by MEASURING them (src/scripts/modelBakeoff.ts), not by reading the price list.
// Advertised price per token turned out to be the least useful number of the three:
//
//   model                          out/1k    solver answer   forecast answer   latency
//   deepseek-v4-flash              0.001240  3 chars         339 chars         3.0s
//   qwen/qwen3-vl-30b-a3b-instruct 0.000979  403 chars       1338 chars        6.3s
//
// qwen3-vl is nominally 21% cheaper per output token and 6x cheaper per input token, and it
// still costs several times more per answer, because it is a verbose reasoning model: it
// spends 400 characters deriving "252" where deepseek writes "252". Zerun's runners parse
// terse structured output — a number, a UCI move, a trailing `PROB:` — so verbosity is not
// merely expensive, it is a correctness risk: qwen3-vl's forecast ran to 1338 characters and
// only just fit inside the 440-token budget. At the 160-token budget it blew past the
// `PROB:` line entirely and the runner parsed a stray digit.
//
// Rejected, with reasons, so nobody re-adds them:
//   0GM-1.0-35B-A3B    returns an EMPTY answer every time; the call is billed and wasted.
//   openai/gpt-oss-20b cheapest in the catalog by far, but `fetch failed` — it really is down.
//   glm-*              the matcher does substring matching, so "glm-5" also swallows
//                      "glm-5.1", "glm-5.2", and "GLM-5-FP8".
//
// EVERY tier now reaches mainnet, so every tier lists a mainnet model first. Testnet's only
// healthy provider is rate-limited to 10 requests/min and answers in ~3.8s; mainnet took 45
// back-to-back calls at ~1.3s (src/scripts/rateProbe.ts). One 0G call is one chess ply, so
// testnet was the reason a duel could not reach checkmate. The testnet names stay listed
// behind the mainnet ones as the fallback, which is what they are now.
//
// The bill: a house agent now spends real 0G to think. At qwen3-vl's mainnet price a chess
// ply costs a small fraction of a cent, so a full tournament is cents, not dollars — but it
// is no longer free, and COMPUTE_MAINNET_MIN_TIER is the dial that takes it back.
//
// Both obvious premium candidates were MEASURED on mainnet and both failed:
//
//   deepseek-v4-pro  solver PASS 5.7s | chess EMPTY ANSWER | forecast EMPTY ANSWER
//   qwen3.7-max      solver PASS 10.9s | chess PASS 10.4s  | forecast ABORTED (>30s)
//
// `deepseek-v4-pro` returns an empty completion unless the budget is generous: it is a
// reasoning model whose hidden tokens eat the allowance, and chess grants only 48. And
// `qwen3.7-max` spends 10.4s per chess move, so against the 300s match cap a game reaches
// roughly 28 plies before the clock decides it, and its forecast overruns the 30s
// premium-attempt timeout.
//
// So the premium tiers lead with `deepseek-v4-flash`, the one mainnet model verified on all
// three task shapes: terse, correct, ~3s. It is a real gradient — a different model on a
// different network from the base tiers — just not the one we wanted. To do better, measure
// candidates with `models:bakeoff`; each new provider locks 2 0G of ledger (1 0G reserve +
// 1 0G fee headroom), so explore deliberately. Untried: openai/gpt-5.4-mini, MiniMax-M3, glm-5.2.
// The workhorse, and — measured, twice — the most RELIABLE model in the mainnet catalog, not
// merely the cheapest. On the run that finally reached mainnet (the router had been gated off
// by a missing COMPUTE_MAINNET_RPC_URL, so every earlier "mainnet" measurement was secretly
// testnet) it passed solver, chess and forecast; `deepseek-v4-flash` returned an EMPTY chess
// answer and a failed forecast in the same run, both billed before falling back to this.
//
// It is verbose — 374 characters to say "252" — which costs latency on the prose tasks (~8s
// solver, ~7s forecast) but not on chess, where the prompt constrains it to a UCI move and a
// short reason and it answers in ~1.6s.
const MODEL_BASE_MAINNET = "qwen/qwen3-vl-30b-a3b-instruct"; // levels 0-5, mainnet

// The premium lead. Kept ahead of the base model at levels 4-5 so the top tiers still route
// to a different brain, with qwen3-vl right behind it to catch the empty answers. Watch it:
// if the fallback rate stays high it is costing two calls to do one, and the top tiers should
// simply lead with qwen3-vl until a premium model is properly baked off. The untried healthy
// candidates are openai/gpt-5.4-mini, MiniMax-M3, qwen3.6-plus and glm-5.2 — each locks 1-2 0G
// of ledger for 24h the first time it is called, so evaluate them deliberately.
const MODEL_PRO_MAINNET = "deepseek-v4-flash"; // level 4  (was deepseek-v4-pro: empty answers)
const MODEL_MAX_MAINNET = "deepseek-v4-flash"; // level 5  (was qwen3.7-max: too slow for chess)

// Higher tiers keep their bigger compute (more self-consistency passes and a
// bigger token budget) AND route to a stronger model, so the advantages compound:
// more 0G invested buys both more thinking and a better brain.
// Mainnet first, testnet behind it: a name only matches on the network that serves it.
const BASE_MODELS = [MODEL_BASE_MAINNET, MODEL_BASE];

// `level` is filled in by computePlan, which is the only way a plan is ever handed out.
const LEVELS: Omit<InferencePlan, "level">[] = [
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

// The inference plan for a compute level. `level` rides along on the plan because it
// selects the network as well as the model: only the premium tiers reason on 0G mainnet.
export function computePlan(level: number): InferencePlan {
  const l = computeLevelClamp(level);
  return { ...LEVELS[l]!, level: l };
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
