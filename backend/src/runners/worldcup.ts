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
}

interface RawEvent {
  title?: string;
  slug?: string;
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
}

// Events whose title or slug looks like the World Cup. Kept loose on purpose: the
// gamma search is fuzzy, so we re-filter what it returns.
const WORLDCUP_RE = /world[\s-]?cup|fifa/i;
// Search phrases to seed the event pull (the API search is fuzzy, so we union a few
// and then filter by WORLDCUP_RE). Tunable without a code change.
const EVENT_QUERIES = (process.env.WORLDCUP_EVENT_QUERIES ?? "world cup,fifa world cup")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

async function fetchEvents(search: string): Promise<RawEvent[]> {
  const url =
    "https://gamma-api.polymarket.com/events?closed=false&limit=100&order=volume&ascending=false&search=" +
    encodeURIComponent(search);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Polymarket events responded ${res.status}`);
    const data = (await res.json()) as RawEvent[];
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

// Pull the current World Cup markets from Polymarket and upsert them into the pool.
// Returns how many binary markets are now known. Rotation bookkeeping
// (last_used_cycle) is preserved across syncs; only the content and resolution state
// are refreshed.
export async function syncWorldCupMarkets(): Promise<number> {
  const byEvent = new Map<string, RawEvent>();
  for (const q of EVENT_QUERIES) {
    let events: RawEvent[] = [];
    try {
      events = await fetchEvents(q);
    } catch {
      continue; // one failed query should not sink the whole sync
    }
    for (const e of events) {
      const tag = `${e.title ?? ""} ${e.slug ?? ""}`;
      if (!WORLDCUP_RE.test(tag)) continue;
      byEvent.set(e.slug ?? e.title ?? JSON.stringify(e), e);
    }
  }

  let upserts = 0;
  for (const e of byEvent.values()) {
    for (const m of e.markets ?? []) {
      const outcomes = parseJsonArray(m.outcomes);
      if (outcomes.length !== 2) continue; // binary Yes/No only
      const conditionId = (m.conditionId ?? "").trim();
      const question = (m.question ?? "").trim();
      if (!conditionId || question.length < 8) continue;
      const { resolved, winnerIndex } = resolutionOf(m);
      await query(
        `insert into worldcup_markets
           (condition_id, question, description, group_title, event_title, end_date, resolved, winner_index, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now())
         on conflict (condition_id) do update set
           question = excluded.question, description = excluded.description,
           group_title = excluded.group_title, event_title = excluded.event_title,
           end_date = excluded.end_date, resolved = excluded.resolved,
           winner_index = excluded.winner_index, updated_at = now()`,
        [
          conditionId,
          question,
          (m.description ?? "").slice(0, 600),
          m.groupItemTitle ?? null,
          e.title ?? null,
          m.endDate ?? null,
          resolved,
          winnerIndex,
        ],
      );
      upserts += 1;
    }
  }
  return upserts;
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

async function drawUnused(cycle: number, count: number): Promise<WorldCupMarket[]> {
  const { rows } = await query<{
    condition_id: string;
    question: string;
    description: string | null;
    group_title: string | null;
    event_title: string | null;
    end_date: string | null;
  }>(
    `select condition_id, question, description, group_title, event_title, end_date::text as end_date
       from worldcup_markets
      where resolved = false and last_used_cycle < $1
      order by random()
      limit $2`,
    [cycle, count],
  );
  return rows.map((r) => ({
    conditionId: r.condition_id,
    question: r.question,
    description: r.description ?? "",
    groupTitle: r.group_title ?? "",
    eventTitle: r.event_title ?? "",
    endDate: r.end_date,
  }));
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
