import { query } from "../db/pool.js";
import {
  syncWorldCupMarkets,
  missionOutcomes,
  refreshMissionResolutions,
  tallyPnl,
  type Forecast,
} from "../runners/worldcup.js";
import { excludeHouseFor, scoringField } from "./runWorldCupContest.js";
import { finalizeContest, cancelContest } from "./finalize.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { broadcast } from "./ws.js";
import { recordScore, broadcastStandings } from "./standings.js";

// The World Cup deferred-settlement loop. World Cup missions do not settle when the
// join window closes; they park in `awaiting_resolution` while the real events play
// out. This loop polls Polymarket, and the moment every event in a mission has
// resolved it grades the stored forecasts against the real outcomes and settles the
// pool through the shared merkle payout path. Missions can wait here for days.

const POLL_MS = Number(process.env.WORLDCUP_RESOLVE_POLL_SECONDS ?? "300") * 1000;
// Grace past a mission's last event date before we stop waiting on stragglers. A
// postponed or voided Polymarket market would otherwise never resolve and park the
// mission forever, so once this passes we settle on the events that did resolve (or
// refund if none did).
const SETTLE_GRACE_MS = Number(process.env.WORLDCUP_SETTLE_GRACE_HOURS ?? "8") * 3600 * 1000;
// Absolute backstop: the longest a mission may sit awaiting after its join window
// closed, no matter what its markets' end dates say. This is what guarantees a mission
// never stays live indefinitely. It fires when the per-market grace above cannot —
// a mission whose markets have no readable end date (maxEndMs == 0), or one that drew
// far-future tournament futures instead of same-day games, or a market that UMA never
// resolves. Missions are day-scoped, so their games always end well within this, and
// this only bites the pathological cases. Past it we settle on whatever resolved, or
// refund if nothing did.
const MAX_AWAIT_MS = Number(process.env.WORLDCUP_MAX_AWAIT_HOURS ?? "20") * 3600 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Missions being graded right now, so overlapping polls do not double-settle.
const grading = new Set<number>();

// The latest event date across a mission's markets, in ms (0 if unknown). Used to
// decide when to stop waiting on unresolved stragglers.
async function missionMaxEndMs(contestId: number): Promise<number> {
  const { rows } = await query<{ max_end: string | null }>(
    `select max(extract(epoch from wm.end_date))::bigint as max_end
       from worldcup_mission_markets mm
       join worldcup_markets wm on wm.condition_id = mm.condition_id
      where mm.contest_id = $1`,
    [contestId],
  );
  const secs = rows[0]?.max_end ? Number(rows[0].max_end) : 0;
  return secs * 1000;
}

async function awaitingMissionIds(): Promise<number[]> {
  const { rows } = await query<{ contest_id: string }>(
    "select contest_id from contests_meta where status = 'awaiting_resolution'",
  );
  return rows.map((r) => Number(r.contest_id));
}

// When the mission started waiting: its join-window close, or its creation time as a
// fallback. The absolute age backstop is measured from here, so a mission cannot sit
// awaiting forever even if its markets have no usable end date.
async function missionAnchorMs(contestId: number): Promise<number> {
  const { rows } = await query<{ anchor: string | null }>(
    "select extract(epoch from coalesce(ends_at, created_at))::bigint as anchor from contests_meta where contest_id = $1",
    [contestId],
  );
  const secs = rows[0]?.anchor ? Number(rows[0].anchor) : 0;
  return secs * 1000;
}

async function readForecasts(contestId: number): Promise<Forecast[]> {
  const { rows } = await query<{ agent_id: string; market_idx: number; prob_yes: number | null; latency_ms: number }>(
    "select agent_id, market_idx, prob_yes, latency_ms from worldcup_forecasts where contest_id = $1",
    [contestId],
  );
  return rows.map((r) => ({
    agentId: Number(r.agent_id),
    marketIdx: r.market_idx,
    probYes: r.prob_yes,
    latencyMs: r.latency_ms,
  }));
}

// Record each agent's running prediction P&L from the markets that have resolved so
// far, and push it to the standings, so the World Cup table reveals real P&L accruing
// through the day rather than a placeholder until the very end. Markets not yet
// resolved contribute nothing (tallyPnl skips them).
async function recordLivePnl(
  contestId: number,
  outcomes: Awaited<ReturnType<typeof missionOutcomes>>,
): Promise<void> {
  const forecasts = await readForecasts(contestId);
  const pnl = tallyPnl(
    forecasts,
    outcomes.map((o) => ({ marketIdx: o.marketIdx, price: o.price })),
    outcomes.map((o) => ({ marketIdx: o.marketIdx, winnerIndex: o.winnerIndex })),
  );
  for (const [agentId, rec] of pnl) {
    await recordScore(contestId, agentId, rec.pnl, "P&L");
  }
  await broadcastStandings(contestId).catch(() => {});
}

