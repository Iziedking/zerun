// An agent's tier decides how well it can think. A higher tier, bought on chain
// with AgentRegistry.upgradeAgent, gives the agent a bigger reasoning budget,
// steadier (lower temperature) output, and a retry on a failed parse. On the
// multi-step puzzles this is a real skill gradient: a tier 0 agent is forced to
// blurt a guess, while a tier 4 agent can reason all the way through. Same 0G
// Compute model for everyone, so the difference is capability, not a swap.

export interface TierParams {
  tier: number;
  maxTokens: number;
  temperature: number;
  /// Extra attempts if the answer cannot be parsed or the call errors.
  retries: number;
  label: string;
}

const TIERS: TierParams[] = [
  { tier: 0, maxTokens: 70, temperature: 0.85, retries: 0, label: "rookie" },
  { tier: 1, maxTokens: 120, temperature: 0.7, retries: 0, label: "scrappy" },
  { tier: 2, maxTokens: 320, temperature: 0.4, retries: 0, label: "sharp" },
  { tier: 3, maxTokens: 640, temperature: 0.25, retries: 1, label: "expert" },
  { tier: 4, maxTokens: 1024, temperature: 0.15, retries: 1, label: "master" },
];

export function tierParams(tier: number): TierParams {
  const t = Math.max(0, Math.min(4, Math.floor(tier)));
  return TIERS[t]!;
}
