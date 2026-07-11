import { query } from "../../db/pool.js";
import { defaultRating, updateOneVsOne, type Rating } from "../trueskill.js";

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

// One player in a rated match. Platform (house) agents fill seats but are never rated —
// the ladder belongs to real players — so a house agent's rating is never loaded or
// persisted. It still enters the update as the default baseline, so a real player's
// rating moves against it, but only real agents are written to the ladder.
export interface RatablePlayer {
  id: number;
  isHouse: boolean;
}

// A decisive heads-up result: winner beat loser. A tie (no chips changed hands, or no
// hand finished) should not be recorded — the caller skips it then.
export async function recordDuelResult(winner: RatablePlayer, loser: RatablePlayer): Promise<void> {
  if (winner.id === loser.id) return;
  const season = currentPokerSeason();
  const wr = winner.isHouse ? defaultRating() : await loadRating(season, winner.id);
  const lr = loser.isHouse ? defaultRating() : await loadRating(season, loser.id);
  const { winner: nw, loser: nl } = updateOneVsOne(wr, lr);
  if (!winner.isHouse) await saveRating(season, winner.id, nw, 1);
  if (!loser.isHouse) await saveRating(season, loser.id, nl, 0);
}

// A table result, given the final ranking best-first (by chips). Each higher rank is
// treated as beating each lower rank (all-pairs), the standard TrueSkill approximation
// for a full ranking; ratings are threaded in memory so each agent updates against the
// whole field, then persisted once. House agents are never persisted; the chip leader,
// when a real player, is credited a win.
export async function recordTableResult(rankingBestFirst: RatablePlayer[]): Promise<void> {
  const seen = new Set<number>();
  const players = rankingBestFirst.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  if (players.length < 2) return;
  const season = currentPokerSeason();
  const ratings = new Map<number, Rating>();
  for (const p of players) ratings.set(p.id, p.isHouse ? defaultRating() : await loadRating(season, p.id));
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const wId = players[i]!.id;
      const lId = players[j]!.id;
      const { winner, loser } = updateOneVsOne(ratings.get(wId)!, ratings.get(lId)!);
      ratings.set(wId, winner);
      ratings.set(lId, loser);
    }
  }
  for (let i = 0; i < players.length; i++) {
    if (players[i]!.isHouse) continue; // house agents are never persisted on the ladder
    await saveRating(season, players[i]!.id, ratings.get(players[i]!.id)!, i === 0 ? 1 : 0);
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
      where r.season = $1 and r.games > 0 and coalesce(m.is_house, false) = false
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
