import { createWalletClient, http, keccak256, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config/index.js";
import { query } from "../db/pool.js";
import { openContest } from "./contestOps.js";
import { runContest } from "./runContest.js";
import { runAnalystContest } from "./runAnalystContest.js";
import { resettleFromStored } from "./finalize.js";
import {
  CONTEST_TYPE,
  GAS_PRICE,
  agentRegistryAbi,
  contestEngineAbi,
  testUsdcAbi,
  coordinatorAccount,
  coordinatorWallet,
  loadDeployment,
  ogGalileo,
  publicClient,
  waitReceipt,
} from "../chain/contracts.js";

// The self-driving arena. On a cadence it opens a contest, alternating puzzle
// and analyst, and seeds a small house roster so there is always a field to
// watch. A due-sweeper settles any open contest whose window has closed,
// including ones hosted by other operators, so hosting and autopilot share one
// settlement path. An in-flight guard and a watchdog keep two runs from ever
// fighting over the coordinator nonce (the ArcRun pattern).
//
// Env (all optional):
//   AUTOPILOT=on                     turn it on (off by default)
//   AUTOPILOT_INTERVAL_SECONDS=1800  gap between opens (30 min default; lower for a demo)
//   AUTOPILOT_WINDOW_SECONDS=300     how long each contest stays open
//   AUTOPILOT_POOL_USDC=30           prize pool per contest
//   AUTOPILOT_HOUSE=4                house agents seeded into each contest

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INTERVAL_MS = Number(process.env.AUTOPILOT_INTERVAL_SECONDS ?? "1800") * 1000;
const WINDOW_S = Number(process.env.AUTOPILOT_WINDOW_SECONDS ?? "300");
const POOL_USDC = Number(process.env.AUTOPILOT_POOL_USDC ?? "30");
// Pools the autopilot picks from at random, so prizes vary contest to contest.
const POOL_CHOICES = [25, 30, 40, 50, 60, 70, 80, 100];
const HOUSE_SIZE = Number(process.env.AUTOPILOT_HOUSE ?? "4");
const SWEEP_MS = 30_000;
const RUN_TIMEOUT_MS = 1_200_000; // paced 0G calls make a full field take longer

const HOUSE_NAMES = ["Pixel", "Nova", "Byte", "Echo", "Quark", "Volt"];

interface HouseAgent {
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: ReturnType<typeof createWalletClient>;
  agentId: number;
  name: string;
}

let houseCache: HouseAgent[] | null = null;

// House wallets are derived from the coordinator key, so they are the same set
// across restarts without storing any keys. Each is funded once and given one
// agent once.
async function ensureHouseRoster(): Promise<HouseAgent[]> {
  if (houseCache) return houseCache;
  const dep = loadDeployment();
  const funder = coordinatorWallet();
  const funderAccount = coordinatorAccount();
  const out: HouseAgent[] = [];

  for (let i = 0; i < HOUSE_SIZE; i++) {
    const pk = keccak256(toHex(`${config.signerKey}:house:${i}`)) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const wallet = createWalletClient({ account, chain: ogGalileo, transport: http(config.chain.rpcUrl) });
    const name = HOUSE_NAMES[i % HOUSE_NAMES.length]!;

    // Fund enough for the one-time tier upgrades (mint, approve, steps) plus a
    // long run of per-contest entries.
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance < parseEther("0.03")) {
      const h = await funder.sendTransaction({
        to: account.address,
        value: parseEther("0.12"),
        account: funderAccount,
        chain: undefined,
        gasPrice: GAS_PRICE,
      });
      await waitReceipt(h);
    }

    const owned = (await publicClient.readContract({
      address: dep.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "agentsOf",
      args: [account.address],
    })) as bigint[];

    let agentId: number;
    if (owned.length > 0) {
      agentId = Number(owned[0]);
    } else {
      const nextId = (await publicClient.readContract({
        address: dep.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "nextAgentId",
      })) as bigint;
      const ch = await wallet.writeContract({
        address: dep.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "createAgent",
        args: [`zerun:house:${name}`],
        account,
        chain: undefined,
        gasPrice: GAS_PRICE,
      });
      await waitReceipt(ch);
      agentId = Number(nextId);
    }

    // The house is the weak baseline: every house agent stays at Compute level 0,
    // so any operator who trains (level 1+) reliably beats them and the leaderboard
    // belongs to real players. Forced down even if an old row sat higher.
    await query(
      `insert into agents_meta (agent_id, owner, name, compute_level, is_house) values ($1,$2,$3,0,true)
         on conflict (agent_id) do update set
           name = excluded.name,
           compute_level = 0,
           is_house = true`,
      [agentId, account.address.toLowerCase(), name],
    );

    out.push({ account, wallet, agentId, name });
  }

  houseCache = out;
  console.log(`autopilot: house roster ready (${out.length} agents)`);
  return out;
}

