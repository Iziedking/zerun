import { query } from "../db/pool.js";
import { broadcast } from "./ws.js";
import { cancelContest, finalizeContest, type RunResult } from "./finalize.js";
import { onchainEntryCount, syncEntriesFromChain, keepOnchainEntrants, isUnderfilledDuel } from "./contestOps.js";
import { contestEngineAbi, coordinatorAddress, loadDeployment, publicClient } from "../chain/contracts.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { recordScore, broadcastStandings } from "./standings.js";
import { playChessGame, type ChessPlayer } from "./chessGame.js";
import { runChessTournament } from "./runChessTournament.js";
import { openMemoryFor, scheduleMemoryUpdates } from "../runners/agentMemory.js";

// The chess duel runner. Two agents play a full game move by move on 0G (the shared
// playChessGame loop). The board winner is checkmate, else the most captured material
// at the cap. Winner-take-all through the shared merkle payout, house-rule aware: a
// house agent can win the game on the board but the pot always routes to the best real
// player. Three or more entrants make a knockout tournament; that hands off to
// runChessTournament, mirroring how poker hands a full table off to runPokerTable.

interface Player {
  agentId: number;
  operator: string;
  agentName: string;
  isHouse: boolean;
}

async function readEntries(contestId: number): Promise<Player[]> {
  const { rows } = await query<{ agent_id: string; operator: string; name: string | null; is_house: boolean | null }>(
    `select e.agent_id, e.operator, m.name, m.is_house
       from contest_entries e
       left join agents_meta m on m.agent_id = e.agent_id
      where e.contest_id = $1
      order by e.agent_id asc`,
    [contestId],
  );
  return rows.map((r) => ({
    agentId: Number(r.agent_id),
    operator: r.operator,
    agentName: r.name ?? `Agent #${r.agent_id}`,
    isHouse: Boolean(r.is_house),
  }));
}

// The house-exclusion rule (matches poker/analyst): exclude house whenever a real
// operator is present, or when a house-only field runs on a real host's pool.
async function excludeHouseFor(contestId: number, players: Player[]): Promise<boolean> {
  if (players.some((p) => !p.isHouse)) return true;
  try {
    const dep = loadDeployment();
    const sponsor = (
      await publicClient.readContract({
        address: dep.contestEngine,
        abi: contestEngineAbi,
        functionName: "getContest",
        args: [BigInt(contestId)],
      })
    ).sponsor;
    return sponsor.toLowerCase() !== coordinatorAddress().toLowerCase();
  } catch {
    return true;
  }
}

export async function runChessContest(contestId: number): Promise<RunResult> {
  const notSettled: RunResult = { contestId, root: null, posted: false, settled: false, payouts: [] };

  let entries = await readEntries(contestId);
  if (entries.length === 0) {
    const onchain = await onchainEntryCount(contestId).catch(() => 0);
    if (onchain > 0) {
      await syncEntriesFromChain(contestId);
      entries = await readEntries(contestId);
    }
    if (entries.length === 0) {
      if (onchain > 0) return notSettled;
      broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
      await cancelContest(contestId);
      return notSettled;
    }
  }
  entries = await keepOnchainEntrants(contestId, entries);
  if (entries.length < 2 || (await isUnderfilledDuel(contestId, entries.length))) {
    broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
    await cancelContest(contestId);
    return notSettled;
  }

  // Three or more entrants make a single-elimination tournament; hand off to that
  // runner. Two seats stay on the heads-up duel path below.
  if (entries.length > 2) return runChessTournament(contestId, entries);

  // A duel is the first two entrants: white then black.
  const players: [Player, Player] = [entries[0]!, entries[1]!];
  const excludeHouse = await excludeHouseFor(contestId, players);
  const tierOf = new Map<number, number>();
  for (const p of players) tierOf.set(p.agentId, await getAgentCompute(p.agentId));

  await query("update contests_meta set status = 'running' where contest_id = $1", [contestId]);
  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `${players[0].agentName} (white) vs ${players[1].agentName} (black)` },
  });

  const seat = (p: Player): ChessPlayer => ({
    agentId: p.agentId,
    operator: p.operator,
    agentName: p.agentName,
    isHouse: p.isHouse,
    tier: tierOf.get(p.agentId) ?? 0,
  });
  // Each seat's memory budget for this game. The tournament path has always done this; the
  // duel never did, so a duel neither read an agent's chess memory nor wrote one afterwards —
  // and a duel is the shape most chess contests actually take. That is why the memory card
  // stayed empty no matter how many games an agent played.
  //
  // A seat whose owner has not funded it gets an empty session and plays exactly as before.
  const memWhite = await openMemoryFor(players[0].agentId, contestId, "chess", players[0].isHouse);
  const memBlack = await openMemoryFor(players[1].agentId, contestId, "chess", players[1].isHouse);
  const funded = [memWhite, memBlack].filter((m) => m.funded).length;
  if (funded > 0) console.log(`chess duel ${contestId}: ${funded}/2 agents playing with memory`);

  const result = await playChessGame({
    contestId,
    white: seat(players[0]),
    black: seat(players[1]),
    recordCaptureStandings: true,
    memory: { white: memWhite, black: memBlack },
  });

  // Settle what the two seats actually spent on memory, in one on-chain charge each. A debit
  // taken and never settled is a read the agent got for free, so this runs whatever the game
  // did. `settle()` never throws: an uncollected debit is the platform's problem, not a reason
  // to stall a payout.
  for (const [agentId, session] of [
    [players[0].agentId, memWhite],
    [players[1].agentId, memBlack],
  ] as const) {
    if (session.calls === 0) continue;
    await session
      .settle()
      .catch((err) => console.error(`chess duel ${contestId}: memory settle for agent ${agentId} failed:`, (err as Error).message));
  }

  const winnerSeat = result.winnerSeat;
  const caps = result.caps;

  // Standings score = captured material, with the game winner guaranteed to sort first
  // (a decisive win outranks a bare material count).
  const winnerCap = winnerSeat === 0 ? caps.w : caps.b;
  const loserCap = winnerSeat === 0 ? caps.b : caps.w;
  await recordScore(contestId, players[winnerSeat].agentId, Math.max(winnerCap, loserCap + 1), "captures").catch(() => {});
  await broadcastStandings(contestId).catch(() => {});

  // Payout: the best REAL player. Both real -> the game winner. One real -> that real
  // player (house never takes a real pool). All house on a real host's pool -> cancel.
  const eligibleSeats = (excludeHouse ? ([0, 1] as const).filter((s) => !players[s].isHouse) : ([0, 1] as const)) as (0 | 1)[];
  let payoutSeat: 0 | 1 = eligibleSeats[0] ?? 0;
  if (eligibleSeats.length === 2) payoutSeat = winnerSeat;
  else if (eligibleSeats.length === 1) payoutSeat = eligibleSeats[0]!;
  const payee = players[payoutSeat];
  const canSettle = eligibleSeats.length > 0 && (!payee.isHouse || !excludeHouse);

  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `${players[winnerSeat].agentName} wins by ${result.how}` },
  });

  if (!canSettle) {
    broadcast({ type: "status", contestId, payload: { status: "no-winner" } });
    await cancelContest(contestId);
    return notSettled;
  }

  const scores: AgentScore[] = [
    {
      agentId: payee.agentId,
      operator: payee.operator,
      correct: 1,
      totalLatencyMs: 0,
      computeLevel: tierOf.get(payee.agentId) ?? 0,
    },
  ];
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
  scheduleMemoryUpdates(`chess duel ${contestId}`, players, "chess");
  return finalizeContest(contestId, rankAgents(scores));
}
