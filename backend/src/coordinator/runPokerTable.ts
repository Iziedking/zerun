import { encodeAbiParameters, keccak256 } from "viem";
import { query } from "../db/pool.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { broadcast } from "./ws.js";
import { recordScore, broadcastStandings } from "./standings.js";
import { recordTableResult } from "../runners/poker/ratings.js";
import { finalizeContest, cancelContest, type RunResult } from "./finalize.js";
import { contestEngineAbi, coordinatorAddress, loadDeployment, publicClient } from "../chain/contracts.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import { shuffle, handLabels, cardLabel } from "../runners/poker/cards.js";
import { startHand, applyAction, viewFor, type MultiTable } from "../runners/poker/multi.js";
import type { Action } from "../runners/poker/table.js";
import { decideStrategy } from "../runners/poker/strategy.js";

// Multi-player (up to 6-max) poker table. Two-seat duels stay on the heads-up path;
// runPokerContest hands off here when three or more agents entered. Same shape as the
// duel runner: every decision comes from the deterministic, tier-scaled strategy
// engine (the 0G-hybrid grind — strategy authored on 0G, then played at machine
// speed), so a table always terminates instead of hanging on per-move inference. The
// seeded deck makes each deal provable, the full match is stored to 0G Storage, and
// the chip leader at the cutoff takes the pool. Only a real player can be paid.

const MATCH_MS = Number(process.env.POKER_MATCH_SECONDS ?? "300") * 1000;
// Same cap as the duel: the match ends at the cap with the chip leader ahead on a
// real split, instead of grinding until someone busts and the table reads all-or-zero.
const MAX_HANDS = Number(process.env.POKER_MAX_HANDS ?? "50");
// How long a spectator gets to read each action before the next one lands.
//
// Poker decisions here are DETERMINISTIC: the strategy engine answers in ~0ms, so nothing in
// the game paces itself. At 400ms a six-handed street resolved in under two seconds and the
// table read as a flicker, then sat still. The wait is not the problem a spectator has -- the
// jitter is. Roughly a second per action, and a longer beat when the board turns, gives the
// eye somewhere to land and makes the same hand feel calm AND fast.
const DECISION_SPACING_MS = Number(process.env.POKER_DECISION_SPACING_MS ?? "900");
// The beat when a street ends and the board changes. A new card is the biggest event on the
// felt and it deserves its own moment, rather than arriving under someone else's action.
const STREET_BEAT_MS = Number(process.env.POKER_STREET_BEAT_MS ?? "1400");
const MAX_SEATS = 6;
const START_STACK = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TableEntry {
  agentId: number;
  operator: string;
  agentName: string;
  isHouse: boolean;
}

function handSeed(contestId: number, handIndex: number): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(contestId), BigInt(handIndex)]),
  );
}

