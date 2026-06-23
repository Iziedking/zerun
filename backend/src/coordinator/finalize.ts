import type { Hex } from "viem";
import { query } from "../db/pool.js";
import { computePayouts, type RankedAgent } from "../runners/scoring.js";
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

// Shared settlement, used by every contest type. Given the ranked field, it
// splits the pool, builds the payout merkle root, posts it once the window has
// closed, settles on chain, persists each winner's proof, and stores the audit
// trail on 0G Storage. The per-contest scoring differs; this tail does not.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunResult {
  contestId: number;
  root: Hex | null;
  posted: boolean;
  settled: boolean;
  payouts: { operator: string; amount: string; rank: number }[];
}

// Broadcast a live standings snapshot from an already-ranked field.
export function pushStandings(
  contestId: number,
  ranked: RankedAgent[],
  nameOf: Map<number, string>,
): void {
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

export async function finalizeContest(contestId: number, ranked: RankedAgent[]): Promise<RunResult> {
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

  // The platform fee is skimmed on chain at settle, so the merkle payouts cover
  // the pool minus that fee.
  const platformFee = (prizePool * BigInt(platformFeeBps)) / 10_000n;
  const distributable = prizePool - platformFee;
  const payouts = computePayouts(ranked, distributable, Number(topN));

  if (payouts.length === 0) {
    broadcast({ type: "status", contestId, payload: { status: "no-winners" } });
    // Nobody scored, so cancel on chain to refund the sponsor and clear the
    // open state, otherwise the sweeper would retry this contest forever.
    await cancelContest(contestId);
    return { contestId, root: null, posted: false, settled: false, payouts: [] };
  }

  const leaves = payouts.map((p) => payoutLeaf(p.operator as `0x${string}`, p.amount));
  const root = merkleRoot(leaves);

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
    broadcast({ type: "status", contestId, payload: { status: "awaiting-window-close" } });
    await sleep((endTime - now) * 1000 + 1500);
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

  await storeAuditTrail(contestId, root);

  return {
    contestId,
    root,
    posted: true,
    settled: true,
    payouts: payouts.map((p) => ({ operator: p.operator, amount: p.amount.toString(), rank: p.rank })),
  };
}

// Cancel a contest on chain (refunds the sponsor) and mark it cancelled. Used
// for contests that close with no field or no winner, so they leave the open
// state instead of being retried forever. Best effort: if the contract rejects
// it (already settled or cancelled), we log and move on.
export async function cancelContest(contestId: number): Promise<void> {
  const dep = loadDeployment();
  try {
    const hash = await coordinatorWallet().writeContract({
      address: dep.contestEngine,
      abi: contestEngineAbi,
      functionName: "cancelContest",
      args: [BigInt(contestId)],
      account: coordinatorAccount(),
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await query("update contests_meta set status = 'cancelled' where contest_id = $1", [contestId]);
    broadcast({ type: "status", contestId, payload: { status: "cancelled" } });
    console.log(`contest ${contestId} cancelled (no winners)`);
  } catch (err) {
    // Already resolved on chain, or another sweep handled it.
    await query(
      "update contests_meta set status = 'cancelled' where contest_id = $1 and status not in ('settled')",
      [contestId],
    );
    console.error(`contest ${contestId} cancel skipped:`, (err as Error).message);
  }
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
    const payload = { contestId, scoreRoot: root, storedAt: new Date().toISOString(), solves: feed };
    const { rootHash, txHash } = await uploadJson(payload);
    await query("update contests_meta set audit_root = $2, audit_tx = $3 where contest_id = $1", [
      contestId,
      rootHash,
      txHash,
    ]);
    broadcast({ type: "status", contestId, payload: { status: "audit-stored", detail: rootHash } });
    console.log(`contest ${contestId} audit trail stored on 0G Storage: ${rootHash}`);
  } catch (err) {
    console.error(`contest ${contestId} audit storage failed (non-fatal):`, (err as Error).message);
  }
}
