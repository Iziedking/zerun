// World Cup prediction-market source built on API-Football (api-sports.io). We mirror
// how a soccer prediction market works: each fixture becomes one or more binary markets
// with a live implied price (the market's probability), agents forecast a probability,
// and after the match resolves we grade with a prediction-market P&L, not plain accuracy.
//
// Only World Cup fixtures are used (WORLDCUP_LEAGUE_ID). For a demo before the 2026
// tournament kicks off, set APIFOOTBALL_DEMO_LIVE=on to draw from currently-live
// fixtures instead, so missions actually resolve on camera; the market/resolution shape
// is identical, so nothing else changes when the real World Cup fixtures go live.
//
// Needs APIFOOTBALL_KEY in the environment. All parsing is defensive: the upstream
// schema varies and a missing field must never throw mid-mission.

const BASE = "https://v3.football.api-sports.io";
// API-Football's league id for the FIFA World Cup is 1; override per season if needed.
const WORLDCUP_LEAGUE_ID = Number(process.env.WORLDCUP_LEAGUE_ID ?? "1");
const WORLDCUP_SEASON = Number(process.env.WORLDCUP_SEASON ?? "2026");
const DEMO_LIVE = (process.env.APIFOOTBALL_DEMO_LIVE ?? "off").toLowerCase() === "on";

function key(): string {
  const k = process.env.APIFOOTBALL_KEY ?? "";
  if (!k) throw new Error("APIFOOTBALL_KEY is not set");
  return k;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { "x-apisports-key": key() } });
  if (!res.ok) throw new Error(`api-football ${path} -> ${res.status}`);
  const body = (await res.json()) as { response?: unknown; errors?: unknown };
  return body.response ?? [];
}

// ---- Types we care about, distilled from the API-Football response ----

export interface Fixture {
  id: number;
  kickoff: number; // unix seconds
  statusShort: string; // NS, 1H, HT, 2H, FT, AET, PEN, PST, CANC...
  home: string;
  away: string;
  goalsHome: number | null;
  goalsAway: number | null;
}

// A binary prediction market: "will <question> happen", priced at `price` (implied Yes
// probability in [0,1]). `settle` reads a finished fixture and returns 1 (Yes), 0 (No),
// or null (not resolvable / voided).
export interface WcMarket {
  key: string; // stable id
  fixtureId: number;
  question: string;
  price: number; // market-implied Yes probability, [0,1]
  kickoff: number; // forecast deadline anchor
  settle: (f: Fixture) => 0 | 1 | null;
}

function num(x: unknown): number | null {
  const n = typeof x === "string" ? Number(x.replace("%", "")) : Number(x);
  return Number.isFinite(n) ? n : null;
}

function toFixture(row: unknown): Fixture | null {
  const r = row as {
    fixture?: { id?: number; timestamp?: number; status?: { short?: string } };
    teams?: { home?: { name?: string }; away?: { name?: string } };
    goals?: { home?: number | null; away?: number | null };
  };
  const id = r?.fixture?.id;
  const ts = r?.fixture?.timestamp;
  if (typeof id !== "number" || typeof ts !== "number") return null;
  return {
    id,
    kickoff: ts,
    statusShort: String(r?.fixture?.status?.short ?? "NS"),
    home: String(r?.teams?.home?.name ?? "Home"),
    away: String(r?.teams?.away?.name ?? "Away"),
    goalsHome: r?.goals?.home ?? null,
    goalsAway: r?.goals?.away ?? null,
  };
}

const FINISHED = new Set(["FT", "AET", "PEN"]);
export function isFinished(f: Fixture): boolean {
  return FINISHED.has(f.statusShort);
}
export function isVoided(f: Fixture): boolean {
  return ["PST", "CANC", "ABD", "AWD", "WO"].includes(f.statusShort);
}

// Upcoming World Cup fixtures agents can still forecast (not yet kicked off). In demo
// mode, currently-live fixtures so a mission resolves quickly.
export async function fetchWorldCupFixtures(limit = 20): Promise<Fixture[]> {
  const path = DEMO_LIVE
    ? `/fixtures?live=all`
    : `/fixtures?league=${WORLDCUP_LEAGUE_ID}&season=${WORLDCUP_SEASON}&status=NS`;
  const rows = (await apiGet(path)) as unknown[];
  const out = rows.map(toFixture).filter((f): f is Fixture => f !== null);
  return out.slice(0, limit);
}

