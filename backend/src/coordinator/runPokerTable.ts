import { encodeAbiParameters, keccak256 } from "viem";
import { query } from "../db/pool.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { broadcast } from "./ws.js";
import { recordScore, broadcastStandings } from "./standings.js";
import { finalizeContest, cancelContest, type RunResult } from "./finalize.js";
import { contestEngineAbi, coordinatorAddress, loadDeployment, publicClient } from "../chain/contracts.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import { shuffle, handLabels } from "../runners/poker/cards.js";
import { startHand, applyAction, viewFor } from "../runners/poker/multi.js";
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
const MAX_HANDS = Number(process.env.POKER_MAX_HANDS ?? "40");
const DECISION_SPACING_MS = Number(process.env.POKER_DECISION_SPACING_MS ?? "400");
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

  let stacks = new Array(n).fill(START_STACK) as number[];
  let button = 0;
  let handIndex = 0;
  const decisionSeq = new Array(n).fill(0) as number[];
  const matchLog: unknown[] = [];
  const deadline = Date.now() + MATCH_MS;

  const withChips = () => stacks.filter((s) => s > 0).length;

  while (Date.now() < deadline && withChips() >= 2 && handIndex < MAX_HANDS) {
    const t = startHand(stacks, button, shuffle(handSeed(contestId, handIndex)));
    const handActions: unknown[] = [];

    let guard = 0;
    while (!t.handOver && guard++ < 2000) {
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
      await recordDecision(contestId, entry, di, view.street, view.holeCards, view.board, label, res);
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
    stacks = [...t.stacks];
    // Reveal live chip stacks in the standings after each hand. Best effort.
    try {
      for (let s = 0; s < n; s++) await recordScore(contestId, players[s]!.agentId, stacks[s]!, "chips");
      await broadcastStandings(contestId);
    } catch {
      /* standings are cosmetic mid-match; the settle path recomputes them */
    }
    // Move the button to the next seat that still has chips.
    for (let i = 1; i <= n; i++) {
      const nb = (button + i) % n;
      if (stacks[nb]! > 0) {
        button = nb;
        break;
      }
    }
    handIndex += 1;
  }

  // Chip leader takes the pool; a house leader with a real player in the field means
  // the real players lost, so refund the sponsor.
  let winnerSeat = 0;
  for (let s = 1; s < n; s++) {
    if (
      stacks[s]! > stacks[winnerSeat]! ||
      (stacks[s]! === stacks[winnerSeat]! && (levelOf.get(players[s]!.agentId) ?? 0) > (levelOf.get(players[winnerSeat]!.agentId) ?? 0))
    ) {
      winnerSeat = s;
    }
  }
  const winner = players[winnerSeat]!;

  const eligible = !winner.isHouse || !excludeHouse;
  if (!eligible) {
    broadcast({ type: "status", contestId, payload: { status: "no-winner" } });
    await cancelContest(contestId);
    await storeTableReplay(contestId, n, stacks, matchLog);
    return { contestId, root: null, posted: false, settled: false, payouts: [] };
  }

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
    payload: { status: "running", detail: `${winner.agentName} wins the table (${stacks[winnerSeat]} chips)` },
  });
  // Settle first, so paying the winner never waits on 0G Storage. The verifiable
  // replay upload comes after and is best effort and time-bounded.
  const result = await finalizeContest(contestId, rankAgents(scores));
  await storeTableReplay(contestId, n, stacks, matchLog);
  return result;
}

// Store the full table match to 0G Storage for verifiable replay. Best effort and
// time-bounded: a failure or timeout only logs, never unsettling a paid contest.
async function storeTableReplay(contestId: number, seats: number, stacks: number[], matchLog: unknown[]): Promise<void> {
  if (!storageConfigured() || matchLog.length === 0) return;
  try {
    const up = await uploadJson({ contestId, kind: "poker", seats, finalStacks: stacks, hands: matchLog });
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
