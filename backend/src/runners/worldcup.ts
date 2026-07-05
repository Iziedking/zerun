import { query } from "../db/pool.js";

// World Cup Prediction Mission source. Unlike the Analyst's Normal Prediction, which
// grades against markets Polymarket has already resolved, World Cup missions forecast
// genuinely future events (match results and props like "Will Spain win the 2026 FIFA
// World Cup?") and settle later when the real event resolves. This module is Phase 1:
// pull the live World Cup markets from Polymarket into a local pool and rotate them
// into missions so a market rarely repeats until the whole pool has been used once.

export interface WorldCupMarket {
  conditionId: string;
  question: string;
  description: string;
  groupTitle: string; // e.g. "Spain"
  eventTitle: string; // e.g. "World Cup Winner"
  endDate: string | null;
  price: number | null; // market-implied Yes probability at pick time
  marketType: string; // e.g. "totals", "spreads", "both_teams_to_score"
  matchSubject: string; // e.g. "Brazil vs. Norway"
}

interface RawEvent {
  title?: string;
  slug?: string;
  endDate?: string;
  markets?: RawMarket[];
}

interface RawMarket {
  conditionId?: string;
  question?: string;
  description?: string;
  outcomes?: string; // JSON string, e.g. '["Yes","No"]'
  outcomePrices?: string; // JSON string, e.g. '["0.1","0.9"]'
  groupItemTitle?: string;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  umaResolutionStatus?: string;
  sportsMarketType?: string; // e.g. "totals", "spreads", "both_teams_to_score"
}

// The Polymarket tag that carries the actual World Cup MATCH games. The plain
// "world-cup" tag returns only tournament futures and props ("World Cup Winner",
// "Golden Boot") that resolve at tournament end weeks away; the real per-match
// markets (moneyline, spread, totals, both-teams-to-score, ...) live under
// "fifa-world-cup" with related_tags, as separate events whose slug starts with
// "fifwc-<home>-<away>-<date>" and which settle the same day they are played.
// A mission wants same-day-resolving games, so we source those. Tunable.
const WORLDCUP_TAG_SLUG = process.env.WORLDCUP_TAG_SLUG ?? "fifa-world-cup";

// How many days ahead to pull games for, so tomorrow's slate is already in the pool
// when the mission rolls over at 00:00. Only same-day games are ever drawn into a
// mission (see drawUnused); this window just keeps the pool warm.
const WORLDCUP_LOOKAHEAD_DAYS = Number(process.env.WORLDCUP_LOOKAHEAD_DAYS ?? "8");

// A match-game event, as opposed to a tournament future/prop. Match events use the
// slug convention fifwc-<home>-<away>-<YYYY-MM-DD>[-variant]; futures do not.
function isMatchGame(e: RawEvent): boolean {
  return /^fifwc-[a-z]{3}-[a-z]{3}-\d{4}-\d{2}-\d{2}/.test(e.slug ?? "");
}

// The match subject shared by every variant of a game, e.g. the event title
// "Brazil vs. Norway - More Markets" reduces to "Brazil vs. Norway". Used to keep a
// mission from stacking multiple lines off the same fixture.
function matchSubjectOf(eventTitle: string | undefined): string {
  const t = (eventTitle ?? "").trim();
  const dash = t.indexOf(" - ");
  return (dash > 0 ? t.slice(0, dash) : t).trim();
}

function parseJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// A market's resolution, read the same way markets.ts does: once resolved, the two
// outcome prices are exactly "1" and "0". Open markets carry live probabilities.
function resolutionOf(m: RawMarket): { resolved: boolean; winnerIndex: number | null } {
  const prices = parseJsonArray(m.outcomePrices);
  if (prices.length !== 2) return { resolved: false, winnerIndex: null };
  const yesWon = prices[0] === "1" && prices[1] === "0";
  const noWon = prices[0] === "0" && prices[1] === "1";
  if (!m.closed || (!yesWon && !noWon)) return { resolved: false, winnerIndex: null };
  return { resolved: true, winnerIndex: yesWon ? 0 : 1 };
}

