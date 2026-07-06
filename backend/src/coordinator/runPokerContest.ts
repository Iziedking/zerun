import { encodeAbiParameters, keccak256 } from "viem";
import { query } from "../db/pool.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { broadcast } from "./ws.js";
import { recordScore, broadcastStandings } from "./standings.js";
import { finalizeContest, cancelContest, type RunResult } from "./finalize.js";
import { onchainEntryCount, syncEntriesFromChain, keepOnchainEntrants } from "./contestOps.js";
import { contestEngineAbi, coordinatorAddress, loadDeployment, publicClient } from "../chain/contracts.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import { shuffle, handLabels, cardLabel } from "../runners/poker/cards.js";
import {
  startHand,
  applyAction,
  viewFor,
  START_STACK,
  type Table,
  type Action,
  type Seat,
} from "../runners/poker/table.js";
import { decideStrategy, policyForTier, type Policy } from "../runners/poker/strategy.js";
import { recordDuel, buildDossier, type PokerStats } from "../runners/poker/dossier.js";
import { acquireDossier } from "../runners/poker/x402.js";
import { runPokerTable } from "./runPokerTable.js";

// The poker duel loop. Two agents play heads-up No-Limit Hold'em over a bounded
// number of hands, each decision resolved by the deterministic, tier-scaled strategy
// engine (the 0G-hybrid grind: strategy authored once on 0G, then played out at
// machine speed). Retiring the old per-move 0G call is what makes a match always
// terminate instead of hanging under the rate limit. The deck for each hand is seeded
// from (contestId, handIndex) so the deal is provable, and the decisions replay
// exactly from the same seeds and each agent's tier. The agent with more chips at the
// cutoff wins the pool through the shared settlement path. Only a real player can be
// paid: if a real player loses to a house agent, the contest refunds its sponsor.

const MATCH_MS = Number(process.env.POKER_MATCH_SECONDS ?? "300") * 1000;
// The hand cap is the NORMAL way a match ends, not a safety net. At blinds 10/20 on
// 1000 stacks, two deterministic bots reach an all-in clash long before 200 hands, so
// a big cap meant nearly every duel finished in a bust and the standings always read
// 2000/0. A short fixed cap ends the match with the chip leader ahead on a real split
// (e.g. 1240/760); a bust can still end it early, but is the exception.
const MAX_HANDS = Number(process.env.POKER_MAX_HANDS ?? "40");
// A small pause between decisions keeps the live duel watchable. Decisions are now
// instant, so this is purely cosmetic pacing, not a rate-limit workaround.
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

