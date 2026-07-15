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

// Qualification for the prize board. To be in the running an agent has to earn its place:
//   - play at least CHESS_QUALIFY_MIN_GAMES rated games (a floor, not a race: games are serialized
//     and shared across the field, so this stays reachable even as the field grows),
//   - hold a conservative rating above CHESS_QUALIFY_MIN_RATING,
//   - and have been on the board at least CHESS_QUALIFY_MIN_AGE_HOURS (tenure). This is the real
//     latecomer gate: a last-day entry cannot have days of tenure no matter how fast it plays, and
//     it does not depend on field size the way a raw game count does.
// Re-uploading wipes the rating (climb over) but keeps the agent's original entry time, so tenure
// is not reset by improving your code.
const QUALIFY_MIN_GAMES = Number(process.env.CHESS_QUALIFY_MIN_GAMES ?? "10");
const QUALIFY_MIN_RATING = Number(process.env.CHESS_QUALIFY_MIN_RATING ?? "0");
const QUALIFY_MIN_AGE_HOURS = Number(process.env.CHESS_QUALIFY_MIN_AGE_HOURS ?? "0");

export function chessQualify(): { minGames: number; minRating: number; minAgeHours: number } {
  return { minGames: QUALIFY_MIN_GAMES, minRating: QUALIFY_MIN_RATING, minAgeHours: QUALIFY_MIN_AGE_HOURS };
}

function isQualified(games: number, rating: number, createdAtMs: number): boolean {
  if (games < QUALIFY_MIN_GAMES || rating < QUALIFY_MIN_RATING) return false;
  if (QUALIFY_MIN_AGE_HOURS > 0 && createdAtMs) {
    const ageHours = (Date.now() - createdAtMs) / 3_600_000;
    if (ageHours < QUALIFY_MIN_AGE_HOURS) return false;
  }
  return true;
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
  identityTokenId: number | null; // ERC-8004 agentId on 0G mainnet, for the "verified on 0G" badge
  xHandle: string | null; // the owner's connected X handle, for the avatar and byline
  xAvatar: string | null; // the owner's X profile image (400x400)
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
    identity_token_id: string | null;
    created_at: string | null;
    x_handle: string | null;
    x_avatar: string | null;
    mu: number;
    sigma: number;
    games: number;
    wins: number;
    draws: number;
    losses: number;
  }>(
    `select r.agent_id, a.name, a.owner, a.kind, a.tier, a.model_driven, a.identity_token_id,
            a.created_at::text as created_at, s.x_handle, s.x_avatar,
            r.mu, r.sigma, r.games, r.wins, r.draws, r.losses
       from chess_ratings r
       join chess_agents a on a.id = r.agent_id
       left join social_identity s on s.wallet = a.owner
      where r.season = $1 and r.games > 0 and a.status = 'active'
        and ($3 = false or (a.kind = 'upload' and a.owner is not null))
      order by (r.mu - 3 * r.sigma) desc, r.mu desc
      limit $2`,
    [season, limit, onlyUploads],
  );
  const mapped = rows.map((r) => {
    const rating = Number(r.mu) - 3 * Number(r.sigma);
    const games = Number(r.games);
    const createdAtMs = r.created_at ? Date.parse(r.created_at) : 0;
    return {
      agentId: Number(r.agent_id),
      agentName: r.name,
      owner: r.owner,
      kind: r.kind,
      tier: r.tier === null ? null : Number(r.tier),
      modelDriven: Boolean(r.model_driven),
      identityTokenId: r.identity_token_id === null ? null : Number(r.identity_token_id),
      xHandle: r.x_handle,
      xAvatar: r.x_avatar,
      mu: Number(r.mu),
      sigma: Number(r.sigma),
      rating,
      games,
      wins: Number(r.wins),
      draws: Number(r.draws),
      losses: Number(r.losses),
      qualified: isQualified(games, rating, createdAtMs),
    };
  });
  // Show every entrant, each tagged with whether it has qualified, so a climbing player can see how
  // close it is and the board never looks empty while agents are still earning their place. The
  // prize goes to the top QUALIFIED players, but that is decided at the deadline, not by hiding
  // anyone from the live board. `onlyUploads` still filters house out via the SQL above.
  return mapped;
}
