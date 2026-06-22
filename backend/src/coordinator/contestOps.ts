import { keccak256, toHex } from "viem";
import { query } from "../db/pool.js";
import {
  CONTEST_TYPE,
  contestEngineAbi,
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
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const PUZZLE_METRIC = keccak256(toHex("PUZZLE"));

export async function openContest(params: OpenContestParams): Promise<number> {
  const dep = loadDeployment();
  const wallet = coordinatorWallet();
  const account = coordinatorAddress();

  const prizePool = BigInt(Math.round(params.prizePoolUsdc * 1_000_000));

  // Mint the sponsor enough test USDC, then approve the escrow to pull the pool.
  const mintHash = await wallet.writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "mint",
    args: [account, prizePool],
    account,
    chain: undefined,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  const approveHash = await wallet.writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "approve",
    args: [dep.prizeEscrow, prizePool],
    account,
    chain: undefined,
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
      CONTEST_TYPE.SOLVER,
      ZERO_ADDRESS,
      PUZZLE_METRIC,
      prizePool,
      BigInt(params.durationSecs),
      6000, // winnerCutBps: published headline share
      params.topN,
      0, // minTier
      4, // maxTier
    ],
    account,
    chain: undefined,
  });
  await publicClient.waitForTransactionReceipt({ hash: listHash });

  const id = Number(contestId);
  await query(
    `insert into contests_meta (contest_id, status, puzzle_count, metric, prize_pool)
     values ($1, 'open', $2, 'PUZZLE', $3)
     on conflict (contest_id) do update set
       puzzle_count = excluded.puzzle_count, prize_pool = excluded.prize_pool`,
    [id, params.puzzleCount, prizePool.toString()],
  );

  return id;
}
