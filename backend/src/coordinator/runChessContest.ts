import { query } from "../db/pool.js";
import { broadcast } from "./ws.js";
import { cancelContest, finalizeContest, type RunResult } from "./finalize.js";
import { onchainEntryCount, syncEntriesFromChain, keepOnchainEntrants, isUnderfilledDuel } from "./contestOps.js";
import { contestEngineAbi, coordinatorAddress, loadDeployment, publicClient } from "../chain/contracts.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { computePlan } from "../runners/computeLevels.js";
import { callModel } from "../compute/client.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { recordScore, broadcastStandings } from "./standings.js";
import {
  parseFEN,
  toFEN,
  applyMove,
  legalMoves,
  outcome,
  capturedValue,
  repetitionKey,
  sqToAlgebraic,
  START_FEN,
  type Color,
  type Position,
} from "../runners/chess/engine.js";
import { bestCandidates, depthForTier } from "../runners/chess/search.js";
import { CHESS_SYSTEM, buildChessPrompt, parseChessChoice } from "../runners/chess/decide.js";

// The chess duel runner. Two agents play a full game: on each move the engine hands the
// side to move a shortlist of strong candidate moves (search depth scales by tier) and
// the agent reasons on 0G Compute to pick one. A game ends at checkmate (or a draw), or
// at the 300s cap — in which case the side that has captured the most material (by value)
// wins. Winner-take-all through the shared merkle payout, house-rule aware: a house agent
// can win the game on the board but the pot always routes to the best real player.

const MATCH_MS = Number(process.env.CHESS_MATCH_SECONDS ?? "300") * 1000;
const MAX_PLY = Number(process.env.CHESS_MAX_PLY ?? "300");
const CANDIDATES = Number(process.env.CHESS_CANDIDATES ?? "3");
const MIN_MOVE_MS = Number(process.env.CHESS_MIN_MOVE_MS ?? "300");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// One move: engine candidates, then the agent's 0G pick (falling back to the engine's
// best on any failure). Returns the chosen move plus a feed line and its provenance.
async function decideMove(
  pos: Position,
  tier: number,
  models: string[] | undefined,
): Promise<{ uci: string; reason: string; source: string; provider: string; model: string; chatID: string | null; verified: boolean | null; latencyMs: number }> {
  const candidates = bestCandidates(pos, depthForTier(tier), CANDIDATES);
  const youAre: "white" | "black" = pos.turn === "w" ? "white" : "black";
  try {
    const res = await callModel({
      systemPrompt: CHESS_SYSTEM,
      userPrompt: buildChessPrompt(pos, candidates, youAre),
      maxTokens: 48,
      temperature: 0.3,
      models,
    });
    const { pick, matched } = parseChessChoice(res.text, candidates);
    const reason = matched ? (res.text.split("\n").slice(1).join(" ").trim() || `plays ${pick.uci}`) : `plays ${pick.uci}`;
    return {
      uci: pick.uci,
      reason: reason.slice(0, 120),
      source: res.source,
      provider: res.provider,
      model: res.model,
      chatID: res.chatID,
      verified: res.verified,
      latencyMs: res.latencyMs,
    };
  } catch (err) {
    // 0G unavailable this move: play the engine's best so the game always progresses.
    const best = candidates[0]!;
    return {
      uci: best.uci,
      reason: `engine plays ${best.uci}`,
      source: "engine",
      provider: "deterministic",
      model: `tier-${Math.max(0, Math.min(5, Math.floor(tier)))}-search`,
      chatID: null,
      verified: null,
      latencyMs: 0,
    };
  }
}

