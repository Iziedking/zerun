import { query } from "../db/pool.js";
import { broadcast, type BracketSnapshot, type BracketSeat, type BracketMatchView } from "./ws.js";
import { recordScore, broadcastStandings } from "./standings.js";
import { finalizeContest, cancelContest, type RunResult } from "./finalize.js";
import { contestEngineAbi, coordinatorAddress, loadDeployment, publicClient } from "../chain/contracts.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { playChessGame, type ChessPlayer } from "./chessGame.js";
import { openMemoryFor, scheduleMemoryUpdates } from "../runners/agentMemory.js";
import { emptySession, type MemorySession } from "../runners/memoryMarket.js";
import {
  buildBracket,
  nextMatch,
  recordResult,
  champion,
  placements,
  type Bracket,
} from "../runners/chess/bracket.js";

// The chess tournament runner. A single-elimination knockout of up to 8 agents: seed by
// tier (strongest meet late), play every pending match through the shared playChessGame
// loop, advance winners, and broadcast the live bracket the whole way. It settles by
// PLACEMENT — champion, runner-up, then the round each agent went out in — paying the top
// placements through the shared merkle payout. House-rule aware: a house agent can win
// the bracket on the board (shown as champion), but the pot only ever routes to real
// players, ranked among themselves by how far they got. runChessContest hands off here
// for three or more entrants, mirroring poker's duel -> table handoff.

export interface TourneyPlayer {
  agentId: number;
  operator: string;
  agentName: string;
  isHouse: boolean;
}

// Default seat target for a chess tournament room (the locked design: 8 house agents can
// fill a full knockout). Tunable, but the room fills to its on-chain seat cap regardless.
const DEFAULT_CAPACITY = Number(process.env.CHESS_TOURNEY_SEATS ?? "8");

// Round names from the tail of the bracket: the last round is the final, the one before
// it the semifinal, then the quarterfinal, else a numbered round.
function roundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - 1 - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinal";
  if (fromEnd === 2) return "Quarterfinal";
  return `Round ${round + 1}`;
}

// Build the live bracket envelope for the UI from the current bracket state.
function bracketSnapshot(
  contestId: number,
  bracket: Bracket,
  seats: BracketSeat[],
  status: BracketSnapshot["status"],
  live: { round: number; index: number } | null,
): BracketSnapshot {
  const totalRounds = bracket.rounds.length;
  const rounds: BracketMatchView[][] = bracket.rounds.map((round) =>
    round.map((m) => ({
      round: m.round,
      index: m.index,
      a: m.a,
      b: m.b,
      winner: m.winner,
      live: Boolean(live && live.round === m.round && live.index === m.index),
    })),
  );
  const champ = champion(bracket);
  let currentMatch: BracketSnapshot["currentMatch"] = null;
  if (live) {
    const m = bracket.rounds[live.round]?.[live.index];
    const nameOf = (id: number | null) => seats.find((s) => s.agentId === id)?.agentName ?? "—";
    currentMatch = m
      ? { round: live.round, index: live.index, label: `${roundName(live.round, totalRounds)} · ${nameOf(m.a)} vs ${nameOf(m.b)}` }
      : null;
  }
  return {
    contestId,
    status,
    size: bracket.size,
    capacity: seats.length || DEFAULT_CAPACITY,
    filled: seats.length,
    rounds,
    seats,
    currentMatch,
    champion: champ,
    placements: status === "complete" ? placements(bracket) : [],
  };
}

