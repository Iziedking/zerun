import { query } from "../../db/pool.js";
import { defaultRating, updateOneVsOne, type Rating } from "./trueskill.js";

// Persistence for the poker TrueSkill ladder. Every finished match updates the
// ratings of the agents that played, so the season leaderboard (mu - 3*sigma) reflects
// real, provable results. House agents are rated too: the ladder's whole point is to
// show that a higher tier climbs above a lower one over a season, and much of the field
// early on is the tiered house roster self-playing.

export function currentPokerSeason(): string {
  return process.env.POKER_SEASON ?? "s1";
}

async function loadRating(season: string, agentId: number): Promise<Rating> {
  const { rows } = await query<{ mu: number; sigma: number }>(
    "select mu, sigma from poker_ratings where season = $1 and agent_id = $2",
    [season, agentId],
  );
  const r = rows[0];
  return r ? { mu: Number(r.mu), sigma: Number(r.sigma) } : defaultRating();
}

async function saveRating(
  season: string,
  agentId: number,
  r: Rating,
  winInc: number,
): Promise<void> {
  await query(
    `insert into poker_ratings (season, agent_id, mu, sigma, games, wins, updated_at)
       values ($1, $2, $3, $4, 1, $5, now())
     on conflict (season, agent_id) do update set
       mu = excluded.mu, sigma = excluded.sigma,
       games = poker_ratings.games + 1, wins = poker_ratings.wins + $5, updated_at = now()`,
    [season, agentId, r.mu, r.sigma, winInc],
  );
}

// A decisive heads-up result: winnerId beat loserId. A tie (no chips changed hands, or
// no hand finished) should not be recorded — the caller passes null then.
export async function recordDuelResult(winnerId: number, loserId: number): Promise<void> {
  if (winnerId === loserId) return;
  const season = currentPokerSeason();
  const wr = await loadRating(season, winnerId);
  const lr = await loadRating(season, loserId);
  const { winner, loser } = updateOneVsOne(wr, lr);
  await saveRating(season, winnerId, winner, 1);
  await saveRating(season, loserId, loser, 0);
}

// A table result, given the final ranking best-first (by chips). Each higher rank is
// treated as beating each lower rank (all-pairs), the standard TrueSkill approximation
// for a full ranking; ratings are threaded in memory so each agent updates against the
// whole field, then persisted once. Only the chip leader (rank 0) is credited a win.
export async function recordTableResult(rankingBestFirst: number[]): Promise<void> {
  const ids = rankingBestFirst.filter((id, i) => rankingBestFirst.indexOf(id) === i); // dedupe
  if (ids.length < 2) return;
  const season = currentPokerSeason();
  const ratings = new Map<number, Rating>();
  for (const id of ids) ratings.set(id, await loadRating(season, id));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const wId = ids[i]!;
      const lId = ids[j]!;
      const { winner, loser } = updateOneVsOne(ratings.get(wId)!, ratings.get(lId)!);
      ratings.set(wId, winner);
      ratings.set(lId, loser);
    }
  }
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    await saveRating(season, id, ratings.get(id)!, i === 0 ? 1 : 0);
  }
}

export interface LadderRow {
  agentId: number;
  agentName: string;
  operator: string | null;
  isHouse: boolean;
  computeLevel: number;
  mu: number;
  sigma: number;
  rating: number; // conservative mu - 3*sigma
  games: number;
  wins: number;
}

// The season ladder, ranked by conservative rating (a high rating needs skill AND
// enough games). Excludes agents with no games so the board is only real competitors.
export async function pokerLadder(season = currentPokerSeason(), limit = 100): Promise<LadderRow[]> {
  const { rows } = await query<{
    agent_id: string;
    name: string | null;
    owner: string | null;
    is_house: boolean;
    compute_level: number | null;
    mu: number;
    sigma: number;
    games: number;
    wins: number;
  }>(
    `select r.agent_id, m.name, m.owner, coalesce(m.is_house, false) as is_house,
            coalesce(m.compute_level, 0) as compute_level, r.mu, r.sigma, r.games, r.wins
       from poker_ratings r
       left join agents_meta m on m.agent_id = r.agent_id
      where r.season = $1 and r.games > 0
      order by (r.mu - 3 * r.sigma) desc, r.mu desc
      limit $2`,
    [season, limit],
  );
  return rows.map((r) => ({
    agentId: Number(r.agent_id),
    agentName: r.name ?? `Agent #${r.agent_id}`,
    operator: r.owner,
    isHouse: Boolean(r.is_house),
    computeLevel: Number(r.compute_level),
    mu: Number(r.mu),
    sigma: Number(r.sigma),
    rating: Number(r.mu) - 3 * Number(r.sigma),
    games: Number(r.games),
    wins: Number(r.wins),
  }));
}
