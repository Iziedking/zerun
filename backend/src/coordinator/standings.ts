import { query } from "../db/pool.js";
import { broadcast, type StandingRow } from "./ws.js";

// The standings for a contest, ranked the way the contest actually settles, and
// carrying the kind's winning metric (chips for poker, P&L for World Cup, correct
// answers otherwise) so the UI can show the number that decides the winner rather
// than a placeholder. Shared by the HTTP endpoint and the live WS broadcaster.

export interface StandingResult {
  rank: number;
  agentId: number;
  agentName: string;
  operator: string;
  isHouse: boolean;
  correct: number;
  totalLatencyMs: number;
  computeLevel: number;
  passes: number;
  // The value the contest ranks on, and its label. For poker this is the live chip
  // stack; for World Cup the running prediction P&L; otherwise the correct count.
  score: number;
  metric: string;
}

function metricFor(kind: string): string {
  if (kind === "poker") return "chips";
  if (kind === "worldcup") return "P&L";
  return "correct";
}

export async function standingsFor(contestId: number): Promise<StandingResult[]> {
  const { rows: metaRows } = await query<{ kind: string | null }>(
    "select kind from contests_meta where contest_id = $1",
    [contestId],
  );
  const kind = metaRows[0]?.kind ?? "";
  const metric = metricFor(kind);

  // Platform (house) agents fill empty seats to keep a contest competitive, but they
  // never place: real operators always fill the ranks first, and every house agent
  // sorts below every real one no matter how many chips it won. So the primary sort is
  // is_house (real before house); within each group the settlement order applies.
  // Tiebreak must match settlement (runners/scoring.rankAgents): once settled, order
  // by the on-chain payout rank so the shown winner always matches who got paid (poker
  // ranks by chips, which correct/compute order cannot express). Before settlement,
  // rank by the live winning metric (contest_scores.score, e.g. chips/P&L) when present
  // and otherwise by correct answers, then higher Compute, then faster, then agent id.
  const { rows } = await query<{
    agent_id: string;
    operator: string;
    name: string | null;
    is_house: boolean;
    correct: string;
    total_latency: string;
    compute_level: string;
    passes: string;
    payout_rank: number | null;
    score: number | null;
  }>(
    `select e.agent_id, e.operator, m.name, coalesce(m.is_house, false) as is_house,
            coalesce(sum(case when s.verdict = 'correct' then 1 else 0 end), 0) as correct,
            coalesce(sum(s.latency_ms), 0) as total_latency,
            coalesce(m.compute_level, 0) as compute_level,
            coalesce(sum(s.samples), 0) as passes,
            min(p.rank) as payout_rank,
            max(cs.score) as score
       from contest_entries e
       left join agents_meta m on m.agent_id = e.agent_id
       left join solve_runs s on s.contest_id = e.contest_id and s.agent_id = e.agent_id
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
       left join contest_scores cs on cs.contest_id = e.contest_id and cs.agent_id = e.agent_id
      where e.contest_id = $1
      group by e.agent_id, e.operator, m.name, m.compute_level, m.is_house
      order by coalesce(m.is_house, false) asc,
               (min(p.rank) is null), min(p.rank) asc,
               coalesce(max(cs.score), sum(case when s.verdict = 'correct' then 1 else 0 end)) desc,
               coalesce(m.compute_level, 0) desc, total_latency asc, e.agent_id asc`,
    [contestId],
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    agentId: Number(r.agent_id),
    agentName: r.name ?? `Agent #${r.agent_id}`,
    operator: r.operator,
    isHouse: Boolean(r.is_house),
    correct: Number(r.correct),
    totalLatencyMs: Number(r.total_latency),
    computeLevel: Number(r.compute_level),
    passes: Number(r.passes),
    // A correct-answer kind has no contest_scores row; its score is the correct count.
    score: r.score != null ? Number(r.score) : Number(r.correct),
    metric,
  }));
}

// Upsert an agent's live winning metric as play advances (poker chips, World Cup P&L).
export async function recordScore(
  contestId: number,
  agentId: number,
  score: number,
  metric: string,
): Promise<void> {
  await query(
    `insert into contest_scores (contest_id, agent_id, score, metric, updated_at)
       values ($1, $2, $3, $4, now())
     on conflict (contest_id, agent_id) do update set
       score = excluded.score, metric = excluded.metric, updated_at = now()`,
    [contestId, agentId, score, metric],
  );
}

// Recompute and broadcast the live standings so the table reveals real data mid-play.
export async function broadcastStandings(contestId: number): Promise<void> {
  const st = await standingsFor(contestId);
  const rows: StandingRow[] = st.map((s) => ({
    agentId: s.agentId,
    agentName: s.agentName,
    operator: s.operator,
    correct: s.correct,
    totalLatencyMs: s.totalLatencyMs,
    rank: s.rank,
    computeLevel: s.computeLevel,
    passes: s.passes,
    score: s.score,
    metric: s.metric,
  }));
  broadcast({ type: "standings", contestId, payload: rows });
}