export async function runChessTournament(contestId: number, entries: TourneyPlayer[]): Promise<RunResult> {
  const notSettled: RunResult = { contestId, root: null, posted: false, settled: false, payouts: [] };
  const dep = loadDeployment();
  const players = entries.slice(0, DEFAULT_CAPACITY);

  // House exclusion (matches every other kind): exclude house whenever a real operator is
  // present, or when a house-only field runs on a real host's pool.
  const hasReal = players.some((p) => !p.isHouse);
  let excludeHouse = hasReal;
  if (!excludeHouse) {
    const sponsor = (
      await publicClient.readContract({
        address: dep.contestEngine,
        abi: contestEngineAbi,
        functionName: "getContest",
        args: [BigInt(contestId)],
      })
    ).sponsor;
    excludeHouse = sponsor.toLowerCase() !== coordinatorAddress().toLowerCase();
  }

  // Each agent's on-chain Compute tier — the seeding strength and its search depth/model.
  const tierOf = new Map<number, number>();
  for (const p of players) tierOf.set(p.agentId, await getAgentCompute(p.agentId));

  const bracket = buildBracket(players.map((p) => ({ agentId: p.agentId, tier: tierOf.get(p.agentId) ?? 0 })));

  // Seat metadata for the UI, in seed order (strongest first) so the bracket can show
  // each agent's seed. Matches buildBracket's sort (tier desc, then agentId asc).
  const seeded = [...players].sort((a, b) => (tierOf.get(b.agentId) ?? 0) - (tierOf.get(a.agentId) ?? 0) || a.agentId - b.agentId);
  const seatOf = (p: TourneyPlayer, seed: number): BracketSeat => ({
    agentId: p.agentId,
    agentName: p.agentName,
    operator: p.operator,
    isHouse: p.isHouse,
    tier: tierOf.get(p.agentId) ?? 0,
    seed,
  });
  const seats: BracketSeat[] = seeded.map((p, i) => seatOf(p, i + 1));
  const playerById = new Map(players.map((p) => [p.agentId, p]));

  // Each agent's memory budget for the WHOLE bracket, opened once. A player who goes deep
  // spends more than one knocked out in the first round, which is the point: memory is
  // priced per move it actually informed. Unfunded agents get an empty session and play
  // exactly as they would have without memory.
  const memoryOf = new Map<number, MemorySession>();
  for (const p of players) {
    memoryOf.set(p.agentId, await openMemoryFor(p.agentId, contestId, "chess", p.isHouse));
  }
  const funded = [...memoryOf.values()].filter((s) => s.funded).length;
  if (funded > 0) console.log(`chess tournament ${contestId}: ${funded}/${players.length} agents playing with memory`);

  await query("update contests_meta set status = 'running' where contest_id = $1", [contestId]);
  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `Chess tournament: ${players.length} agents, single elimination` },
  });
  broadcast({ type: "bracket", contestId, payload: bracketSnapshot(contestId, bracket, seats, "playing", null) });

  const moveLog: unknown[] = [];
  let moveIndexBase = 0;
  const totalRounds = bracket.rounds.length;

  // Play every pending match in bracket order, advancing the winner each time. Wrapped so
  // any unexpected error still falls through to settlement with the bracket as it stands,
  // rather than throwing out of the runner and leaving the contest to be stale-cancelled.
  try {
    let m = nextMatch(bracket);
    while (m) {
      const a = playerById.get(m.a!)!;
      const b = playerById.get(m.b!)!;
      // The higher seed plays white (a small, deterministic edge for the stronger agent);
      // ties break to the lower agent id.
      const ta = tierOf.get(a.agentId) ?? 0;
      const tb = tierOf.get(b.agentId) ?? 0;
      const aWhite = ta > tb || (ta === tb && a.agentId <= b.agentId);
      const white = aWhite ? a : b;
      const black = aWhite ? b : a;
      const label = `${roundName(m.round, totalRounds)} · ${white.agentName} vs ${black.agentName}`;

      broadcast({
        type: "status",
        contestId,
        payload: { status: "running", detail: `${label} — playing` },
      });
      broadcast({
        type: "bracket",
        contestId,
        payload: bracketSnapshot(contestId, bracket, seats, "playing", { round: m.round, index: m.index }),
      });

      const seat = (p: TourneyPlayer): ChessPlayer => ({
        agentId: p.agentId,
        operator: p.operator,
        agentName: p.agentName,
        isHouse: p.isHouse,
        tier: tierOf.get(p.agentId) ?? 0,
      });
      const result = await playChessGame({
        contestId,
        white: seat(white),
        black: seat(black),
        moveIndexBase,
        match: { round: m.round, index: m.index, label, totalRounds },
        recordCaptureStandings: false,
        moveLog,
        memory: {
          white: memoryOf.get(white.agentId) ?? emptySession,
          black: memoryOf.get(black.agentId) ?? emptySession,
        },
      });
      moveIndexBase += result.plies;

      recordResult(bracket, m.round, m.index, result.winner.agentId);
      broadcast({
        type: "status",
        contestId,
        payload: { status: "running", detail: `${result.winner.agentName} beats ${result.loser.agentName} by ${result.how}` },
      });
      broadcast({
        type: "bracket",
        contestId,
        payload: bracketSnapshot(contestId, bracket, seats, "playing", null),
      });

      m = nextMatch(bracket);
    }
  } catch (err) {
    console.error(`chess tournament ${contestId}: bracket loop aborted, settling on state so far:`, (err as Error).message);
  }

  // Settle the memory each agent bought. One charge() per agent for the whole bracket, so
  // hundreds of moves cost no transactions while they are being played. This runs even if
  // the bracket loop threw: the agents consumed the memory they consumed. Never throws —
  // an uncollected debit is the platform's problem, not a reason to stall a payout.
  for (const [agentId, session] of memoryOf) {
    if (session.calls === 0) continue;
    await session.settle().catch((err) =>
      console.error(`chess tournament ${contestId}: memory settle for agent ${agentId} failed:`, (err as Error).message),
    );
  }

  // Final placement for every agent (1 = champion, 2 = runner-up, semifinal losers share
  // 3rd, quarterfinal losers share 5th). Drives both the standings and the prize split.
  const placed = placements(bracket);
  const placeOf = new Map(placed.map((p) => [p.agentId, p.place]));
  const weight = (agentId: number) => bracket.size + 1 - (placeOf.get(agentId) ?? bracket.size);

  // Standings score = placement weight (champion highest), so the shared standings table
  // reads in bracket order. Recorded for everyone, including house, so the field is shown.
  for (const p of players) {
    await recordScore(contestId, p.agentId, weight(p.agentId), "placement").catch(() => {});
  }
  await broadcastStandings(contestId).catch(() => {});

  const champId = champion(bracket);
  const champName = seats.find((s) => s.agentId === champId)?.agentName ?? "—";
  broadcast({
    type: "bracket",
    contestId,
    payload: bracketSnapshot(contestId, bracket, seats, "complete", null),
  });

  // Payout: the best REAL players by placement (house is shown as champion but never
  // takes the pot). An all-house field on a real host's pool has no eligible winner and
  // cancels; on the coordinator's own demo pool, house may place.
  const eligible = excludeHouse ? players.filter((p) => !p.isHouse) : players;
  if (eligible.length === 0) {
    broadcast({ type: "status", contestId, payload: { status: "no-winner" } });
    await cancelContest(contestId);
    return notSettled;
  }

  const topReal = [...eligible].sort((a, b) => weight(b.agentId) - weight(a.agentId) || a.agentId - b.agentId)[0]!;
  broadcast({
    type: "status",
    contestId,
    payload: {
      status: "running",
      detail:
        champId != null && !excludeHouse
          ? `${champName} wins the bracket`
          : `${champName} wins the bracket · pot to ${topReal.agentName}`,
    },
  });

  // Rank the eligible field by placement weight, then hand it to the shared settlement,
  // which pays the contest's topN by decreasing share (champion-most). Placement weight is
  // always >= 1, so every placed agent is payout-eligible under computePayouts' correct>0.
  const scores: AgentScore[] = eligible.map((p) => ({
    agentId: p.agentId,
    operator: p.operator,
    correct: weight(p.agentId),
    totalLatencyMs: 0,
    computeLevel: tierOf.get(p.agentId) ?? 0,
  }));
  // Memory is scheduled BEFORE the on-chain finalize, and this ordering is load-bearing.
  //
  // `finalizeContest` posts a score root to the chain, and that transaction can throw --
  // most commonly `nonce too low`, when the coordinator wallet has another write in flight.
  // The autopilot watchdog then resettles the contest from the stored root, which pays
  // everyone correctly but never returns to this function. So every line after the finalize
  // was dead code on exactly the contests that hit a nonce collision, and in production that
  // was most of them: the memory table sat empty while the arena settled 460 contests.
  //
  // Nothing here needs the contest to be settled. `scheduleMemoryUpdates` is a fire-and-forget
  // queue reading `contest_scores` and `solve_runs`, both already written during the game, and
  // the tendency queries never filter on status. Settling an agent's memory debits likewise
  // only touches its own escrow. Neither can unsettle a paid contest, and now neither can be
  // skipped by one that failed to settle on the first attempt.
  //
  // Fold this bracket into each real agent's CHESS memory (its own record, separate from
  // what it learned about puzzles).
  scheduleMemoryUpdates(`chess tournament ${contestId}`, players, "chess");
  return finalizeContest(contestId, rankAgents(scores));
}

