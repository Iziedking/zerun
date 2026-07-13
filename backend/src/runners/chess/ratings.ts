import { query } from "../../db/pool.js";
import { defaultRating, updateOneVsOne, updateDraw, type Rating } from "../trueskill.js";

// Persistence for the chess competition TrueSkill ladder. Every refereed game updates the two
// agents that played, so the season leaderboard (mu - 3*sigma) reflects real, provable results.
//
// Unlike the poker ladder, house "engine" stand-ins ARE rated here: before public uploads open,
// the field IS the tiered house roster self-playing, and that is what makes the board live and
// gives newcomers a benchmark to beat. The PRIZE board filters to real uploads (see chessLadder).

export function currentChessSeason(): string {
  return process.env.CHESS_SEASON ?? "c1";
}

// Qualification for the prize board. A fresh upload starts with no rating, so to be in the running
// an agent has to earn its place: play at least this many rated games AND hold a conservative
// rating above the floor. This is what stops a last-minute upload from parking at the top, and why
// re-uploading (which wipes the rating) means starting the climb over.
const QUALIFY_MIN_GAMES = Number(process.env.CHESS_QUALIFY_MIN_GAMES ?? "10");
const QUALIFY_MIN_RATING = Number(process.env.CHESS_QUALIFY_MIN_RATING ?? "0");

export function chessQualify(): { minGames: number; minRating: number } {
  return { minGames: QUALIFY_MIN_GAMES, minRating: QUALIFY_MIN_RATING };
}

function isQualified(games: number, rating: number): boolean {
  return games >= QUALIFY_MIN_GAMES && rating >= QUALIFY_MIN_RATING;
}

async function loadRating(season: string, agentId: number): Promise<Rating> {
  const { rows } = await query<{ mu: number; sigma: number }>(
    "select mu, sigma from chess_ratings where season = $1 and agent_id = $2",
    [season, agentId],
  );
  const r = rows[0];
  return r ? { mu: Number(r.mu), sigma: Number(r.sigma) } : defaultRating();
}

async function saveRating(
  season: string,
  agentId: number,
  r: Rating,
  win: number,
  draw: number,
  loss: number,
): Promise<void> {
  await query(
    `insert into chess_ratings (season, agent_id, mu, sigma, games, wins, draws, losses, updated_at)
       values ($1, $2, $3, $4, 1, $5, $6, $7, now())
     on conflict (season, agent_id) do update set
       mu = excluded.mu, sigma = excluded.sigma,
       games = chess_ratings.games + 1,
       wins = chess_ratings.wins + $5,
       draws = chess_ratings.draws + $6,
       losses = chess_ratings.losses + $7,
       updated_at = now()`,
    [season, agentId, r.mu, r.sigma, win, draw, loss],
  );
}

// A decisive game: winner beat loser.
export async function recordChessResult(winnerId: number, loserId: number): Promise<void> {
  if (winnerId === loserId) return;
  const season = currentChessSeason();
  const wr = await loadRating(season, winnerId);
  const lr = await loadRating(season, loserId);
  const { winner: nw, loser: nl } = updateOneVsOne(wr, lr);
  await saveRating(season, winnerId, nw, 1, 0, 0);
  await saveRating(season, loserId, nl, 0, 0, 1);
}

// A drawn game between two agents.
export async function recordChessDraw(aId: number, bId: number): Promise<void> {
  if (aId === bId) return;
  const season = currentChessSeason();
  const ar = await loadRating(season, aId);
  const br = await loadRating(season, bId);
  const { a: na, b: nb } = updateDraw(ar, br);
  await saveRating(season, aId, na, 0, 1, 0);
  await saveRating(season, bId, nb, 0, 1, 0);
}

export interface ChessLadderRow {
  agentId: number;
  agentName: string;
  owner: string | null;
  kind: string; // 'upload' | 'engine'
  tier: number | null;
  modelDriven: boolean; // a house showcase agent that reasons on 0G (engine shortlist, model picks)
  mu: number;
  sigma: number;
  rating: number; // conservative mu - 3*sigma
  games: number;
  wins: number;
  draws: number;
  losses: number;
  qualified: boolean; // meets the prize-board minimum (games + rating)
}

// The season ladder, ranked by conservative rating (a high rating needs skill AND enough games).
// `onlyUploads` returns the prize board: real player submissions only, and only those that have
// qualified (met the minimum games and rating), the top of which win.
export async function chessLadder(
  season = currentChessSeason(),
  limit = 100,
  onlyUploads = false,
): Promise<ChessLadderRow[]> {
  const { rows } = await query<{
    agent_id: string;
    name: string;
    owner: string | null;
    kind: string;
    tier: number | null;
    model_driven: boolean | null;
    mu: number;
    sigma: number;
    games: number;
    wins: number;
    draws: number;
    losses: number;
  }>(
    `select r.agent_id, a.name, a.owner, a.kind, a.tier, a.model_driven, r.mu, r.sigma, r.games, r.wins, r.draws, r.losses
       from chess_ratings r
       join chess_agents a on a.id = r.agent_id
      where r.season = $1 and r.games > 0 and a.status = 'active'
        and ($3 = false or (a.kind = 'upload' and a.owner is not null))
      order by (r.mu - 3 * r.sigma) desc, r.mu desc
      limit $2`,
    [season, limit, onlyUploads],
  );
  const mapped = rows.map((r) => {
    const rating = Number(r.mu) - 3 * Number(r.sigma);
    const games = Number(r.games);
    return {
      agentId: Number(r.agent_id),
      agentName: r.name,
      owner: r.owner,
      kind: r.kind,
      tier: r.tier === null ? null : Number(r.tier),
      modelDriven: Boolean(r.model_driven),
      mu: Number(r.mu),
      sigma: Number(r.sigma),
      rating,
      games,
      wins: Number(r.wins),
      draws: Number(r.draws),
      losses: Number(r.losses),
      qualified: isQualified(games, rating),
    };
  });
  // The prize board shows qualified players only. The full board keeps everyone, tagging who has
  // qualified, so a climbing player can see how close they are.
  return onlyUploads ? mapped.filter((r) => r.qualified) : mapped;
}
