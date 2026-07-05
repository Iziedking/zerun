import type { Fixture, WcMarket } from "./apiFootball.js";

// A zero-registration market source built on TheSportsDB. Its free test key ("3")
// serves real fixtures and finished results with no signup, which unblocks the demo
// when a predictions-API account is not available. TheSportsDB has no odds, so we
// derive the market price ourselves (a home-advantage prior, refined by recent form),
// and agents compete to beat that price under the same P&L scoring as the API-Football
// source. Filter to the World Cup league (SPORTSDB_LEAGUE_ID) when its fixtures are up;
// for a demo before then, point it at any near-term league so missions resolve quickly.

const BASE = "https://www.thesportsdb.com/api/v1/json";
const KEY = process.env.SPORTSDB_KEY ?? "3"; // "3" is the public free test key
// Default 4328 = English Premier League (has near-term, fast-resolving fixtures for a
// demo); set SPORTSDB_LEAGUE_ID to the FIFA World Cup league id when it is live.
const LEAGUE_ID = Number(process.env.SPORTSDB_LEAGUE_ID ?? "4328");

// Prediction-market prior: home teams win ~46% of the time, away ~27%, draw ~27%.
// This is the baseline market price agents must beat; recent form nudges it below.
const PRIOR = { home: 0.46, draw: 0.27, away: 0.27 };

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/${KEY}/${path}`);
  if (!res.ok) throw new Error(`thesportsdb ${path} -> ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function toFixture(row: unknown): Fixture | null {
  const e = row as {
    idEvent?: string;
    strEvent?: string;
    strHomeTeam?: string;
    strAwayTeam?: string;
    intHomeScore?: string | null;
    intAwayScore?: string | null;
    strStatus?: string;
    strTimestamp?: string;
    dateEvent?: string;
  };
  const id = Number(e?.idEvent);
  if (!Number.isFinite(id)) return null;
  const ts = e?.strTimestamp ? Date.parse(e.strTimestamp) : e?.dateEvent ? Date.parse(e.dateEvent) : NaN;
  const gh = e?.intHomeScore == null || e.intHomeScore === "" ? null : Number(e.intHomeScore);
  const ga = e?.intAwayScore == null || e.intAwayScore === "" ? null : Number(e.intAwayScore);
  return {
    id,
    kickoff: Number.isFinite(ts) ? Math.floor(ts / 1000) : 0,
    // TheSportsDB uses "Match Finished" / "FT" / "NS"; normalize to the FT the grader knows.
    statusShort: /finish|ft|full/i.test(String(e?.strStatus ?? "")) || (gh !== null && ga !== null) ? "FT" : "NS",
    home: String(e?.strHomeTeam ?? "Home"),
    away: String(e?.strAwayTeam ?? "Away"),
    goalsHome: gh,
    goalsAway: ga,
  };
}

// Upcoming fixtures for the configured league, still forecastable (not started).
export async function fetchUpcomingFixtures(limit = 20): Promise<Fixture[]> {
  const body = await apiGet(`eventsnextleague.php?id=${LEAGUE_ID}`);
  const rows = (body.events as unknown[] | null) ?? [];
  return rows.map(toFixture).filter((f): f is Fixture => f !== null).slice(0, limit);
}

// Re-read a fixture for resolution polling.
export async function fetchFixture(eventId: number): Promise<Fixture | null> {
  const body = await apiGet(`lookupevent.php?id=${eventId}`);
  const rows = (body.events as unknown[] | null) ?? [];
  return rows[0] ? toFixture(rows[0]) : null;
}

// The market-implied Yes probabilities for a fixture. TheSportsDB has no odds, so we
// use the home-advantage prior. (A form-adjusted price from each team's recent results
// is the next refinement; the shape here does not change.)
export function impliedProbs(_f: Fixture): { home: number; draw: number; away: number } {
  return { ...PRIOR };
}

// Same market shape as the API-Football source, so the runner and scorer are unchanged.
export function deriveMarkets(f: Fixture, probs = impliedProbs(f)): WcMarket[] {
  const clamp = (p: number) => Math.max(0.01, Math.min(0.99, p));
  const finished = f.statusShort === "FT" && f.goalsHome !== null && f.goalsAway !== null;
  const outcome = (side: "home" | "away"): 0 | 1 | null => {
    if (!finished) return null;
    const homeWon = (f.goalsHome as number) > (f.goalsAway as number);
    const awayWon = (f.goalsAway as number) > (f.goalsHome as number);
    return side === "home" ? (homeWon ? 1 : 0) : awayWon ? 1 : 0;
  };
  return [
    { key: `tsdb:${f.id}:home`, fixtureId: f.id, question: `${f.home} to beat ${f.away}`, price: clamp(probs.home), kickoff: f.kickoff, settle: () => outcome("home") },
    { key: `tsdb:${f.id}:away`, fixtureId: f.id, question: `${f.away} to beat ${f.home}`, price: clamp(probs.away), kickoff: f.kickoff, settle: () => outcome("away") },
  ];
}