async function fetchWorldCupEvents(): Promise<RawEvent[]> {
  // Window the fetch to games ending from the start of today through the lookahead so
  // the pool holds today's slate plus a few days out; a match event's endDate is its
  // kickoff-plus-play-time, so this captures the games that resolve within each day.
  const now = new Date();
  const min = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const max = new Date(min.getTime() + WORLDCUP_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const url =
    "https://gamma-api.polymarket.com/events?closed=false&limit=500&order=endDate&ascending=true" +
    `&related_tags=true&end_date_min=${encodeURIComponent(min.toISOString())}` +
    `&end_date_max=${encodeURIComponent(max.toISOString())}` +
    `&tag_slug=${encodeURIComponent(WORLDCUP_TAG_SLUG)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Polymarket events responded ${res.status}`);
    const data = (await res.json()) as RawEvent[];
    if (!Array.isArray(data)) return [];
    // Keep only real match games; drop tournament futures/props so the mission pool is
    // exclusively same-day-resolving fixtures.
    return data.filter(isMatchGame);
  } finally {
    clearTimeout(timer);
  }
}

// Pull the current World Cup markets from Polymarket and upsert them into the pool.
// Returns how many binary markets are now known. Rotation bookkeeping
// (last_used_cycle) is preserved across syncs; only the content and resolution state
// are refreshed.
export async function syncWorldCupMarkets(): Promise<number> {
  let events: RawEvent[] = [];
  try {
    events = await fetchWorldCupEvents();
  } catch {
    return 0; // a failed sync leaves the existing pool untouched
  }

  let upserts = 0;
  for (const e of events) {
    for (const m of e.markets ?? []) {
      const outcomes = parseJsonArray(m.outcomes);
      if (outcomes.length !== 2) continue; // binary Yes/No only
      const conditionId = (m.conditionId ?? "").trim();
      const question = (m.question ?? "").trim();
      if (!conditionId || question.length < 8) continue;
      const prices = parseJsonArray(m.outcomePrices);
      const price = prices.length === 2 && Number.isFinite(Number(prices[0])) ? Number(prices[0]) : null;
      const { resolved, winnerIndex } = resolutionOf(m);
      await query(
        `insert into worldcup_markets
           (condition_id, question, description, group_title, event_title, end_date, price, resolved, winner_index, market_type, match_subject, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         on conflict (condition_id) do update set
           question = excluded.question, description = excluded.description,
           group_title = excluded.group_title, event_title = excluded.event_title,
           end_date = excluded.end_date, price = excluded.price, resolved = excluded.resolved,
           winner_index = excluded.winner_index, market_type = excluded.market_type,
           match_subject = excluded.match_subject, updated_at = now()`,
        [
          conditionId,
          question,
          (m.description ?? "").slice(0, 600),
          m.groupItemTitle ?? null,
          e.title ?? null,
          m.endDate ?? null,
          price,
          resolved,
          winnerIndex,
          m.sportsMarketType ?? null,
          matchSubjectOf(e.title),
        ],
      );
      upserts += 1;
    }
  }
  return upserts;
}

