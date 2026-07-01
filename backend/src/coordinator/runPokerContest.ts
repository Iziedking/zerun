import { encodeAbiParameters, keccak256 } from "viem";
import { query } from "../db/pool.js";
import { callModel } from "../compute/client.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { computePlan } from "../runners/computeLevels.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { broadcast } from "./ws.js";
import { finalizeContest, cancelContest, type RunResult } from "./finalize.js";
import { onchainEntryCount, syncEntriesFromChain, keepOnchainEntrants } from "./contestOps.js";
import { contestEngineAbi, coordinatorAddress, loadDeployment, publicClient } from "../chain/contracts.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import { shuffle, handLabels } from "../runners/poker/cards.js";
import {
  startHand,
  applyAction,
  viewFor,
  START_STACK,
  type Table,
  type Action,
  type Seat,
} from "../runners/poker/table.js";
import { POKER_SYSTEM, buildUserPrompt, parseAction } from "../runners/poker/decide.js";
import { recordDuel } from "../runners/poker/dossier.js";
import { acquireDossier } from "../runners/poker/x402.js";

// The poker duel loop. Two agents play heads-up No-Limit Hold'em on 0G Compute for
// a fixed window; every decision is a paced inference call and lands on the live
// feed. The deck for each hand is seeded from (contestId, handIndex) so the deal is
// provable. The agent with more chips at the cutoff wins the pool through the same
// settlement path as the other kinds. Only a real player can be paid: if a real
// player loses to a house agent, the contest refunds its sponsor instead.

const MATCH_MS = Number(process.env.POKER_MATCH_SECONDS ?? "300") * 1000;
const MAX_HANDS = Number(process.env.POKER_MAX_HANDS ?? "200");
const DECISION_SPACING_MS = Number(process.env.POKER_DECISION_SPACING_MS ?? "400");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entry {
  agentId: number;
  operator: string;
  agentName: string;
  isHouse: boolean;
}

async function readEntries(contestId: number): Promise<Entry[]> {
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

// The deterministic, verifiable deck seed for a hand.
function handSeed(contestId: number, handIndex: number): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [BigInt(contestId), BigInt(handIndex)],
    ),
  );
}

