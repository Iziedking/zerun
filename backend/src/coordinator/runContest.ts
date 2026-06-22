import type { Hex } from "viem";
import { query } from "../db/pool.js";
import { generatePuzzles } from "../runners/puzzles.js";
import { solvePuzzle } from "../runners/solver.js";
import { rankAgents, computePayouts, type AgentScore } from "../runners/scoring.js";
import { payoutLeaf, merkleRoot, merkleProof } from "./merkle.js";
import { broadcast, type StandingRow } from "./ws.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import {
  GAS_PRICE,
  contestEngineAbi,
  coordinatorWallet,
  coordinatorAccount,
  loadDeployment,
  publicClient,
} from "../chain/contracts.js";

// The contest loop. Reads the field, runs every agent through the Solver runner
// (each answer is a paid 0G Compute call), scores deterministically, builds the
// payout merkle root, posts it on chain after the window closes, settles, and
// persists each winner's proof so they can claim. Broadcasts the live feed
// throughout.

const DEFAULT_PUZZLE_COUNT = 5;
// Stay under the 0G Compute rate limits (~30 req/min, ~5 concurrent).
const AGENT_CONCURRENCY = 3;

interface Entry {
  agentId: number;
  operator: string;
  agentName: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readEntries(contestId: number): Promise<Entry[]> {
  const { rows } = await query<{ agent_id: string; operator: string; name: string | null }>(
    `select e.agent_id, e.operator, m.name
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
  }));
}

async function puzzleCountFor(contestId: number): Promise<number> {
  const { rows } = await query<{ puzzle_count: number }>(
    "select puzzle_count from contests_meta where contest_id = $1",
    [contestId],
  );
  return rows[0]?.puzzle_count ?? DEFAULT_PUZZLE_COUNT;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

export interface RunResult {
  contestId: number;
  root: Hex | null;
  posted: boolean;
  settled: boolean;
  payouts: { operator: string; amount: string; rank: number }[];
}

export async function runContest(contestId: number): Promise<RunResult> {
  const dep = loadDeployment();
  const engine = dep.contestEngine;

  const contest = await publicClient.readContract({
    address: engine,
    abi: contestEngineAbi,
    functionName: "getContest",
    args: [BigInt(contestId)],
  });
  const prizePool = contest.prizePool;
  const platformFeeBps = contest.platformFeeBps;
  const topN = contest.topN;
  const endTime = Number(contest.endTime);

  const entries = await readEntries(contestId);
  if (entries.length === 0) {
    broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
    return { contestId, root: null, posted: false, settled: false, payouts: [] };
  }

  const puzzles = generatePuzzles(contestId, await puzzleCountFor(contestId));
  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `${entries.length} agents, ${puzzles.length} puzzles` },
  });

  const scores = new Map<number, AgentScore>();
  for (const e of entries) {
    scores.set(e.agentId, { agentId: e.agentId, operator: e.operator, correct: 0, totalLatencyMs: 0 });
  }

  // Each agent works through the puzzle set in order; agents run a few at a
  // time. Every answer is persisted and pushed to the live feed immediately.
  await mapLimit(entries, AGENT_CONCURRENCY, async (entry) => {
    for (const puzzle of puzzles) {
      const outcome = await solvePuzzle(puzzle);

      const score = scores.get(entry.agentId)!;
      if (outcome.verdict === "correct") score.correct += 1;
      score.totalLatencyMs += outcome.latencyMs;

      await query(
        `insert into solve_runs
           (contest_id, agent_id, operator, puzzle_idx, prompt, expected, answer, verdict, source, provider, model, chat_id, verified, latency_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (contest_id, agent_id, puzzle_idx) do update set
           answer = excluded.answer, verdict = excluded.verdict, source = excluded.source,
           provider = excluded.provider, model = excluded.model, chat_id = excluded.chat_id,
           verified = excluded.verified, latency_ms = excluded.latency_ms`,
        [
          contestId, entry.agentId, entry.operator, puzzle.idx, puzzle.prompt, puzzle.expected,
          outcome.answer, outcome.verdict, outcome.source, outcome.provider, outcome.model,
          outcome.chatID, outcome.verified, outcome.latencyMs,
        ],
      );

      broadcast({
        type: "solve",
        contestId,
        payload: {
          agentId: entry.agentId,
          agentName: entry.agentName,
          operator: entry.operator,
          puzzleIdx: puzzle.idx,
          prompt: puzzle.prompt,
          answer: outcome.answer,
          verdict: outcome.verdict,
          source: outcome.source,
          provider: outcome.provider,
          model: outcome.model,
          chatID: outcome.chatID,
          verified: outcome.verified,
          latencyMs: outcome.latencyMs,
        },
      });

      broadcastStandings(contestId, scores, entries);
      // Gentle spacing keeps us comfortably under the provider rate limit.
      await sleep(150);
    }
  });

  // Rank and split the pool. The platform fee is skimmed on chain at settle, so
  // the merkle payouts cover prizePool minus that fee.
  const ranked = rankAgents([...scores.values()]);
  const platformFee = (prizePool * BigInt(platformFeeBps)) / 10_000n;
  const distributable = prizePool - platformFee;
  const payouts = computePayouts(ranked, distributable, Number(topN));

  if (payouts.length === 0) {
    broadcast({ type: "status", contestId, payload: { status: "no-winners" } });
    await query("update contests_meta set status = 'scored' where contest_id = $1", [contestId]);
    return { contestId, root: null, posted: false, settled: false, payouts: [] };
  }

  const leaves = payouts.map((p) => payoutLeaf(p.operator as `0x${string}`, p.amount));
  const root = merkleRoot(leaves);

  // Persist each winner's proof so claims are a pure read on the frontend.
  for (let i = 0; i < payouts.length; i++) {
    const p = payouts[i]!;
    const proof = merkleProof(leaves, i);
    await query(
      `insert into payouts (contest_id, operator, amount, leaf_index, proof, rank, claimed)
       values ($1,$2,$3,$4,$5,$6,false)
       on conflict (contest_id, operator) do update set
         amount = excluded.amount, leaf_index = excluded.leaf_index,
         proof = excluded.proof, rank = excluded.rank`,
      [contestId, p.operator, p.amount.toString(), i, JSON.stringify(proof), p.rank],
    );
  }
  await query("update contests_meta set status = 'scored', final_root = $2 where contest_id = $1", [
    contestId,
    root,
  ]);

  // Post the root only once the entry window has closed (the contract enforces
  // this too). Wait it out for short demo contests.
  const now = Math.floor(Date.now() / 1000);
  if (now < endTime) {
    const waitMs = (endTime - now) * 1000 + 1500;
    broadcast({ type: "status", contestId, payload: { status: "awaiting-window-close" } });
    await sleep(waitMs);
  }

  const wallet = coordinatorWallet();
  const account = coordinatorAccount();

  broadcast({ type: "status", contestId, payload: { status: "posting-root" } });
  const postHash = await wallet.writeContract({
    address: engine,
    abi: contestEngineAbi,
    functionName: "postScoreRoot",
    args: [BigInt(contestId), root],
    account,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await publicClient.waitForTransactionReceipt({ hash: postHash });

  broadcast({ type: "status", contestId, payload: { status: "settling" } });
  const settleHash = await wallet.writeContract({
    address: engine,
    abi: contestEngineAbi,
    functionName: "settle",
    args: [BigInt(contestId)],
    account,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await publicClient.waitForTransactionReceipt({ hash: settleHash });

  await query(
    "update contests_meta set status = 'settled', settled_at = now() where contest_id = $1",
    [contestId],
  );
  broadcast({
    type: "settled",
    contestId,
    payload: {
      root,
      payouts: payouts.map((p) => ({ operator: p.operator, amount: p.amount.toString(), rank: p.rank })),
    },
  });

  // Store the audit trail on 0G Storage. Best effort: a failure here is logged
  // and never affects the settled contest or anyone's claim.
  await storeAuditTrail(contestId, root);

  return {
    contestId,
    root,
    posted: true,
    settled: true,
    payouts: payouts.map((p) => ({ operator: p.operator, amount: p.amount.toString(), rank: p.rank })),
  };
}

function broadcastStandings(
  contestId: number,
  scores: Map<number, AgentScore>,
  entries: Entry[],
): void {
  const ranked = rankAgents([...scores.values()]);
  const nameOf = new Map(entries.map((e) => [e.agentId, e.agentName]));
  const rows: StandingRow[] = ranked.map((r) => ({
    agentId: r.agentId,
    agentName: nameOf.get(r.agentId) ?? `Agent #${r.agentId}`,
    operator: r.operator,
    correct: r.correct,
    totalLatencyMs: r.totalLatencyMs,
    rank: r.rank,
  }));
  broadcast({ type: "standings", contestId, payload: rows });
}

// Build the audit payload from the persisted solve feed and put it on 0G
// Storage, then record the root hash on the contest. Never throws.
async function storeAuditTrail(contestId: number, root: Hex): Promise<void> {
  if (!storageConfigured()) return;
  try {
    const { rows: feed } = await query(
      `select agent_id, operator, puzzle_idx, prompt, expected, answer, verdict,
              source, provider, model, chat_id, verified, latency_ms
         from solve_runs where contest_id = $1 order by agent_id, puzzle_idx`,
      [contestId],
    );
    const payload = {
      contestId,
      scoreRoot: root,
      storedAt: new Date().toISOString(),
      solves: feed,
    };
    const { rootHash, txHash } = await uploadJson(payload);
    await query("update contests_meta set audit_root = $2, audit_tx = $3 where contest_id = $1", [
      contestId,
      rootHash,
      txHash,
    ]);
    broadcast({
      type: "status",
      contestId,
      payload: { status: "audit-stored", detail: rootHash },
    });
    console.log(`contest ${contestId} audit trail stored on 0G Storage: ${rootHash}`);
  } catch (err) {
    console.error(`contest ${contestId} audit storage failed (non-fatal):`, (err as Error).message);
  }
}
