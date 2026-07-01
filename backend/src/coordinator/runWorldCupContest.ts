import { query } from "../db/pool.js";
import { pickMissionMarkets, type WorldCupMarket } from "../runners/worldcup.js";
import { forecastWorldCup } from "../runners/worldcupForecast.js";
import { buildIntelPack, canResearch, freeAllotment, payForIntel } from "../runners/worldcupIntel.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { computePlan } from "../runners/computeLevels.js";
import { broadcast } from "./ws.js";
import { cancelContest, type RunResult } from "./finalize.js";
import { onchainEntryCount, syncEntriesFromChain, keepOnchainEntrants } from "./contestOps.js";
import { contestEngineAbi, coordinatorAddress, loadDeployment, publicClient } from "../chain/contracts.js";

// The World Cup Prediction Mission runner. It runs once when the join window closes:
// every agent forecasts each of the mission's upcoming events on 0G Compute, the
// probabilities are stored, and the contest then parks in `awaiting_resolution`. It
// does NOT settle here. A separate resolver (worldcupResolver.ts) grades and pays out
// later, when the real events have resolved on Polymarket.

const MISSION_SIZE = Number(process.env.WORLDCUP_MISSION_SIZE ?? "5");
const AGENT_CONCURRENCY = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entry {
  agentId: number;
  operator: string;
  agentName: string;
  isHouse: boolean;
}

async function readEntries(contestId: number): Promise<Entry[]> {
  const { rows } = await query<{ agent_id: string; operator: string; name: string | null; is_house: boolean | null }>(
    `select e.agent_id, e.operator, m.name, m.is_house
       from contest_entries e
       left join agents_meta m on m.agent_id = e.agent_id
      where e.contest_id = $1
      order by e.agent_id asc`,
    [contestId],
  );
  return rows.map((r) => ({
    agentId: Number(r.agent_id),
    operator: r.operator,
    agentName: r.name ?? `Agent #${r.agent_id}`,
    isHouse: Boolean(r.is_house),
  }));
}

// The mission's markets: reuse the ones already drawn for this contest (so a restart
// mid-run does not redraw a different set), otherwise draw a fresh mission and store it.
async function missionMarketsFor(contestId: number): Promise<WorldCupMarket[]> {
  const { rows } = await query<{ market_idx: number; condition_id: string; question: string }>(
    "select market_idx, condition_id, question from worldcup_mission_markets where contest_id = $1 order by market_idx asc",
    [contestId],
  );
  if (rows.length > 0) {
    return rows.map((r) => ({
      conditionId: r.condition_id,
      question: r.question,
      description: "",
      groupTitle: "",
      eventTitle: "",
      endDate: null,
    }));
  }
  const { rows: cfg } = await query<{ puzzle_count: number }>(
    "select puzzle_count from contests_meta where contest_id = $1",
    [contestId],
  );
  const count = Math.max(1, cfg[0]?.puzzle_count ?? MISSION_SIZE);
  const picked = await pickMissionMarkets(count);
  for (let i = 0; i < picked.length; i++) {
    await query(
      `insert into worldcup_mission_markets (contest_id, market_idx, condition_id, question)
         values ($1,$2,$3,$4) on conflict (contest_id, market_idx) do nothing`,
      [contestId, i, picked[i]!.conditionId, picked[i]!.question],
    );
  }
  return picked;
}

async function recordForecast(
  contestId: number,
  entry: Entry,
  marketIdx: number,
  market: WorldCupMarket,
  fc: Awaited<ReturnType<typeof forecastWorldCup>>,
): Promise<void> {
  await query(
    `insert into worldcup_forecasts (contest_id, agent_id, market_idx, prob_yes, latency_ms)
       values ($1,$2,$3,$4,$5)
       on conflict (contest_id, agent_id, market_idx) do update set
         prob_yes = excluded.prob_yes, latency_ms = excluded.latency_ms`,
    [contestId, entry.agentId, marketIdx, fc.probYes, fc.latencyMs],
  );
  await query(
    `insert into solve_runs
       (contest_id, agent_id, operator, puzzle_idx, prompt, expected, answer, verdict, source, provider, model, chat_id, verified, latency_ms, samples, sources)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (contest_id, agent_id, puzzle_idx) do update set
       answer = excluded.answer, verdict = excluded.verdict, source = excluded.source,
       provider = excluded.provider, model = excluded.model, chat_id = excluded.chat_id,
       verified = excluded.verified, latency_ms = excluded.latency_ms,
       samples = excluded.samples, sources = excluded.sources`,
    [
      contestId, entry.agentId, entry.operator, marketIdx, market.question, null,
      fc.prediction, "forecast", fc.source, fc.provider, fc.model,
      fc.chatID, fc.verified, fc.latencyMs, fc.samples, fc.sources,
    ],
  );
  broadcast({
    type: "solve",
    contestId,
    payload: {
      agentId: entry.agentId,
      agentName: entry.agentName,
      operator: entry.operator,
      puzzleIdx: marketIdx,
      prompt: market.question,
      answer: fc.prediction,
      verdict: "forecast",
      source: fc.source,
      provider: fc.provider,
      model: fc.model,
      chatID: fc.chatID,
      verified: fc.verified,
      latencyMs: fc.latencyMs,
      samples: fc.samples,
      sources: fc.sources,
    },
  });
}