function moveByUci(pos: Position, uci: string) {
  const from = (uci.charCodeAt(0) - 97) + (Number(uci[1]) - 1) * 8;
  const to = (uci.charCodeAt(2) - 97) + (Number(uci[3]) - 1) * 8;
  const promo = uci.length > 4 ? (uci[4] as "q" | "r" | "b" | "n") : undefined;
  return legalMoves(pos).find((m) => m.from === from && m.to === to && (m.promo ?? "") === (promo ?? ""));
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

  // A duel is the first two entrants: white then black.
  const players: [Player, Player] = [entries[0]!, entries[1]!];
  const excludeHouse = await excludeHouseFor(contestId, players);
  const tierOf = new Map<number, number>();
  for (const p of players) tierOf.set(p.agentId, await getAgentCompute(p.agentId));

  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `${players[0].agentName} (white) vs ${players[1].agentName} (black)` },
  });

  let pos = parseFEN(START_FEN);
  const seen = new Map<string, number>();
  const matchLog: unknown[] = [];
  let ply = 0;
  const deadline = Date.now() + MATCH_MS;
  console.log(`chess ${contestId}: match start, ${players[0].agentName} vs ${players[1].agentName}, cap ${MATCH_MS / 1000}s / ${MAX_PLY} ply`);

  try {
    while (ply < MAX_PLY && Date.now() < deadline) {
      const key = repetitionKey(pos);
      const repeats = (seen.get(key) ?? 0) + 1;
      seen.set(key, repeats);
      const oc = outcome(pos, repeats);
      if (oc.over) break;

      const color: Color = pos.turn;
      const seat = color === "w" ? 0 : 1;
      const mover = players[seat];
      const tier = tierOf.get(mover.agentId) ?? 0;
      const plan = computePlan(tier);

      const decided = await decideMove(pos, tier, plan.models);
      const move = moveByUci(pos, decided.uci) ?? legalMoves(pos)[0]!;
      const captured = pos.board[move.to] !== "";
      pos = applyMove(pos, move);
      ply += 1;

      const caps = capturedValue(pos);
      // Best-effort feed + audit; never throw out of the match loop.
      try {
        broadcast({
          type: "chess",
          contestId,
          payload: {
            fen: toFEN(pos),
            ply,
            lastMove: decided.uci,
            lastFrom: sqToAlgebraic(move.from),
            lastTo: sqToAlgebraic(move.to),
            capture: captured,
            mover: { agentId: mover.agentId, agentName: mover.agentName, operator: mover.operator, color },
            reason: decided.reason,
            provider: decided.provider,
            model: decided.model,
            chatID: decided.chatID,
            verified: decided.verified,
            latencyMs: decided.latencyMs,
            source: decided.source,
            captures: caps,
            turn: pos.turn,
          },
        });
        await query(
          `insert into solve_runs
             (contest_id, agent_id, operator, puzzle_idx, prompt, expected, answer, verdict, source, provider, model, chat_id, verified, latency_ms, samples, sources)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           on conflict (contest_id, agent_id, puzzle_idx) do update set answer = excluded.answer`,
          [contestId, mover.agentId, mover.operator, ply, "chess move", null, decided.uci, "move", decided.source, decided.provider, decided.model, decided.chatID, decided.verified, decided.latencyMs, 1, 0],
        );
        // Live captured-material standings each move.
        await recordScore(contestId, players[0].agentId, caps.w, "captures");
        await recordScore(contestId, players[1].agentId, caps.b, "captures");
        await broadcastStandings(contestId).catch(() => {});
      } catch (err) {
        console.error(`chess ${contestId}: record/broadcast move failed:`, (err as Error).message);
      }
      matchLog.push({ ply, uci: decided.uci, source: decided.source });
      if (MIN_MOVE_MS > 0) await sleep(MIN_MOVE_MS);
    }
  } catch (err) {
    console.error(`chess ${contestId}: match loop error, settling on state so far:`, (err as Error).message);
  }

  // Decide the game winner. Checkmate is decisive; otherwise the most captured material
  // (by value) wins, breaking a tie by higher tier then lower agent id.
  const key = repetitionKey(pos);
  const finalOutcome = outcome(pos, seen.get(key) ?? 1);
  const caps = capturedValue(pos);
  let winnerSeat: 0 | 1;
  let how: string;
  if (finalOutcome.over && finalOutcome.result === "checkmate" && finalOutcome.winner) {
    winnerSeat = finalOutcome.winner === "w" ? 0 : 1;
    how = "checkmate";
  } else if (caps.w !== caps.b) {
    winnerSeat = caps.w > caps.b ? 0 : 1;
    how = finalOutcome.over ? "material (draw)" : "material (time)";
  } else {
    const t0 = tierOf.get(players[0].agentId) ?? 0;
    const t1 = tierOf.get(players[1].agentId) ?? 0;
    winnerSeat = t0 > t1 ? 0 : t1 > t0 ? 1 : players[0].agentId <= players[1].agentId ? 0 : 1;
    how = "even, decided by tier";
  }

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
    payload: { status: "running", detail: `${players[winnerSeat].agentName} wins by ${how}` },
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
  return finalizeContest(contestId, rankAgents(scores));
}