export async function runPokerContest(contestId: number): Promise<RunResult> {
  const dep = loadDeployment();

  let entries = await readEntries(contestId);
  if (entries.length < 2) {
    // The DB mirror can lag the on-chain registerEntry. The chain is the source of
    // truth, so sync before deciding a duel has no field.
    const onchain = await onchainEntryCount(contestId).catch(() => 0);
    if (onchain > 0) {
      await syncEntriesFromChain(contestId);
      entries = await readEntries(contestId);
    }
  }
  // Only operators that registered on chain may be scored or paid (the audit guard).
  entries = await keepOnchainEntrants(contestId, entries);
  if (entries.length < 2) {
    broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
    await cancelContest(contestId);
    return { contestId, root: null, posted: false, settled: false, payouts: [] };
  }
  // A duel is two seats. If more than two entered, the first two by id play.
  const players: [Entry, Entry] = [entries[0]!, entries[1]!];

  // House agents fill a seat for the feed but are never paid. If a real player is in
  // the duel (or someone else hosted it), the house cannot win the pool.
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
  const planOf = new Map<number, ReturnType<typeof computePlan>>();
  for (const p of players) planOf.set(p.agentId, computePlan(levelOf.get(p.agentId)!));
  // Prefetch each agent's dossier on its opponent before the clock starts, so a
  // scouting read never stalls a hand. The dossier is edge information: how the
  // opponent has played across its past duels.
  const dossierOf = new Map<number, string>();
  for (const seat of [0, 1] as const) {
    const me = players[seat];
    const opponent = players[seat === 0 ? 1 : 0];
    // Free within the agent's tier allotment, otherwise paid for with an x402 tUSDC
    // micropayment on 0G. Either way it resolves here, before the clock starts.
    const access = await acquireDossier(me.agentId, levelOf.get(me.agentId) ?? 0, opponent.agentId).catch(
      () => null,
    );
    if (access?.text) {
      dossierOf.set(me.agentId, access.text);
      const how = access.paid ? `paid ${access.priceUsdc} tUSDC via x402 to scout` : "scouted";
      broadcast({
        type: "status",
        contestId,
        payload: { status: "running", detail: `${me.agentName} ${how} ${opponent.agentName}` },
      });
    }
  }

  await query("update contests_meta set status = 'running' where contest_id = $1", [contestId]);
  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `${players[0].agentName} vs ${players[1].agentName}` },
  });

  let stacks: [number, number] = [START_STACK, START_STACK];
  let button: Seat = 0;
  let handIndex = 0;
  const decisionSeq: [number, number] = [0, 0];
  const matchLog: unknown[] = []; // full replay, stored to 0G Storage in a later phase
  const deadline = Date.now() + MATCH_MS;

  while (Date.now() < deadline && stacks[0] > 0 && stacks[1] > 0 && handIndex < MAX_HANDS) {
    const seed = handSeed(contestId, handIndex);
    const t = startHand(stacks, button, shuffle(seed));
    const handActions: unknown[] = [];

    let guard = 0;
    while (!t.handOver && guard++ < 400) {
      const seat = t.toAct;
      const entry = players[seat];
      const view = viewFor(t);
      const plan = planOf.get(entry.agentId)!;

      let res: Awaited<ReturnType<typeof callModel>> | { text: string; source: string; provider: string; model: string; chatID: string | null; verified: boolean | null; latencyMs: number };
      let action: Action;
      try {
        res = await callModel({
          systemPrompt: POKER_SYSTEM,
          userPrompt: buildUserPrompt(view, dossierOf.get(entry.agentId)),
          maxTokens: plan.maxTokens,
          temperature: plan.temperature,
        });
        action = parseAction(res.text, view.legal);
      } catch (err) {
        console.error(`poker ${contestId}: decision failed for agent ${entry.agentId}:`, (err as Error).message);
        res = { text: "", source: "error", provider: "error", model: "error", chatID: null, verified: null, latencyMs: 0 };
        action = view.legal.canCheck ? { type: "check" } : { type: "call" };
      }

      applyAction(t, action);
      const label = (t.log[t.log.length - 1] ?? "").replace(/^seat \d+ /, "");
      await recordDecision(contestId, entry, decisionSeq[seat]++, view.street, view.holeCards, view.board, label, res);
      handActions.push({ seat, agentId: entry.agentId, action: label, allin: t.stacks[seat] === 0, source: res.source, chatID: res.chatID });
      await sleep(DECISION_SPACING_MS);
    }

    matchLog.push({
      handIndex,
      seed,
      button,
      holes: [handLabels(t.holes[0]), handLabels(t.holes[1])],
      board: handLabels(t.board),
      actions: handActions,
      result: t.result,
      stacksAfter: [t.stacks[0], t.stacks[1]],
    });
    broadcast({
      type: "status",
      contestId,
      payload: {
        status: "running",
        detail: `hand ${handIndex + 1}: ${t.result?.reason ?? "done"} | ${players[0].agentName} ${t.stacks[0]} vs ${players[1].agentName} ${t.stacks[1]}`,
      },
    });

    stacks = [t.stacks[0], t.stacks[1]];
    button = button === 0 ? 1 : 0;
    handIndex += 1;
  }

  // Verifiable replay: store the full match (per hand: seed, hole cards, board, every
  // action with its 0G provenance, and the result) to 0G Storage, so anyone can
  // reconstruct and check the duel from its root hash. Best effort, never blocks the
  // settlement below.
  if (storageConfigured() && matchLog.length > 0) {
    try {
      const up = await uploadJson({ contestId, kind: "poker", finalStacks: stacks, hands: matchLog });
      await query("update contests_meta set poker_root = $2, poker_tx = $3 where contest_id = $1", [
        contestId,
        up.rootHash,
        up.txHash,
      ]);
      broadcast({
        type: "status",
        contestId,
        payload: { status: "running", detail: `replay stored on 0G Storage (${up.rootHash.slice(0, 10)}...)` },
      });
    } catch (err) {
      console.error(`poker ${contestId}: replay storage failed:`, (err as Error).message);
    }
  }

  // Winner by chips; a dead-even stack (e.g. no hand finished) breaks to the higher
  // compute level, then the lower agent id, for full determinism.
  let winnerSeat: Seat;
  if (stacks[0] !== stacks[1]) {
    winnerSeat = stacks[0] > stacks[1] ? 0 : 1;
  } else {
    const l0 = levelOf.get(players[0].agentId) ?? 0;
    const l1 = levelOf.get(players[1].agentId) ?? 0;
    winnerSeat = l0 > l1 ? 0 : l1 > l0 ? 1 : players[0].agentId < players[1].agentId ? 0 : 1;
  }
  const winner = players[winnerSeat];

  // Fold this duel into both agents' dossiers so their record grows for future
  // scouting. A dead-even match credits no duel winner. Best effort.
  await recordDuel(
    matchLog as unknown as Parameters<typeof recordDuel>[0],
    [players[0].agentId, players[1].agentId],
    stacks[0] === stacks[1] ? null : winnerSeat,
  ).catch((err) => console.error(`poker ${contestId}: dossier update failed:`, (err as Error).message));

  // Only a real player can take the pool. If a real player lost to a house agent,
  // refund the sponsor rather than pay the house.
  const eligible = !winner.isHouse || !excludeHouse;
  if (!eligible) {
    broadcast({ type: "status", contestId, payload: { status: "no-winner" } });
    await cancelContest(contestId);
    return { contestId, root: null, posted: false, settled: false, payouts: [] };
  }

  // Winner takes the pool: a single-entry field settles the whole distributable to
  // the duel's winner through the shared merkle payout path.
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
    payload: { status: "running", detail: `${winner.agentName} wins the duel (${stacks[winnerSeat]} chips)` },
  });
  return finalizeContest(contestId, rankAgents(scores));
}

// Persist and broadcast one poker decision, mirroring the solver runner so the same
// feed and audit machinery covers poker. A decision index stands in for puzzle_idx.
async function recordDecision(
  contestId: number,
  entry: Entry,
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