// Re-read a fixture's current state, for resolution polling.
export async function fetchFixture(fixtureId: number): Promise<Fixture | null> {
  const rows = (await apiGet(`/fixtures?id=${fixtureId}`)) as unknown[];
  const f = rows[0] ? toFixture(rows[0]) : null;
  return f;
}

// The market-implied home/draw/away probabilities for a fixture, from the predictions
// endpoint. Returns null if unavailable so the caller can skip that fixture.
export async function fetchImpliedProbs(
  fixtureId: number,
): Promise<{ home: number; draw: number; away: number } | null> {
  const rows = (await apiGet(`/predictions?fixture=${fixtureId}`)) as unknown[];
  const p = (rows[0] as { predictions?: { percent?: { home?: unknown; draw?: unknown; away?: unknown } } })
    ?.predictions?.percent;
  const home = num(p?.home);
  const draw = num(p?.draw);
  const away = num(p?.away);
  if (home === null || draw === null || away === null) return null;
  const sum = home + draw + away || 100;
  // Normalize to probabilities in [0,1].
  return { home: home / sum, draw: draw / sum, away: away / sum };
}

// Turn a fixture plus its implied probabilities into binary prediction markets. We build
// the two decisive match-result markets (home win, away win); a draw market and props
// (over 2.5 goals, team to score) slot in the same way from the odds endpoint later.
export function deriveMarkets(f: Fixture, probs: { home: number; draw: number; away: number }): WcMarket[] {
  return [
    {
      key: `apf:${f.id}:home`,
      fixtureId: f.id,
      question: `${f.home} to beat ${f.away}`,
      price: clampProb(probs.home),
      kickoff: f.kickoff,
      settle: (r) => resultOutcome(r, "home"),
    },
    {
      key: `apf:${f.id}:away`,
      fixtureId: f.id,
      question: `${f.away} to beat ${f.home}`,
      price: clampProb(probs.away),
      kickoff: f.kickoff,
      settle: (r) => resultOutcome(r, "away"),
    },
  ];
}

function clampProb(p: number): number {
  return Math.max(0.01, Math.min(0.99, p));
}

// Grade a match-result market from a finished fixture.
function resultOutcome(f: Fixture, side: "home" | "away"): 0 | 1 | null {
  if (isVoided(f)) return null;
  if (!isFinished(f) || f.goalsHome === null || f.goalsAway === null) return null;
  const homeWon = f.goalsHome > f.goalsAway;
  const awayWon = f.goalsAway > f.goalsHome;
  if (side === "home") return homeWon ? 1 : 0;
  return awayWon ? 1 : 0;
}

// ---- Prediction-market scoring (pure, unit-tested) ----

// One market's P&L for an agent that forecast `agentProb` when the market priced Yes at
// `marketPrice` and it resolved to `outcome` (1 Yes / 0 No). Reward is for beating the
// market in the correct direction: an agent that agreed with the market (edge 0) scores
// 0; disagreeing and being right pays, disagreeing and being wrong costs. Bounded to
// [-1, 1] per market.
export function marketPnl(marketPrice: number, agentProb: number, outcome: 0 | 1): number {
  const edge = agentProb - marketPrice;
  return edge * (outcome - marketPrice);
}

export interface AgentForecast {
  agentId: number;
  operator: string;
  // marketKey -> the agent's Yes probability for that market
  probs: Record<string, number>;
}

export interface MissionMarket {
  key: string;
  price: number;
  outcome: 0 | 1 | null; // null until resolved / voided (skipped in scoring)
}

// Rank agents by total P&L across the resolved markets of a mission. Voided or
// unresolved markets are skipped. Highest total wins; ties break on the sharper set of
// calls (higher summed absolute edge realized correctly). An agent with no positive
// P&L is not a winner, so if the whole field only matched the market, none is ranked
// first and the mission refunds.
export function scoreMission(
  markets: MissionMarket[],
  forecasts: AgentForecast[],
): { agentId: number; operator: string; pnl: number }[] {
  const resolved = markets.filter((m) => m.outcome !== null) as (MissionMarket & { outcome: 0 | 1 })[];
  const scored = forecasts.map((fc) => {
    let pnl = 0;
    for (const m of resolved) {
      const q = fc.probs[m.key];
      if (typeof q !== "number") continue; // no forecast on this market
      pnl += marketPnl(m.price, Math.max(0, Math.min(1, q)), m.outcome);
    }
    return { agentId: fc.agentId, operator: fc.operator, pnl };
  });
  return scored.sort((a, b) => b.pnl - a.pnl);
}
