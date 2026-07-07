import { query } from "../db/pool.js";
import { openContest } from "./contestOps.js";
import { finalizeContest } from "./finalize.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { pokerLadder, currentPokerSeason } from "../runners/poker/ratings.js";

// P5 of the poker ladder: settle the season pot on-chain, reusing the standard contest +
// merkle payout path with NO contract change. It funds a pool, lists a short on-chain
// contest, and pays the top real-operator agents ranked by their season TrueSkill rating
// through the same settlement/claim flow every contest uses. House agents seed the ladder
// but cannot take a real payout, so only ranked real operators are paid. This is an
// admin-triggered season finale (season end is a human decision), not an automatic loop.

export interface SeasonSettleResult {
  ok: boolean;
  contestId?: number;
  season: string;
  paid: { operator: string; agentId: number; rank: number; rating: number }[];
  note?: string;
}

export async function settlePokerSeason(poolUsdc: number, topN = 3): Promise<SeasonSettleResult> {
  const season = currentPokerSeason();
  const rows = await pokerLadder(season, 200);
  // Only real operators (never house) with a minimum of games are eligible to be paid.
  const eligible = rows
    .filter((r) => !r.isHouse && r.operator && r.games >= 3)
    .slice(0, Math.max(1, Math.min(5, topN)));
  if (eligible.length === 0) {
    return { ok: false, season, paid: [], note: "no eligible real-operator agents on the ladder yet" };
  }

  // A short on-chain contest funded with the season pool; its winners are the top ranked
  // ladder operators. openContest lists and escrows the pool; finalizeContest posts the
  // merkle root and settles, and each winner claims by proof through the normal flow.
  const contestId = await openContest({
    prizePoolUsdc: poolUsdc,
    durationSecs: 60,
    topN: eligible.length,
    puzzleCount: 1,
    kind: "poker",
    maxOperators: 6,
  });
  // Mark it so the UI reads it as the season finale rather than a normal duel.
  await query("update contests_meta set metric = 'POKER-SEASON' where contest_id = $1", [contestId]).catch(() => {});

  // Encode the ladder order as the ranking score (higher = better) so computePayouts
  // splits the pool by finishing rank across the winners.
  const scores: AgentScore[] = eligible.map((r, i) => ({
    agentId: r.agentId,
    operator: r.operator!,
    correct: eligible.length - i,
    totalLatencyMs: 0,
    computeLevel: r.computeLevel,
  }));

  // finalizeContest waits out the (short) window then settles, so run it in the
  // background: the admin gets the finale contest id immediately, the winners' prizes
  // land a minute later and show up as claimable on their profiles.
  finalizeContest(contestId, rankAgents(scores)).catch((err) =>
    console.error(`poker season settle ${contestId} failed:`, (err as Error).message),
  );

  return {
    ok: true,
    contestId,
    season,
    paid: eligible.map((r, i) => ({ operator: r.operator!, agentId: r.agentId, rank: i + 1, rating: r.rating })),
  };
}