// Fetch resolution for specific markets by conditionId, including closed ones, and
// update the pool for any that have resolved. The event-level sync catches markets
// whose parent event is still open; this targeted fetch covers the tail (a market
// whose event has fully closed at tournament end).
export async function refreshMissionResolutions(conditionIds: string[]): Promise<void> {
  if (conditionIds.length === 0) return;
  const params = conditionIds.map((c) => `condition_ids=${encodeURIComponent(c)}`).join("&");
  const url = `https://gamma-api.polymarket.com/markets?${params}&limit=${conditionIds.length}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let raw: RawMarket[] = [];
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return;
    const data = (await res.json()) as RawMarket[];
    raw = Array.isArray(data) ? data : [];
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }
  for (const m of raw) {
    const { resolved, winnerIndex } = resolutionOf(m);
    if (!resolved || !m.conditionId) continue;
    await query(
      "update worldcup_markets set resolved = true, winner_index = $2, updated_at = now() where condition_id = $1",
      [m.conditionId, winnerIndex],
    );
  }
}

export interface MissionOutcome {
  marketIdx: number;
  conditionId: string;
  resolved: boolean;
  winnerIndex: number | null;
  price: number | null; // the Yes price fixed with the mission, for P&L grading
}

// The resolution state of a mission's markets, joined from the pool, with the price the
// mission was priced at.
export async function missionOutcomes(contestId: number): Promise<MissionOutcome[]> {
  const { rows } = await query<{
    market_idx: number;
    condition_id: string;
    resolved: boolean | null;
    winner_index: number | null;
    price: number | null;
  }>(
    `select mm.market_idx, mm.condition_id, mm.price, wm.resolved, wm.winner_index
       from worldcup_mission_markets mm
       left join worldcup_markets wm on wm.condition_id = mm.condition_id
      where mm.contest_id = $1
      order by mm.market_idx asc`,
    [contestId],
  );
  return rows.map((r) => ({
    marketIdx: r.market_idx,
    conditionId: r.condition_id,
    resolved: Boolean(r.resolved),
    winnerIndex: r.winner_index,
    price: r.price,
  }));
}

export interface Forecast {
  agentId: number;
  marketIdx: number;
  probYes: number | null;
  latencyMs: number;
}

// Grade forecasts against the resolved outcomes: a call counts correct when the
// agent leaned the way the market actually settled (prob >= 0.5 for Yes). Pure and
// testable; the resolver turns this into ranked scores. Latency accumulates for the
// speed tiebreak.
export function tallyForecasts(
  forecasts: Forecast[],
  outcomes: { marketIdx: number; winnerIndex: number | null }[],
): Map<number, { correct: number; totalLatencyMs: number }> {
  const winByIdx = new Map(outcomes.map((o) => [o.marketIdx, o.winnerIndex]));
  const out = new Map<number, { correct: number; totalLatencyMs: number }>();
  for (const f of forecasts) {
    const rec = out.get(f.agentId) ?? { correct: 0, totalLatencyMs: 0 };
    rec.totalLatencyMs += f.latencyMs;
    const winner = winByIdx.get(f.marketIdx);
    if (winner !== undefined && winner !== null && f.probYes !== null) {
      const predictedYes = f.probYes >= 0.5;
      if (predictedYes === (winner === 0)) rec.correct += 1;
    }
    out.set(f.agentId, rec);
  }
  return out;
}

// Prediction-market P&L grading. An agent earns by beating the market in the direction
// it actually settled: with the market's Yes price p, the agent's Yes probability q, and
// outcome o (1 if Yes won, i.e. winnerIndex 0), one market pays `(q - p) * (o - p)`.
// Matching the market (q = p) scores 0; disagreeing and being right pays, being wrong
// costs, and conviction scales both. The mission P&L is the sum across resolved markets;
// the resolver ranks by it and pays the top, refunding if none beat the market.
export function tallyPnl(
  forecasts: Forecast[],
  prices: { marketIdx: number; price: number | null }[],
  outcomes: { marketIdx: number; winnerIndex: number | null }[],
): Map<number, { pnl: number; totalLatencyMs: number }> {
  const priceByIdx = new Map(prices.map((p) => [p.marketIdx, p.price]));
  const winByIdx = new Map(outcomes.map((o) => [o.marketIdx, o.winnerIndex]));
  const out = new Map<number, { pnl: number; totalLatencyMs: number }>();
  for (const f of forecasts) {
    const rec = out.get(f.agentId) ?? { pnl: 0, totalLatencyMs: 0 };
    rec.totalLatencyMs += f.latencyMs;
    const p = priceByIdx.get(f.marketIdx);
    const winner = winByIdx.get(f.marketIdx);
    if (typeof p === "number" && winner !== undefined && winner !== null && f.probYes !== null) {
      const outcome = winner === 0 ? 1 : 0; // winnerIndex 0 = Yes resolved
      const q = Math.max(0, Math.min(1, f.probYes));
      rec.pnl += (q - p) * (outcome - p);
    }
    out.set(f.agentId, rec);
  }
  return out;
}

async function currentCycle(): Promise<number> {
  const { rows } = await query<{ cycle: number }>("select cycle from worldcup_state where id = 1");
  return rows[0]?.cycle ?? 1;
}

async function bumpCycle(): Promise<number> {
  const { rows } = await query<{ cycle: number }>(
    "update worldcup_state set cycle = cycle + 1 where id = 1 returning cycle",
  );
  return rows[0]?.cycle ?? 1;
}

interface DrawRow {
  condition_id: string;
  question: string;
  description: string | null;
  group_title: string | null;
  event_title: string | null;
  end_date: string | null;
  price: number | null;
  market_type: string | null;
  match_subject: string | null;
}

function toMarket(r: DrawRow): WorldCupMarket {
  return {
    conditionId: r.condition_id,
    question: r.question,
    description: r.description ?? "",
    groupTitle: r.group_title ?? "",
    eventTitle: r.event_title ?? "",
    endDate: r.end_date,
    price: r.price,
    marketType: r.market_type ?? "",
    matchSubject: r.match_subject ?? "",
  };
}

async function drawUnused(cycle: number, count: number): Promise<WorldCupMarket[]> {
  // Pull a wide same-day candidate set (not just `count`), then diversify: prefer a
  // spread across distinct prediction types (totals, spreads, BTTS, ...) and distinct
  // fixtures so a mission reads as a varied slate rather than five lines off one game.
  // A market only qualifies if it has a live price to grade the P&L against.
  const { rows } = await query<DrawRow>(
    `select condition_id, question, description, group_title, event_title, end_date::text as end_date,
            price, market_type, match_subject
       from worldcup_markets
      where resolved = false and last_used_cycle < $1
        and price is not null and price > 0 and price < 1
        and end_date is not null
        and end_date >= date_trunc('day', now())
        and end_date <  date_trunc('day', now()) + interval '1 day'
      order by random()
      limit 200`,
    [cycle],
  );
  return diversify(rows.map(toMarket), count);
}

// Greedily pick `count` markets favouring variety: on each pass take the candidate
// whose (marketType, matchSubject) pair is least represented so far, so distinct
// prediction types and distinct games come first, then fill from what remains.
function diversify(pool: WorldCupMarket[], count: number): WorldCupMarket[] {
  const picked: WorldCupMarket[] = [];
  const typeSeen = new Map<string, number>();
  const gameSeen = new Map<string, number>();
  const remaining = [...pool];
  while (picked.length < count && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i]!;
      // Lower is better: penalise repeating a type, and (more lightly) a fixture.
      const score = (typeSeen.get(m.marketType) ?? 0) * 2 + (gameSeen.get(m.matchSubject) ?? 0);
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0]!;
    picked.push(chosen);
    typeSeen.set(chosen.marketType, (typeSeen.get(chosen.marketType) ?? 0) + 1);
    gameSeen.set(chosen.matchSubject, (gameSeen.get(chosen.matchSubject) ?? 0) + 1);
  }
  return picked;
}

// Draw the next mission's markets from the pool: unresolved markets not yet used in
// the current rotation cycle, chosen at random. When the current cycle is exhausted
// (fewer unused markets left than asked for), bump the cycle so every unresolved
// market is eligible again, then draw from the fresh cycle. The chosen markets are
// stamped with the cycle so they will not reappear until the pool cycles once more.
export async function pickMissionMarkets(count: number): Promise<WorldCupMarket[]> {
  let cycle = await currentCycle();
  let picks = await drawUnused(cycle, count);
  if (picks.length < count) {
    // Pool exhausted for this cycle: start a new one so markets are free to repeat.
    cycle = await bumpCycle();
    picks = await drawUnused(cycle, count);
  }
  if (picks.length > 0) {
    await query(
      "update worldcup_markets set last_used_cycle = $1 where condition_id = any($2)",
      [cycle, picks.map((p) => p.conditionId)],
    );
  }
  return picks;
}