export async function runPokerTable(contestId: number, entries: TableEntry[]): Promise<RunResult> {
  const dep = loadDeployment();
  const players = entries.slice(0, MAX_SEATS);
  const n = players.length;

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

  const levelOf = new Map<number, number>();
  for (const p of players) levelOf.set(p.agentId, await getAgentCompute(p.agentId));

  // A recovered table (already 'running' when we start): the match is deterministic
  // from its seeds, so replay at machine speed instead of another real-time run. This
  // is what lets a table survive a backend restart mid-match and still settle promptly.
  const { rows: stRows } = await query<{ status: string }>(
    "select status from contests_meta where contest_id = $1",
    [contestId],
  );
  const spacingMs = stRows[0]?.status === "running" ? 0 : DECISION_SPACING_MS;

  await query("update contests_meta set status = 'running' where contest_id = $1", [contestId]);
  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `${n}-max poker table: ${players.map((p) => p.agentName).join(", ")}` },
  });

  // Cash-game format: every hand each seat buys in for a fresh START_STACK, so nobody
  // busts out of the table and the result is a cumulative chip profit/loss (net) over
  // the whole session, not an all-or-nothing knockout. This gives a real chip
  // distribution across the field and lets the stronger tiers pull ahead over many
  // hands instead of a single hand deciding everything.
  const net = new Array(n).fill(0) as number[];
  let button = 0;
  let handIndex = 0;
  const decisionSeq = new Array(n).fill(0) as number[];
  const matchLog: unknown[] = [];
  const deadline = Date.now() + MATCH_MS;

  console.log(`poker table ${contestId}: match start, ${n} seats, cap ${MAX_HANDS} hands / ${MATCH_MS / 1000}s`);
  // The whole match is wrapped so that ANY unexpected error still falls through to
  // settlement with the net accumulated so far, rather than throwing out of the runner
  // and leaving the contest to be stale-cancelled. A settled short match beats a
  // cancelled one; the deterministic hands already played are a valid result.
  try {
  while (Date.now() < deadline && handIndex < MAX_HANDS) {
    const t = startHand(new Array(n).fill(START_STACK), button, shuffle(handSeed(contestId, handIndex)));
    const handActions: unknown[] = [];

    let guard = 0;
    let shownStreet = t.street;
    while (!t.handOver && guard++ < 2000) {
      // The board just turned. Broadcast the new street on its own, hold it, and only then let
      // the next player act. Without this the flop lands silently inside whichever action
      // happened to follow it, and a spectator never sees the cards arrive.
      if (t.street !== shownStreet) {
        shownStreet = t.street;
        if (spacingMs > 0) {
          try {
            broadcast({ type: "poker", contestId, payload: tableSnapshot(t, players, handIndex) });
          } catch {
            /* cosmetic only; never break the hand loop */
          }
          await sleep(STREET_BEAT_MS);
        }
      }
      const seat = t.toAct;
      const entry = players[seat]!;
      const view = viewFor(t);
      const tier = levelOf.get(entry.agentId) ?? 0;
      const dseq = decisionSeq[seat] ?? 0;

      // The deterministic, tier-scaled decision — same engine as the duel. No network
      // call, so a full table always terminates, and the seed makes every choice
      // reproducible from (contestId, handIndex, seat, decisionIndex).
      let action: Action;
      let reason: string;
      try {
        const decision = decideStrategy({
          hole: t.holes[seat]!,
          board: t.board,
          legal: view.legal,
          pot: view.pot,
          toCall: view.legal.callAmount,
          street: t.street,
          inPosition: seat === t.button, // the button acts last postflop
          tier,
          // Equity is judged against everyone still in the hand, so a full table demands
          // stronger hands than a heads-up pot. This is what keeps the tiers ordered
          // multiway instead of aggressive tiers stacking off into the field.
          opponents: Math.max(1, t.folded.filter((f) => !f).length - 1),
          seed: (contestId * 1_000_003 + handIndex * 131 + seat * 17 + dseq) >>> 0,
        });
        action = decision.action;
        reason = decision.reason;
      } catch (err) {
        console.error(`poker table ${contestId}: strategy error for agent ${entry.agentId}:`, (err as Error).message);
        action = view.legal.canCheck ? { type: "check" } : { type: "call" };
        reason = "safe default";
      }
      const clampedTier = Math.max(0, Math.min(5, Math.floor(tier)));
      const res = {
        text: reason,
        source: "strategy",
        provider: "deterministic",
        model: `tier-${clampedTier}-policy`,
        chatID: null,
        verified: null,
        latencyMs: 0,
      };

      applyAction(t, action);
      const label = (t.log[t.log.length - 1] ?? "").replace(/^seat \d+ /, "");
      const di = decisionSeq[seat] ?? 0;
      decisionSeq[seat] = di + 1;
      // The game state (t) is already advanced by applyAction above, so recording the
      // decision and broadcasting the live view are purely cosmetic side effects. Guard
      // them: a DB hiccup or a broadcast error must never throw out of the match loop and
      // leave the contest unsettled (it would then only be stale-cancelled). Best effort.
      try {
        await recordDecision(contestId, entry, di, view.street, view.holeCards, view.board, label, res);
        broadcast({
          type: "poker",
          contestId,
          payload: tableSnapshot(t, players, handIndex, {
            agentId: entry.agentId,
            name: entry.agentName,
            action: label,
            reasoning: res.text,
            chatID: res.chatID,
          }),
        });
      } catch (err) {
        console.error(`poker table ${contestId}: decision record/broadcast failed (continuing):`, (err as Error).message);
      }
      handActions.push({ seat, agentId: entry.agentId, action: label, allin: t.stacks[seat] === 0, source: res.source, chatID: res.chatID });
      if (spacingMs > 0) await sleep(spacingMs);
    }

    matchLog.push({
      handIndex,
      button,
      board: handLabels(t.board),
      actions: handActions,
      pots: t.pots,
      stacksAfter: [...t.stacks],
    });
    // Fold each seat's win/loss for this hand into its running net.
    for (let s = 0; s < n; s++) net[s] = net[s]! + (t.stacks[s]! - START_STACK);
    // Reveal live net chips in the standings after each hand. Best effort.
    try {
      for (let s = 0; s < n; s++) await recordScore(contestId, players[s]!.agentId, net[s]!, "chips");
      await broadcastStandings(contestId);
    } catch {
      /* standings are cosmetic mid-match; the settle path recomputes them */
    }
    // Rotate the button one seat; every seat is always in (cash game), so no skip.
    button = (button + 1) % n;
    handIndex += 1;
  }
  } catch (err) {
    console.error(`poker table ${contestId}: match loop aborted at hand ${handIndex}, settling with net so far:`, (err as Error).message);
  }
  console.log(`poker table ${contestId}: match done after ${handIndex} hands, settling`);

  // Real operators always place above house agents. When house is excluded from the
  // prize (the normal case, any real player in the field), the winner is the best real
  // player by net chips, not the overall chip leader: a house agent stays competitive
  // but can never take the pool from a real operator, and the contest still pays out
  // rather than cancelling when a house agent happens to run hottest. Only when there is
  // no real player to place (an all-house table) does it fall through to a cancel below.
  const eligibleSeats = (excludeHouse ? players.map((_, s) => s).filter((s) => !players[s]!.isHouse) : players.map((_, s) => s));
  let winnerSeat = eligibleSeats[0] ?? 0;
  for (const s of eligibleSeats) {
    if (
      net[s]! > net[winnerSeat]! ||
      (net[s]! === net[winnerSeat]! && (levelOf.get(players[s]!.agentId) ?? 0) > (levelOf.get(players[winnerSeat]!.agentId) ?? 0))
    ) {
      winnerSeat = s;
    }
  }
  const winner = players[winnerSeat]!;

  // Update the TrueSkill ladder from the final chip ranking (best first), so a table
  // feeds the same season leaderboard as a duel. Best effort. Ties break by the same
  // compute-then-id order the winner pick uses, which is deterministic and fine here.
  const ranking = players
    .map((p, seat) => ({
      id: p.agentId,
      isHouse: p.isHouse,
      chips: net[seat] ?? 0,
      level: levelOf.get(p.agentId) ?? 0,
    }))
    .sort((a, b) => b.chips - a.chips || b.level - a.level || a.id - b.id)
    .map((x) => ({ id: x.id, isHouse: x.isHouse }));
  await recordTableResult(ranking).catch((err) =>
    console.error(`poker table ${contestId}: ladder update failed:`, (err as Error).message),
  );

  // Eligible only when there is a real player to place (or house is allowed to win a
  // coordinator-funded demo pool). An all-house field with a real sponsor cancels.
  const eligible = eligibleSeats.length > 0 && (!winner.isHouse || !excludeHouse);
  if (!eligible) {
    console.log(`poker table ${contestId}: no eligible real winner (real seats: ${eligibleSeats.length}, excludeHouse: ${excludeHouse}), cancelling`);
    broadcast({ type: "status", contestId, payload: { status: "no-winner" } });
    await cancelContest(contestId);
    await storeTableReplay(contestId, n, net, matchLog);
    return { contestId, root: null, posted: false, settled: false, payouts: [] };
  }
  console.log(`poker table ${contestId}: winner ${winner.agentName} (seat ${winnerSeat}, ${net[winnerSeat]} net), finalizing`);

  const scores: AgentScore[] = [
    {
      agentId: winner.agentId,
      operator: winner.operator,
      correct: 1,
      totalLatencyMs: 0,
      computeLevel: levelOf.get(winner.agentId) ?? 0,
    },
  ];
  broadcast({
    type: "status",
    contestId,
    payload: {
      status: "running",
      detail: `${winner.agentName} wins the table (${net[winnerSeat]! >= 0 ? "+" : ""}${net[winnerSeat]} chips over ${handIndex} hands)`,
    },
  });
  // Settle first, so paying the winner never waits on 0G Storage. The verifiable
  // replay upload comes after and is best effort and time-bounded.
  const result = await finalizeContest(contestId, rankAgents(scores));
  console.log(`poker table ${contestId}: finalize ${result.settled ? "settled" : result.posted ? "posted (settle pending)" : "did not settle"}`);
  await storeTableReplay(contestId, n, net, matchLog);
  return result;
}