export async function runWorldCupContest(contestId: number): Promise<RunResult> {
  const notSettled: RunResult = { contestId, root: null, posted: false, settled: false, payouts: [] };

  let entries = await readEntries(contestId);
  if (entries.length === 0) {
    const onchain = await onchainEntryCount(contestId).catch(() => 0);
    if (onchain > 0) {
      await syncEntriesFromChain(contestId);
      entries = await readEntries(contestId);
    }
    if (entries.length === 0) {
      if (onchain > 0) return notSettled; // not yet mirrored, retry next sweep
      broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
      await cancelContest(contestId);
      return notSettled;
    }
  }

  entries = await keepOnchainEntrants(contestId, entries);
  if (entries.length === 0) {
    broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
    await cancelContest(contestId);
    return notSettled;
  }

  const markets = await missionMarketsFor(contestId);
  if (markets.length === 0) {
    broadcast({ type: "status", contestId, payload: { status: "no-markets" } });
    await cancelContest(contestId);
    return notSettled;
  }

  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `${entries.length} agents forecasting ${markets.length} World Cup events` },
  });

  const levelOf = new Map<number, number>();
  const planOf = new Map<number, ReturnType<typeof computePlan>>();
  for (const e of entries) {
    const lvl = await getAgentCompute(e.agentId);
    levelOf.set(e.agentId, lvl);
    planOf.set(e.agentId, computePlan(lvl));
  }

  await mapLimit(entries, AGENT_CONCURRENCY, async (entry) => {
    const plan = planOf.get(entry.agentId)!;
    const level = levelOf.get(entry.agentId) ?? 0;
    const allot = freeAllotment(level);
    let freeUsed = 0; // intel pulls used this mission (free within the tier's allotment)

    for (let idx = 0; idx < markets.length; idx++) {
      const market = markets[idx]!;

      // Acquire the tiered intel pack. Research is a tier-3-and-up capability; within
      // the tier's free allotment it is free, beyond it each pull is paid over x402
      // (coordinator-settled and broadcast to the feed with its verifiable tx).
      let research = "";
      let sources = 0;
      if (canResearch(level)) {
        const pack = await buildIntelPack(market, level);
        research = pack.text;
        sources = pack.sources;
        if (research) {
          if (freeUsed < allot) {
            freeUsed += 1;
          } else {
            const pay = await payForIntel();
            if (pay) {
              broadcast({
                type: "x402",
                contestId,
                payload: {
                  agentId: entry.agentId,
                  agentName: entry.agentName,
                  label: `intel: ${(market.groupTitle || market.question).slice(0, 40)}`,
                  priceUsdc: pay.priceUsdc,
                  txHash: pay.txHash,
                },
              });
            }
          }
        }
      }

      const fc = await forecastWorldCup(market, plan, research, sources);
      await recordForecast(contestId, entry, idx, market, fc);
      await sleep(150);
    }
  });

  // Park the mission until the real events resolve. The resolver grades and settles.
  await query("update contests_meta set status = 'awaiting_resolution' where contest_id = $1", [contestId]);
  broadcast({
    type: "status",
    contestId,
    payload: { status: "awaiting-resolution", detail: "forecasts locked; awaiting the real World Cup results" },
  });
  return notSettled;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

// Whether the house is excluded from scoring, matching the Analyst rule: exclude the
// house whenever a real player is present, or when a house-only field runs on a real
// host's pool (so it refunds the host rather than paying the house). A house-only
// field on the coordinator's own pool is kept (a demo that still settles). Exported so
// the resolver applies the same rule at grade time.
export async function excludeHouseFor(contestId: number): Promise<boolean> {
  const dep = loadDeployment();
  const entries = await readEntries(contestId);
  if (entries.some((e) => !e.isHouse)) return true;
  try {
    const sponsor = (
      await publicClient.readContract({
        address: dep.contestEngine,
        abi: contestEngineAbi,
        functionName: "getContest",
        args: [BigInt(contestId)],
      })
    ).sponsor;
    return sponsor.toLowerCase() !== coordinatorAddress().toLowerCase();
  } catch {
    return true;
  }
}

// The field with each entry's house flag and compute level, for the resolver to build
// scores at grade time.
export async function scoringField(
  contestId: number,
): Promise<{ agentId: number; operator: string; isHouse: boolean; level: number }[]> {
  const entries = await readEntries(contestId);
  const out: { agentId: number; operator: string; isHouse: boolean; level: number }[] = [];
  for (const e of entries) {
    out.push({ agentId: e.agentId, operator: e.operator, isHouse: e.isHouse, level: await getAgentCompute(e.agentId) });
  }
  return out;
}