// Turn a scouted opponent's tendencies into a small, bounded tweak to our own
// policy. Against a loose or aggressive opponent, whose bets are less credible, we
// relax our call discipline a touch (call wider); against a tight, passive one we
// tighten. The shift is capped at +-0.03 so intel is an edge, not a cheat, and never
// rewrites a tier's fundamentals. Null when the sample is too thin to trust.
function scoutOverride(tier: number, opp: PokerStats): Partial<Policy> | null {
  const decisions = opp.folds + opp.checks + opp.calls + opp.raises;
  if (opp.hands < 20 || decisions === 0) return null;
  const foldPct = opp.folds / decisions;
  const af = opp.raises / Math.max(1, opp.calls);
  let d = 0;
  if (foldPct < 0.15) d -= 0.02;
  else if (foldPct > 0.4) d += 0.02;
  if (af > 1.5) d -= 0.01;
  else if (af < 0.6) d += 0.01;
  d = Math.max(-0.03, Math.min(0.03, d));
  if (d === 0) return null;
  return { callMarginBase: policyForTier(tier).callMarginBase + d };
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
  // Three or more agents make a multi-player table; hand off to that runner. Two
  // seats stay on the proven heads-up path below.
  if (entries.length > 2) return runPokerTable(contestId, entries);
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

  // A recovered match: this contest already started running once (the process
  // restarted mid-match, or the sweeper picked it up again). The duel is fully
  // deterministic from its seeds, so replay it at machine speed with no cosmetic
  // pacing, and do not pay or broadcast scouting again — the first run already did.
  // Without this, every backend restart replayed in-flight duels in real time (5 more
  // minutes each) and re-paid the x402 scout, flooding the feed with duplicate
  // payments and making matches look like they never end.
  const { rows: stRows } = await query<{ status: string }>(
    "select status from contests_meta where contest_id = $1",
    [contestId],
  );
  const recovered = stRows[0]?.status === "running";
  const spacingMs = recovered ? 0 : DECISION_SPACING_MS;

  // Prefetch each agent's dossier on its opponent before the clock starts, so a
  // scouting read never stalls a hand. The dossier is edge information: how the
  // opponent has played across its past duels.
  // Scouting no longer feeds a prompt; it tunes the buyer's opponent model. A
  // scouted agent gets a small, bounded policy tweak against this specific opponent.
  const overrideOf = new Map<number, Partial<Policy>>();
  for (const seat of [0, 1] as const) {
    const me = players[seat];
    const opponent = players[seat === 0 ? 1 : 0];
    if (recovered) {
      // Rebuild the same opponent model without a second payment: the override
      // derives from the opponent's stats, so the replayed decisions match.
      const d = await buildDossier(opponent.agentId).catch(() => null);
      if (d?.stats) {
        const ov = scoutOverride(levelOf.get(me.agentId) ?? 0, d.stats);
        if (ov) overrideOf.set(me.agentId, ov);
      }
      continue;
    }
    // Free within the agent's tier allotment, otherwise paid for with an x402 tUSDC
    // micropayment on 0G. Either way it resolves here, before the clock starts.
    const access = await acquireDossier(me.agentId, levelOf.get(me.agentId) ?? 0, opponent.agentId).catch(
      () => null,
    );
    if (access?.text) {
      if (access.stats) {
        const ov = scoutOverride(levelOf.get(me.agentId) ?? 0, access.stats);
        if (ov) overrideOf.set(me.agentId, ov);
      }
      const how = access.paid ? `paid ${access.priceUsdc} tUSDC via x402 to scout` : "scouted";
      broadcast({
        type: "status",
        contestId,
        payload: { status: "running", detail: `${me.agentName} ${how} ${opponent.agentName}` },
      });
      // Surface a paid dossier as a verifiable x402 event with its on-chain tx.
      if (access.paid && access.txHash) {
        broadcast({
          type: "x402",
          contestId,
          payload: {
            agentId: me.agentId,
            agentName: me.agentName,
            opponentName: opponent.agentName,
            priceUsdc: access.priceUsdc ?? "0.5",
            txHash: access.txHash,
          },
        });
      }
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
      const tier = levelOf.get(entry.agentId) ?? 0; // policyForTier clamps to 0..5
      const dseq = decisionSeq[seat];

      // The deterministic, tier-scaled decision. No network call, so a hand resolves
      // instantly and a match always terminates. The seed makes bluff and semibluff
      // rolls reproducible from (contestId, handIndex, seat, decisionIndex), so the
      // whole duel replays exactly from its stored seeds.
      type Res = { text: string; source: string; provider: string; model: string; chatID: string | null; verified: boolean | null; latencyMs: number };
      let action: Action;
      let reason: string;
      try {
        const decision = decideStrategy({
          hole: t.holes[seat],
          board: t.board,
          legal: view.legal,
          pot: t.handPut[0] + t.handPut[1],
          toCall: view.legal.callAmount,
          street: t.street,
          inPosition: seat === t.button, // heads-up: the button has position postflop
          tier,
          seed: (contestId * 1_000_003 + handIndex * 131 + seat * 17 + dseq) >>> 0,
          // Scouted opponent model now; P3 folds in a 0G-authored policy anchored on 0G Storage.
          policyOverride: overrideOf.get(entry.agentId),
        });
        action = decision.action;
        reason = decision.reason;
      } catch (err) {
        console.error(`poker ${contestId}: strategy error for agent ${entry.agentId}:`, (err as Error).message);
        action = view.legal.canCheck ? { type: "check" } : { type: "call" };
        reason = "safe default";
      }
      const clampedTier = Math.max(0, Math.min(5, Math.floor(tier)));
      const res: Res = {
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
      // The agent's 0G reasoning, minus the trailing ACTION directive, for the feed.
      const reasoning = (res.text ?? "").replace(/\bACTION:.*$/is, "").trim().slice(0, 240);
      await recordDecision(contestId, entry, decisionSeq[seat]++, view.street, view.holeCards, view.board, label, res, reasoning);
      broadcast({
        type: "poker",
        contestId,
        payload: snapshot(t, players, handIndex, {
          agentId: entry.agentId,
          name: entry.agentName,
          action: label,
          reasoning,
          chatID: res.chatID,
        }),
      });
      handActions.push({ seat, agentId: entry.agentId, action: label, allin: t.stacks[seat] === 0, source: res.source, chatID: res.chatID });
      if (spacingMs > 0) await sleep(spacingMs);
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
    // Reveal the live chip stacks in the standings: chips are what decides the duel,
    // so the table ranks on them and updates hand by hand instead of showing zeroes.
    // Best effort: a standings write must never kill a live match.
    try {
      await recordScore(contestId, players[0].agentId, t.stacks[0], "chips");
      await recordScore(contestId, players[1].agentId, t.stacks[1], "chips");
      await broadcastStandings(contestId);
    } catch {
      /* standings are cosmetic mid-match; the settle path recomputes them */
    }
    button = button === 0 ? 1 : 0;
    handIndex += 1;
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
    await storePokerReplay(contestId, stacks, matchLog);
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
  // Settle first, so paying the winner never waits on 0G Storage. The verifiable
  // replay upload comes after and is best effort, so a slow or stalled upload can no
  // longer leave a finished match stuck unsettled.
  const result = await finalizeContest(contestId, rankAgents(scores));
  await storePokerReplay(contestId, stacks, matchLog);
  return result;
}

// Store the full match (per hand: seed, hole cards, board, every action with its 0G
// provenance, and the result) to 0G Storage, so anyone can reconstruct and check the
// duel from its root hash. Best effort and time-bounded: a failure or timeout only
// logs, and never unsettles a contest that already paid out.
async function storePokerReplay(contestId: number, stacks: number[], matchLog: unknown[]): Promise<void> {
  if (!storageConfigured() || matchLog.length === 0) return;
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
      payload: { status: "settled", detail: `replay stored on 0G Storage (${up.rootHash.slice(0, 10)}...)` },
    });
  } catch (err) {
    console.error(`poker ${contestId}: replay storage failed:`, (err as Error).message);
  }
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
  reasoning: string,
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
      reasoning,
    },
  });
}

// A snapshot of the heads-up table after an action, for the live poker view. Both
// hole cards are shown to spectators (it is AI, and it makes the duel watchable).
function snapshot(
  t: Table,
  players: [Entry, Entry],
  handIndex: number,
  lastAction: { agentId: number; name: string; action: string; reasoning: string; chatID: string | null },
) {
  const streets = ["preflop", "flop", "turn", "river"];
  const foldedLoser =
    t.handOver && t.result && !t.result.showdown && t.result.winner !== null ? (t.result.winner === 0 ? 1 : 0) : -1;
  const seats = ([0, 1] as const).map((s) => ({
    agentId: players[s].agentId,
    name: players[s].agentName,
    chips: t.stacks[s],
    holeCards: t.holes[s].map(cardLabel),
    folded: s === foldedLoser,
    isTurn: !t.handOver && t.toAct === s,
    isHouse: players[s].isHouse,
  }));
  return {
    handIndex: handIndex + 1,
    street: streets[t.street] ?? "preflop",
    board: t.board.map(cardLabel),
    pot: t.handPut[0] + t.handPut[1],
    seats,
    lastAction,
  };
}