// A snapshot of the multi-way table after an action, for the live round-table view.
// Every seat's hole cards are shown to spectators (it is AI, and it makes the table
// watchable); a folded seat is dimmed, the acting seat is highlighted. Same payload
// shape as the heads-up duel so one PokerTable component renders both.
function tableSnapshot(
  t: MultiTable,
  players: TableEntry[],
  handIndex: number,
  // Omitted for the street beat, which is a board change rather than anybody's move: carrying
  // the previous player's action into it would re-announce a move that already happened.
  lastAction?: { agentId: number; name: string; action: string; reasoning: string; chatID: string | null },
) {
  const streets = ["preflop", "flop", "turn", "river"];
  const seats = players.map((p, s) => ({
    agentId: p.agentId,
    name: p.agentName,
    chips: t.stacks[s] ?? 0,
    holeCards: (t.holes[s] ?? []).map(cardLabel),
    folded: Boolean(t.folded[s]),
    isTurn: !t.handOver && t.toAct === s,
    isHouse: p.isHouse,
  }));
  return {
    handIndex: handIndex + 1,
    street: streets[t.street] ?? "preflop",
    board: t.board.map(cardLabel),
    pot: t.committed.reduce((a, b) => a + b, 0),
    seats,
    lastAction,
  };
}

// Store the full table match to 0G Storage for verifiable replay. Best effort and
// time-bounded: a failure or timeout only logs, never unsettling a paid contest.
async function storeTableReplay(contestId: number, seats: number, net: number[], matchLog: unknown[]): Promise<void> {
  if (!storageConfigured() || matchLog.length === 0) return;
  try {
    const up = await uploadJson({ contestId, kind: "poker", seats, finalNet: net, hands: matchLog });
    await query("update contests_meta set poker_root = $2, poker_tx = $3 where contest_id = $1", [contestId, up.rootHash, up.txHash]);
  } catch (err) {
    console.error(`poker table ${contestId}: replay storage failed:`, (err as Error).message);
  }
}