async function gradeAndSettle(contestId: number): Promise<void> {
  const outcomes = await missionOutcomes(contestId);
  const forecasts = await readForecasts(contestId);
  const pnl = tallyPnl(
    forecasts,
    outcomes.map((o) => ({ marketIdx: o.marketIdx, price: o.price })),
    outcomes.map((o) => ({ marketIdx: o.marketIdx, winnerIndex: o.winnerIndex })),
  );

  const excludeHouse = await excludeHouseFor(contestId);
  const field = await scoringField(contestId);
  const scores: AgentScore[] = [];
  for (const f of field) {
    if (f.isHouse && excludeHouse) continue;
    const rec = pnl.get(f.agentId) ?? { pnl: 0, totalLatencyMs: 0 };
    // Only agents that beat the market (positive P&L) are eligible to win. The pool
    // splits by rank, so encode the P&L as the ranking score; order is what matters. If
    // no one beats the market, no scores are added and finalizeContest refunds.
    if (rec.pnl <= 0) continue;
    scores.push({
      agentId: f.agentId,
      operator: f.operator,
      correct: Math.max(1, Math.round(rec.pnl * 1_000_000)),
      totalLatencyMs: rec.totalLatencyMs,
      computeLevel: f.level,
    });
  }

  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: "World Cup events resolved; scoring on prediction-market P&L" },
  });
  await finalizeContest(contestId, rankAgents(scores));
}

// One pass over every awaiting mission: refresh resolutions, and settle any whose
// events have all resolved.
export async function resolveAwaitingMissions(): Promise<void> {
  // Keep the market pool warm every tick, regardless of awaiting missions. This both
  // refreshes resolutions and, crucially, populates the pool so the very first mission
  // has markets to draw (otherwise missions cancel for lack of markets before any can
  // reach the awaiting state, a deadlock).
  await syncWorldCupMarkets().catch(() => {});

  const ids = await awaitingMissionIds();
  if (ids.length === 0) return;

  for (const contestId of ids) {
    if (grading.has(contestId)) continue;
    let outcomes = await missionOutcomes(contestId);

    // Targeted fallback for any market not yet marked resolved (covers a market whose
    // parent event has fully closed, which the event-level sync would miss).
    const pending = outcomes.filter((o) => !o.resolved).map((o) => o.conditionId);
    if (pending.length > 0) {
      await refreshMissionResolutions(pending).catch(() => {});
      outcomes = await missionOutcomes(contestId);
    }

    // Reveal the running P&L from whatever has resolved so far, live each tick.
    await recordLivePnl(contestId, outcomes).catch(() => {});

    const resolvedCount = outcomes.filter((o) => o.resolved).length;
    const done = outcomes.length > 0 && resolvedCount === outcomes.length;

    if (!done) {
      // Force a terminal state when EITHER (a) all the mission's games have ended and
      // the per-market grace has passed (a postponed or voided market that will never
      // resolve), OR (b) the absolute age backstop from the window close has passed.
      // The backstop is what guarantees no mission stays live forever: it catches the
      // cases the per-market grace cannot — markets with no readable end date, drawn
      // futures, or a straggler UMA never resolves.
      const now = Date.now();
      const maxEndMs = await missionMaxEndMs(contestId);
      const anchorMs = await missionAnchorMs(contestId);
      const graceOut = maxEndMs > 0 && now > maxEndMs + SETTLE_GRACE_MS;
      const ageOut = anchorMs > 0 && now > anchorMs + MAX_AWAIT_MS;
      const timedOut = graceOut || ageOut;
      if (!timedOut) {
        broadcast({
          type: "status",
          contestId,
          payload: { status: "awaiting-resolution", detail: `${resolvedCount}/${outcomes.length} events resolved` },
        });
        continue;
      }
      if (resolvedCount === 0) {
        // Nothing resolved even past the grace window: refund the sponsor.
        console.warn(`worldcup resolver: mission ${contestId} timed out with no resolved events, refunding`);
        await cancelContest(contestId).catch((e) =>
          console.error(`worldcup resolver: refund ${contestId} failed:`, (e as Error).message),
        );
        continue;
      }
      // Some events resolved: settle on those; unresolved ones score neutrally for all.
      console.warn(
        `worldcup resolver: mission ${contestId} timed out, settling on ${resolvedCount}/${outcomes.length} resolved`,
      );
    }

    grading.add(contestId);
    gradeAndSettle(contestId)
      .catch((e) => console.error(`worldcup resolver: settle ${contestId} failed:`, (e as Error).message))
      .finally(() => grading.delete(contestId));
  }
}

export async function startWorldCupResolver(): Promise<void> {
  for (;;) {
    await sleep(POLL_MS);
    try {
      await resolveAwaitingMissions();
    } catch (err) {
      console.error("worldcup resolver failed:", (err as Error).message);
    }
  }
}
