import { query } from "../db/pool.js";
import {
  syncWorldCupMarkets,
  missionOutcomes,
  refreshMissionResolutions,
  tallyForecasts,
  type Forecast,
} from "../runners/worldcup.js";
import { excludeHouseFor, scoringField } from "./runWorldCupContest.js";
import { finalizeContest, cancelContest } from "./finalize.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { broadcast } from "./ws.js";

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
const SETTLE_GRACE_MS = Number(process.env.WORLDCUP_SETTLE_GRACE_HOURS ?? "48") * 3600 * 1000;
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

async function gradeAndSettle(contestId: number): Promise<void> {
  const outcomes = await missionOutcomes(contestId);
  const forecasts = await readForecasts(contestId);
  const tally = tallyForecasts(
    forecasts,
    outcomes.map((o) => ({ marketIdx: o.marketIdx, winnerIndex: o.winnerIndex })),
  );

  const excludeHouse = await excludeHouseFor(contestId);
  const field = await scoringField(contestId);
  const scores: AgentScore[] = [];
  for (const f of field) {
    if (f.isHouse && excludeHouse) continue;
    const t = tally.get(f.agentId) ?? { correct: 0, totalLatencyMs: 0 };
    scores.push({
      agentId: f.agentId,
      operator: f.operator,
      correct: t.correct,
      totalLatencyMs: t.totalLatencyMs,
      computeLevel: f.level,
    });
  }

  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: "World Cup events resolved; scoring the mission" },
  });
  await finalizeContest(contestId, rankAgents(scores));
}

// One pass over every awaiting mission: refresh resolutions, and settle any whose
// events have all resolved.
export async function resolveAwaitingMissions(): Promise<void> {
  const ids = await awaitingMissionIds();
  if (ids.length === 0) return;

  // Refresh the pool once (events still open carry their resolved markets too).
  await syncWorldCupMarkets().catch(() => {});

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

    const resolvedCount = outcomes.filter((o) => o.resolved).length;
    const done = outcomes.length > 0 && resolvedCount === outcomes.length;

    if (!done) {
      // Stop waiting on stragglers once the grace window past the last event date has
      // passed (a postponed or voided market that will never resolve).
      const maxEndMs = await missionMaxEndMs(contestId);
      const timedOut = maxEndMs > 0 && Date.now() > maxEndMs + SETTLE_GRACE_MS;
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