async function recordDecision(
  contestId: number,
  entry: TableEntry,
  decisionIdx: number,
  street: string,
  holeCards: string,
  board: string,
  actionLabel: string,
  res: { text: string; source: string; provider: string; model: string; chatID: string | null; verified: boolean | null; latencyMs: number },
): Promise<void> {
  const prompt = `${street}: ${holeCards}${board ? ` on ${board}` : ""}`;
  await query(
    `insert into solve_runs
       (contest_id, agent_id, operator, puzzle_idx, prompt, expected, answer, verdict, source, provider, model, chat_id, verified, latency_ms, samples, agreement)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (contest_id, agent_id, puzzle_idx) do update set
       answer = excluded.answer, verdict = excluded.verdict, source = excluded.source,
       provider = excluded.provider, model = excluded.model, chat_id = excluded.chat_id,
       verified = excluded.verified, latency_ms = excluded.latency_ms`,
    [
      contestId, entry.agentId, entry.operator, decisionIdx, prompt, null,
      actionLabel, "action", res.source, res.provider, res.model,
      res.chatID, res.verified, res.latencyMs, null, null,
    ],
  );
  broadcast({
    type: "solve",
    contestId,
    payload: {
      agentId: entry.agentId,
      agentName: entry.agentName,
      operator: entry.operator,
      puzzleIdx: decisionIdx,
      prompt,
      answer: actionLabel,
      verdict: "action",
      source: res.source,
      provider: res.provider,
      model: res.model,
      chatID: res.chatID,
      verified: res.verified,
      latencyMs: res.latencyMs,
    },
  });
}
