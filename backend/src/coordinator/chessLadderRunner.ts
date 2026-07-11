import { query } from "../db/pool.js";
import { playRefereedGame } from "./chessMatch.js";
import { engineMover, type Mover } from "../runners/chess/movers.js";
import { recordChessResult, recordChessDraw, currentChessSeason } from "../runners/chess/ratings.js";
import { conservative } from "../runners/trueskill.js";

// The matchmaker for the community chess ladder. It keeps the board alive by continuously pairing
// active agents — closest rating, fewest games first — and playing one refereed game per tick,
// then recording the TrueSkill result. Before public uploads open, the field is a house "engine"
// roster self-playing, so the leaderboard is populated and newcomers have benchmarks to beat.
//
// An uploaded agent (Phase 2) slots in with no change here: only `moverFor` learns a second kind,
// swapping the engine stand-in for the sandbox. The pairing, refereeing, and rating are identical.

const ENABLED = (process.env.CHESS_LADDER ?? "off").toLowerCase() === "on";
const TICK_MS = Number(process.env.CHESS_LADDER_TICK_MS ?? "15000");

// The house benchmark roster: one engine per tier, so the ladder shows a real strength gradient
// from the first game. Names match Zerun's house style; the tier is the only thing that differs.
const HOUSE_ENGINES: { name: string; tier: number }[] = [
  { name: "Pixel", tier: 0 },
  { name: "Byte", tier: 1 },
  { name: "Echo", tier: 2 },
  { name: "Volt", tier: 3 },
  { name: "Flux", tier: 4 },
  { name: "Ion", tier: 5 },
];

export async function seedHouseEngines(): Promise<number> {
  let created = 0;
  for (const e of HOUSE_ENGINES) {
    const { rowCount } = await query(
      `insert into chess_agents (owner, name, kind, tier, status)
         select null, $1, 'engine', $2, 'active'
       where not exists (select 1 from chess_agents where kind = 'engine' and name = $1)`,
      [e.name, e.tier],
    );
    created += rowCount ?? 0;
  }
  return created;
}

interface LadderAgent {
  id: number;
  name: string;
  kind: string;
  tier: number | null;
  cons: number; // conservative rating
  games: number;
}

async function activeAgents(season: string): Promise<LadderAgent[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    kind: string;
    tier: number | null;
    mu: number;
    sigma: number;
    games: number;
  }>(
    `select a.id, a.name, a.kind, a.tier,
            coalesce(r.mu, 25.0) as mu, coalesce(r.sigma, 8.3333333) as sigma,
            coalesce(r.games, 0) as games
       from chess_agents a
       left join chess_ratings r on r.agent_id = a.id and r.season = $1
      where a.status = 'active'`,
    [season],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    tier: r.tier === null ? null : Number(r.tier),
    cons: conservative({ mu: Number(r.mu), sigma: Number(r.sigma) }),
    games: Number(r.games),
  }));
}

// Build the mover for an agent. Today only house engines exist; an uploaded agent will resolve to
// the sandbox mover here (Phase 2), behind the same `Mover` type.
function moverFor(a: LadderAgent): Mover {
  if (a.kind === "engine") return engineMover(a.tier ?? 0);
  // Placeholder until the sandbox lands: an unbuilt upload plays as a tier-0 engine so it never
  // crashes the loop. Phase 2 replaces this with sandboxMover(a).
  return engineMover(0);
}

export interface LadderGameSummary {
  a: string;
  b: string;
  winner: string | null; // agent name, or null for a draw
  how: string;
  plies: number;
}

// Play one ladder game: the agent with the fewest games gets a match against its nearest rating.
export async function playOneLadderGame(): Promise<LadderGameSummary | null> {
  const season = currentChessSeason();
  const agents = await activeAgents(season);
  if (agents.length < 2) return null;

  // Fewest games first breaks the field in evenly; ties broken arbitrarily by id order.
  agents.sort((x, y) => x.games - y.games);
  const a = agents[0]!;
  // Nearest conservative rating among the rest is the most informative, closest match.
  let b = agents[1]!;
  let bestGap = Math.abs(a.cons - b.cons);
  for (const cand of agents.slice(1)) {
    const gap = Math.abs(a.cons - cand.cons);
    if (gap < bestGap) {
      bestGap = gap;
      b = cand;
    }
  }

  const aWhite = Math.random() < 0.5;
  const white = moverFor(aWhite ? a : b);
  const black = moverFor(aWhite ? b : a);
  const result = await playRefereedGame(white, black);

  if (result.winner === null) {
    await recordChessDraw(a.id, b.id);
    return { a: a.name, b: b.name, winner: null, how: result.how, plies: result.plies };
  }
  const winnerIsA = (result.winner === "w") === aWhite;
  const winId = winnerIsA ? a.id : b.id;
  const loseId = winnerIsA ? b.id : a.id;
  await recordChessResult(winId, loseId);
  return { a: a.name, b: b.name, winner: winnerIsA ? a.name : b.name, how: result.how, plies: result.plies };
}

// Play a batch sequentially. Sequential on purpose: a single tier-3+ game is CPU-heavy, so
// overlapping games would starve the rest of the backend.
export async function runChessLadderBatch(n: number): Promise<LadderGameSummary[]> {
  const out: LadderGameSummary[] = [];
  for (let i = 0; i < n; i++) {
    const s = await playOneLadderGame();
    if (s) out.push(s);
  }
  return out;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

// Start the background loop. Serialized: one game finishes before the next is scheduled, so the
// ladder never runs two CPU-heavy games at once. Gated by CHESS_LADDER=on.
export function startChessLadder(): void {
  if (!ENABLED || timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await seedHouseEngines();
      await playOneLadderGame();
    } catch (err) {
      console.error("chess ladder tick failed:", (err as Error).message);
    } finally {
      running = false;
      timer = setTimeout(tick, TICK_MS);
    }
  };
  timer = setTimeout(tick, TICK_MS);
  console.log(`chess ladder: matchmaker on, one game every ${TICK_MS} ms`);
}

export function stopChessLadder(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
