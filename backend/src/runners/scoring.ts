// Deterministic scoring and payout split. No randomness anywhere on the money
// path: the field is ranked purely by skill (correct answers), with total
// latency as the tiebreak, so the fastest accurate agent wins. Given the same
// inputs this always produces the same ranking and the same payouts, which is
// what lets the merkle root be reproduced and trusted.

export interface AgentScore {
  agentId: number;
  operator: string;
  correct: number;
  totalLatencyMs: number;
}

export interface RankedAgent extends AgentScore {
  rank: number;
}

export interface Payout {
  operator: string;
  amount: bigint; // USDC, 6 decimals
  rank: number;
}

export function rankAgents(scores: AgentScore[]): RankedAgent[] {
  const sorted = [...scores].sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    if (a.totalLatencyMs !== b.totalLatencyMs) return a.totalLatencyMs - b.totalLatencyMs;
    return a.agentId - b.agentId;
  });
  return sorted.map((s, i) => ({ ...s, rank: i + 1 }));
}

// Split `distributable` USDC among the top `topN` agents that scored at least
// one correct answer. Higher rank earns a larger share via linear decreasing
// weights. Any rounding dust goes to rank 1, so the amounts sum exactly to the
// distributable total (no funds stranded, none overspent).
export function computePayouts(
  ranked: RankedAgent[],
  distributable: bigint,
  topN: number,
): Payout[] {
  const eligible = ranked.filter((r) => r.correct > 0).slice(0, Math.max(1, topN));
  if (eligible.length === 0 || distributable <= 0n) return [];

  const n = eligible.length;
  // Weights n, n-1, ..., 1.
  const weights = eligible.map((_, i) => BigInt(n - i));
  const weightSum = weights.reduce((acc, w) => acc + w, 0n);

  const payouts: Payout[] = eligible.map((r, i) => ({
    operator: r.operator,
    amount: (distributable * weights[i]!) / weightSum,
    rank: r.rank,
  }));

  // Hand the remainder to rank 1 so the sum is exact.
  const paid = payouts.reduce((acc, p) => acc + p.amount, 0n);
  const dust = distributable - paid;
  if (dust > 0n && payouts[0]) payouts[0].amount += dust;

  return payouts;
}