// Buy a house agent from its current tier up to a target for one contest type:
// price the steps, mint and approve the test USDC, then upgrade one step at a
// time. Idempotent: a no-op once the agent already sits at or above the target.
async function upgradeHouseTier(
  wallet: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  agentId: number,
  contestType: number,
  target: number,
): Promise<void> {
  const dep = loadDeployment();
  const current = Number(
    await publicClient.readContract({
      address: dep.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "getTier",
      args: [BigInt(agentId), contestType],
    }),
  );
  if (current >= target) return;

  let total = 0n;
  for (let t = current; t < target; t++) {
    const price = (await publicClient.readContract({
      address: dep.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "upgradePrice",
      args: [contestType, t],
    })) as bigint;
    total += price;
  }

  const mint = await wallet.writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "mint",
    args: [account.address, total],
    account,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await waitReceipt(mint);

  const approve = await wallet.writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "approve",
    args: [dep.agentRegistry, total],
    account,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await waitReceipt(approve);

  for (let t = current; t < target; t++) {
    const h = await wallet.writeContract({
      address: dep.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "upgradeAgent",
      args: [BigInt(agentId), contestType, t + 1],
      account,
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await waitReceipt(h);
  }
}

async function seedHouseInto(contestId: number): Promise<void> {
  const dep = loadDeployment();
  const house = await ensureHouseRoster();
  for (const h of house) {
    try {
      const hash = await h.wallet.writeContract({
        address: dep.contestEngine,
        abi: contestEngineAbi,
        functionName: "registerEntry",
        args: [BigInt(contestId), BigInt(h.agentId), 0n],
        account: h.account,
        chain: undefined,
        gasPrice: GAS_PRICE,
      });
      await waitReceipt(hash);
      await query(
        `insert into contest_entries (contest_id, agent_id, operator) values ($1,$2,$3)
           on conflict (contest_id, agent_id) do nothing`,
        [contestId, h.agentId, h.account.address.toLowerCase()],
      );
    } catch (err) {
      console.error(`autopilot: house ${h.name} could not enter ${contestId}:`, (err as Error).message);
    }
  }
  await query(
    `update contests_meta set agent_count = (select count(*) from contest_entries where contest_id = $1) where contest_id = $1`,
    [contestId],
  );
}

// Open contests (status OPEN = 1) whose window has closed, any sponsor.
interface DueContest {
  id: number;
  contestType: number;
}
async function findDueContests(lookback = 100): Promise<DueContest[]> {
  const dep = loadDeployment();
  const next = (await publicClient.readContract({
    address: dep.contestEngine,
    abi: contestEngineAbi,
    functionName: "nextContestId",
  })) as bigint;
  const latest = Number(next) - 1;
  const floor = Math.max(1, latest - lookback + 1);
  const nowSec = Math.floor(Date.now() / 1000);

  const due: DueContest[] = [];
  for (let id = latest; id >= floor; id--) {
    const c = await publicClient.readContract({
      address: dep.contestEngine,
      abi: contestEngineAbi,
      functionName: "getContest",
      args: [BigInt(id)],
    });
    if (Number(c.status) === 1 && Number(c.endTime) <= nowSec) {
      due.push({ id, contestType: Number(c.contestType) });
    }
  }
  return due.reverse(); // oldest first
}

// Make sure a contests_meta row exists for an on-chain contest, so the runner
// and the API have its kind and pool. Covers user-hosted contests too.
async function ensureContestMeta(id: number, contestType: number): Promise<void> {
  const dep = loadDeployment();
  const c = await publicClient.readContract({
    address: dep.contestEngine,
    abi: contestEngineAbi,
    functionName: "getContest",
    args: [BigInt(id)],
  });
  const kind = contestType === CONTEST_TYPE.ANALYST ? "analyst" : "solver";
  await query(
    `insert into contests_meta (contest_id, status, puzzle_count, metric, prize_pool, kind, ends_at)
       values ($1, 'open', 4, $2, $3, $4, to_timestamp($5))
       on conflict (contest_id) do update set
         kind = excluded.kind, prize_pool = excluded.prize_pool, ends_at = excluded.ends_at`,
    [id, kind === "analyst" ? "PREDICTION" : "PUZZLE", c.prizePool.toString(), kind, Number(c.endTime)],
  );
}

// Heal contests whose database status drifted from the chain: a contest the
// chain has SETTLED or CANCELLED but the database still shows open or running
// (e.g. a settlement that completed on chain but did not finish writing back).
// Keeps the arena from showing a finished contest as stuck on "joining".
async function reconcileStatuses(): Promise<void> {
  const dep = loadDeployment();
  const { rows } = await query<{ contest_id: string; status: string }>(
    "select contest_id, status from contests_meta where status in ('open','running','pending','scored')",
  );
  for (const r of rows) {
    const id = Number(r.contest_id);
    try {
      const c = await publicClient.readContract({
        address: dep.contestEngine,
        abi: contestEngineAbi,
        functionName: "getContest",
        args: [BigInt(id)],
      });
      const s = Number(c.status); // 1 OPEN, 2 SCORING, 3 SETTLED, 4 CANCELLED
      if (s === 3) {
        await query("update contests_meta set status = 'settled', settled_at = coalesce(settled_at, now()) where contest_id = $1 and status <> 'settled'", [id]);
      } else if (s === 4) {
        await query("update contests_meta set status = 'cancelled' where contest_id = $1 and status <> 'cancelled'", [id]);
      } else if (r.status === "scored" && !inFlight.has(id)) {
        // Scored off chain but the settle stalled. Resume it from the stored root.
        inFlight.add(id);
        await resettleFromStored(id).finally(() => inFlight.delete(id));
      }
    } catch (err) {
      console.error(`reconcile ${id}:`, (err as Error).message);
    }
  }
}

const inFlight = new Set<number>();

async function runOnce(id: number, contestType: number): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  await ensureContestMeta(id, contestType).catch(() => {});
  const runner = contestType === CONTEST_TYPE.ANALYST ? runAnalystContest : runContest;
  const work = runner(id).finally(() => inFlight.delete(id));
  work.catch(() => {});
  await Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error("watchdog")), RUN_TIMEOUT_MS)),
  ]).catch((err) => {
    console.error(`autopilot: contest ${id} watchdog: ${(err as Error).message}`);
  });
}