// Broadcast a lobby snapshot (seats filling, no matches played yet) for an open chess
// tournament, so the room shows who has joined before the bracket starts. Uses each
// agent's stored Compute level for the seed order (cheap, no chain reads), which the
// real seeding refines when the run begins. Best effort; never throws.
export async function broadcastChessLobby(contestId: number, capacity: number): Promise<void> {
  try {
    const { rows } = await query<{ agent_id: string; operator: string; name: string | null; is_house: boolean | null; compute_level: number | null }>(
      `select e.agent_id, e.operator, m.name, m.is_house, m.compute_level
         from contest_entries e
         left join agents_meta m on m.agent_id = e.agent_id
        where e.contest_id = $1`,
      [contestId],
    );
    const seatsIn = rows.map((r) => ({
      agentId: Number(r.agent_id),
      operator: r.operator,
      agentName: r.name ?? `Agent #${r.agent_id}`,
      isHouse: Boolean(r.is_house),
      tier: Number(r.compute_level ?? 0),
    }));
    const seeded = [...seatsIn].sort((a, b) => b.tier - a.tier || a.agentId - b.agentId);
    const seats: BracketSeat[] = seeded.map((s, i) => ({ ...s, seed: i + 1 }));
    const payload: BracketSnapshot = {
      contestId,
      status: "lobby",
      size: 0,
      capacity,
      filled: seats.length,
      rounds: [],
      seats,
      currentMatch: null,
      champion: null,
      placements: [],
    };
    broadcast({ type: "bracket", contestId, payload });
  } catch (err) {
    console.error(`chess lobby ${contestId}: broadcast failed:`, (err as Error).message);
  }
}
