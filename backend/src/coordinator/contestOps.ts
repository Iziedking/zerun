import { keccak256, parseAbiItem, toHex } from "viem";
import { query } from "../db/pool.js";
import {
  CONTEST_TYPE,
  GAS_PRICE,
  contestEngineAbi,
  coordinatorAccount,
  coordinatorAddress,
  coordinatorWallet,
  loadDeployment,
  publicClient,
  testUsdcAbi,
} from "../chain/contracts.js";

// Opens a sponsor contest end to end so the arena always has something live.
// The coordinator acts as the sponsor here: it mints itself test USDC, approves
// the escrow, and lists the contest. On a real deployment a project would do
// this from its own wallet through the frontend; this is the bootstrap path.

export interface OpenContestParams {
  prizePoolUsdc: number; // whole USDC, converted to 6dp
  durationSecs: number;
  topN: number;
  puzzleCount: number;
  /// 'solver' (puzzles) or 'analyst' (prediction markets). Defaults to solver.
  kind?: "solver" | "analyst";
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const METRIC = {
  solver: { hash: keccak256(toHex("PUZZLE")), label: "PUZZLE", contestType: CONTEST_TYPE.SOLVER },
  analyst: { hash: keccak256(toHex("PREDICTION")), label: "PREDICTION", contestType: CONTEST_TYPE.ANALYST },
} as const;

export async function openContest(params: OpenContestParams): Promise<number> {
  const kind = params.kind ?? "solver";
  const metric = METRIC[kind];
  const dep = loadDeployment();
  const wallet = coordinatorWallet();
  const signer = coordinatorAccount();
  const account = coordinatorAddress();

  const prizePool = BigInt(Math.round(params.prizePoolUsdc * 1_000_000));

  // Mint the sponsor enough test USDC, then approve the escrow to pull the pool.
  const mintHash = await wallet.writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "mint",
    args: [account, prizePool],
    account: signer,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  const approveHash = await wallet.writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "approve",
    args: [dep.prizeEscrow, prizePool],
    account: signer,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // The next id the engine will assign becomes this contest's id.
  const contestId = await publicClient.readContract({
    address: dep.contestEngine,
    abi: contestEngineAbi,
    functionName: "nextContestId",
  });

  const listHash = await wallet.writeContract({
    address: dep.contestEngine,
    abi: contestEngineAbi,
    functionName: "listContest",
    args: [
      metric.contestType,
      ZERO_ADDRESS,
      metric.hash,
      prizePool,
      BigInt(params.durationSecs),
      6000, // winnerCutBps: published headline share
      params.topN,
      0, // minTier
      4, // maxTier
    ],
    account: signer,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await publicClient.waitForTransactionReceipt({ hash: listHash });

  const id = Number(contestId);
  const con = await publicClient.readContract({
    address: dep.contestEngine,
    abi: contestEngineAbi,
    functionName: "getContest",
    args: [contestId as bigint],
  });
  await query(
    `insert into contests_meta (contest_id, status, puzzle_count, metric, prize_pool, kind, ends_at)
     values ($1, 'open', $2, $3, $4, $5, to_timestamp($6))
     on conflict (contest_id) do update set
       puzzle_count = excluded.puzzle_count, prize_pool = excluded.prize_pool,
       kind = excluded.kind, ends_at = excluded.ends_at`,
    [id, params.puzzleCount, metric.label, prizePool.toString(), kind, Number(con.endTime)],
  );

  return id;
}

const ENTRY_EVENT = parseAbiItem(
  "event EntryRegistered(uint256 indexed contestId, address indexed operator, uint256 indexed agentId, uint256 syndicateId)",
);

// How many agents are registered for a contest on chain. The chain is the source
// of truth for the field, so the runner never cancels a contest that actually
// has entrants just because the database mirror lagged.
export async function onchainEntryCount(contestId: number): Promise<number> {
  const dep = loadDeployment();
  const n = await publicClient.readContract({
    address: dep.contestEngine,
    abi: contestEngineAbi,
    functionName: "entryCount",
    args: [BigInt(contestId)],
  });
  return Number(n);
}

// Rebuild a contest's entries in the database from the on-chain EntryRegistered
// events, so a lagged or missed POST /enter mirror cannot drop an entrant.
// Best effort: returns how many entries it reconciled.
export async function syncEntriesFromChain(contestId: number): Promise<number> {
  const dep = loadDeployment();
  let logs;
  try {
    const latest = await publicClient.getBlockNumber();
    const fromBlock = latest > 9_000n ? latest - 9_000n : 0n;
    logs = await publicClient.getLogs({
      address: dep.contestEngine,
      event: ENTRY_EVENT,
      args: { contestId: BigInt(contestId) },
      fromBlock,
      toBlock: latest,
    });
  } catch (err) {
    console.error(`entry sync for contest ${contestId} failed:`, (err as Error).message);
    return 0;
  }

  for (const log of logs) {
    const operator = String(log.args.operator).toLowerCase();
    const agentId = Number(log.args.agentId);
    await query(
      `insert into agents_meta (agent_id, owner, name) values ($1,$2,$3)
         on conflict (agent_id) do nothing`,
      [agentId, operator, `Agent #${agentId}`],
    );
    await query(
      `insert into contest_entries (contest_id, agent_id, operator) values ($1,$2,$3)
         on conflict (contest_id, agent_id) do nothing`,
      [contestId, agentId, operator],
    );
  }
  await query(
    `update contests_meta set agent_count = (select count(*) from contest_entries where contest_id = $1) where contest_id = $1`,
    [contestId],
  );
  return logs.length;
}