async function startDueSweeper(): Promise<void> {
  for (;;) {
    await sleep(SWEEP_MS);
    try {
      for (const d of await findDueContests()) {
        if (inFlight.has(d.id)) continue;
        console.log(`autopilot: settling due contest ${d.id}`);
        await runOnce(d.id, d.contestType).catch((err) =>
          console.error(`autopilot: settle ${d.id} failed:`, (err as Error).message),
        );
      }
      // Keep the database status in step with the chain (heals stuck contests).
      await reconcileStatuses();
    } catch (err) {
      console.error("autopilot sweeper failed:", (err as Error).message);
    }
  }
}

async function startOpenLoop(): Promise<void> {
  // Build (and tier-upgrade) the house roster once up front. The first-time
  // upgrade takes longer than a contest window, so warming it here keeps the
  // first contest from closing before the house can join.
  await ensureHouseRoster().catch((err) =>
    console.error("autopilot: house warmup failed:", (err as Error).message),
  );
  let cycle = 0;
  for (;;) {
    try {
      const kind = cycle % 2 === 0 ? "solver" : "analyst";
      // Vary the pool so the arena does not look canned.
      const pool = POOL_CHOICES[Math.floor(Math.random() * POOL_CHOICES.length)]!;
      console.log(`autopilot: opening a ${kind} contest (${pool} tUSDC)`);
      const id = await openContest({
        prizePoolUsdc: pool,
        durationSecs: WINDOW_S,
        topN: 3,
        puzzleCount: 6,
        kind,
      });
      await seedHouseInto(id);
      console.log(`autopilot: contest ${id} (${kind}) open with the house field`);
      cycle++;
    } catch (err) {
      console.error("autopilot open failed:", (err as Error).message);
    }
    await sleep(INTERVAL_MS);
  }
}

export function autopilotEnabled(): boolean {
  return (process.env.AUTOPILOT ?? "off").toLowerCase() === "on" && Boolean(config.signerKey);
}

export function startAutopilot(): void {
  if (!autopilotEnabled()) return;
  console.log(
    `autopilot: on. opening every ${INTERVAL_MS / 1000}s, ${WINDOW_S}s window, ${POOL_USDC} tUSDC pool.`,
  );
  void startOpenLoop();
  void startDueSweeper();
}
