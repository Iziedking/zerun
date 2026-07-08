import { createWalletClient, http, keccak256, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config/index.js";
import { query } from "../db/pool.js";
import { openContest, kindFromMetric, type ContestKind } from "./contestOps.js";
import { runContest } from "./runContest.js";
import { runAnalystContest } from "./runAnalystContest.js";
import { runPokerContest } from "./runPokerContest.js";
import { runWorldCupContest } from "./runWorldCupContest.js";
import { startWorldCupResolver } from "./worldcupResolver.js";
import { resettleFromStored, cancelContest } from "./finalize.js";
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
import { computeMode } from "../compute/client.js";
import { logTierRouting } from "../compute/zgCompute.js";
import { computePlan, MAX_COMPUTE_LEVEL } from "../runners/computeLevels.js";

// The self-driving arena. On a cadence it opens a contest, leading with Solver
// (reasoning) and mixing in an Analyst (real markets) every Nth cycle, and seeds
// a small house roster so there is always a field to
// watch. A due-sweeper settles any open contest whose window has closed,
// including ones hosted by other operators, so hosting and autopilot share one
// settlement path. An in-flight guard and a watchdog keep two runs from ever
// fighting over the coordinator nonce (the ArcRun pattern).
//
// Env (all optional):
//   AUTOPILOT=on                     turn it on (off by default)
//   AUTOPILOT_PER_DAY=5              opens spread across a day (default 5)
//   AUTOPILOT_JITTER=0.35            how much each gap swings from the average
//   AUTOPILOT_INTERVAL_SECONDS=      fixed gap override (set this for a demo cadence)
//   AUTOPILOT_MAX_OPEN=1             most contests allowed open at once
//   AUTOPILOT_WINDOW_SECONDS=300     how long each contest stays open
//   AUTOPILOT_STALE_AFTER_SECONDS=3600  refund a contest left open this long past close
//   AUTOPILOT_POOL_USDC=30           prize pool per contest
//   AUTOPILOT_HOUSE=4                house agents seeded into each contest

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A handful of opens a day, spaced across the clock rather than on a fixed timer,
// so the arena surfaces at different local times for different timezones instead
// of always landing in the same slots. A fixed gap still wins if set, for demos.
const PER_DAY = Number(process.env.AUTOPILOT_PER_DAY ?? "5");
const GAP_JITTER = Number(process.env.AUTOPILOT_JITTER ?? "0.35");
const FIXED_INTERVAL_MS = process.env.AUTOPILOT_INTERVAL_SECONDS
  ? Number(process.env.AUTOPILOT_INTERVAL_SECONDS) * 1000
  : null;
const BASE_GAP_MS = Math.floor(86_400_000 / Math.max(1, PER_DAY));
// Most contests allowed open at once. Stops the loop from stacking the feed when
// settlement lags; it resumes opening as soon as the open one resolves.
const MAX_OPEN = Number(process.env.AUTOPILOT_MAX_OPEN ?? "1");
// Short re-check while holding off because a contest is still open, so the next
// one opens soon after it resolves rather than a full gap later.
const HOLD_RETRY_MS = 60_000;

// Event mix: relative weights for which kind the autopilot opens. Default is a
// poker-forward arena (poker 50, prediction 30, puzzle 20).
const W_POKER = Number(process.env.AUTOPILOT_W_POKER ?? "50");
const W_PREDICTION = Number(process.env.AUTOPILOT_W_PREDICTION ?? "30");
const W_PUZZLE = Number(process.env.AUTOPILOT_W_PUZZLE ?? "20");
// Chance a prediction event opens as a 1v1 duel rather than a full-field contest.
const PREDICTION_DUEL_PCT = Number(process.env.AUTOPILOT_PREDICTION_DUEL_PCT ?? "0.4");
// Chance a poker event opens as a multi-player table (up to 6-max) rather than a
// heads-up duel. Off by default: set AUTOPILOT_POKER_TABLE_PCT above 0 to enable
// tables once the multi-player path is proven live.
const POKER_TABLE_PCT = Number(process.env.AUTOPILOT_POKER_TABLE_PCT ?? "0");
// Within the prediction slice, the share that opens as a World Cup mission (deferred
// settlement) instead of a normal prediction. The spotlight default surfaces the World
// Cup ~90% of the time while the tournament is on; set AUTOPILOT_WORLDCUP_PCT to 0 to
// turn it off, or lower to soak-test.
const WORLDCUP_PCT = Number(process.env.AUTOPILOT_WORLDCUP_PCT ?? "0.9");

function pickAutopilotKind(): "poker" | "analyst" | "solver" {
  const total = Math.max(1, W_POKER + W_PREDICTION + W_PUZZLE);
  const r = Math.random() * total;
  if (r < W_POKER) return "poker";
  if (r < W_POKER + W_PREDICTION) return "analyst";
  return "solver";
}

// The daily opener: autopilot opens exactly ONE contest of each of these kinds per
// UTC day, every one a many-entrant field (never a 1v1 duel), each seeded with house
// agents near the close. "puzzle" and "solver" are the same kind (the puzzle-solving
// contest); add "analyst" for a standalone (non-World-Cup) prediction. Tunable.
const VALID_KINDS: ContestKind[] = ["solver", "poker", "worldcup", "analyst"];
const DAILY_KINDS: ContestKind[] = (process.env.AUTOPILOT_DAILY_KINDS ?? "solver,poker,worldcup")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s): s is ContestKind => (VALID_KINDS as string[]).includes(s));
// Seats for the autopilot poker table: a many-entrant table, not a heads-up duel.
const POKER_TABLE_SEATS = Number(process.env.AUTOPILOT_POKER_SEATS ?? "6");
// Tasks (puzzles / prediction markets / World Cup events) per autopilot contest. Fewer
// tasks means fewer paced 0G calls, so a contest settles faster. Tunable.
const AUTOPILOT_TASK_COUNT = Number(process.env.AUTOPILOT_TASK_COUNT ?? "4");
// Gap between opening successive kinds within a day, so the daily set staggers in
// rather than all landing at once.
const OPEN_GAP_MS = Number(process.env.AUTOPILOT_OPEN_GAP_SECONDS ?? "120") * 1000;
// Once the day's full set is open, how long to hold before re-checking. The set
// refreshes at the next UTC-day rollover, when the kinds become eligible again.
const DAY_COMPLETE_HOLD_MS = Number(process.env.AUTOPILOT_DAY_HOLD_SECONDS ?? "1800") * 1000;
// A contest still open this long after its window closed was abandoned (the
// autopilot was down through its run). Refund the sponsor rather than run it late.
const STALE_AFTER_SEC = Number(process.env.AUTOPILOT_STALE_AFTER_SECONDS ?? "3600");
// Poker is the exception: the match is deterministic (no 0G calls in the betting loop)
// and hard-capped at POKER_MATCH_SECONDS (5 min), so a healthy poker contest settles a
// few minutes past its window close. One still unsettled well beyond that is genuinely
// stuck (a settlement that keeps failing), not a slow-but-legitimate run like a full
// Solver/Analyst field pacing 0G calls. Give poker a much tighter give-up ceiling so it
// reaches a terminal state (settled or refunded) in minutes, not an hour.
const POKER_STALE_AFTER_SEC = Number(process.env.AUTOPILOT_POKER_STALE_AFTER_SECONDS ?? "900");
function staleAfterFor(kind: ContestKind): number {
  return kind === "poker" ? POKER_STALE_AFTER_SEC : STALE_AFTER_SEC;
}
const WINDOW_S = Number(process.env.AUTOPILOT_WINDOW_SECONDS ?? "300");
const POOL_USDC = Number(process.env.AUTOPILOT_POOL_USDC ?? "30");
// Pools the autopilot picks from at random, so prizes vary contest to contest.
const POOL_CHOICES = [25, 30, 40, 50, 60, 70, 80, 100];
const HOUSE_SIZE = Number(process.env.AUTOPILOT_HOUSE ?? "4");
// Non-poker contests (prediction, puzzle, World Cup) only need a small baseline field
// to be watchable, so the house tops up to this rather than the full seat cap. Fewer
// house seats means a smaller fill, which the poll can start much closer to the close,
// so real players keep the seats and the house does not swarm in early. Poker still
// fills the whole table, where a full table is the point.
const HOUSE_BASELINE = Number(process.env.AUTOPILOT_HOUSE_BASELINE ?? "2");
// How often the due-sweeper checks for contests whose join window has closed and
// runs them. This is the main source of the gap between a window closing and the run
// starting, so keep it short. Tunable with AUTOPILOT_SWEEP_SECONDS.
const SWEEP_MS = Number(process.env.AUTOPILOT_SWEEP_SECONDS ?? "12") * 1000;

// Coordinator gas guard. The coordinator wallet pays for 0G Compute inference and for
// every settlement, cancel, and refund tx. If it runs dry, agents error and contests
// stop settling, which is what bit the live demo during judging. This watches the
// balance, warns loudly the moment it drops below the floor, and pauses auto-open so
// the arena does not create contests it cannot settle. Tunable via env.
const MIN_GAS_WEI = parseEther(process.env.COORDINATOR_MIN_GAS_0G ?? "2");
const GAS_CHECK_MS = Number(process.env.COORDINATOR_GAS_CHECK_SECONDS ?? "60") * 1000;
let coordGasLow = false;
export function coordinatorGasLow(): boolean {
  return coordGasLow;
}
export async function coordinatorGasBalance(): Promise<{ wei: bigint; og: number; low: boolean; min: number }> {
  const wei = await publicClient.getBalance({ address: coordinatorAccount().address });
  return { wei, og: Number(wei) / 1e18, low: wei < MIN_GAS_WEI, min: Number(MIN_GAS_WEI) / 1e18 };
}

async function startGasGuard(): Promise<void> {
  const addr = coordinatorAccount().address;
  const floor = process.env.COORDINATOR_MIN_GAS_0G ?? "2";
  for (;;) {
    try {
      const wei = await publicClient.getBalance({ address: addr });
      const og = (Number(wei) / 1e18).toFixed(3);
      const was = coordGasLow;
      coordGasLow = wei < MIN_GAS_WEI;
      if (coordGasLow && !was) {
        console.warn(
          `⚠️  COORDINATOR GAS LOW: ${og} 0G (floor ${floor}). Top up ${addr} now or agents, settlement, and cancels will fail.`,
        );
      } else if (!coordGasLow && was) {
        console.log(`coordinator gas recovered: ${og} 0G`);
      } else if (coordGasLow) {
        console.warn(`coordinator gas still low: ${og} 0G — top up ${addr}`);
      }
    } catch (err) {
      console.error("gas guard: balance check failed:", (err as Error).message);
    }
    await sleep(GAS_CHECK_MS);
  }
}
const RUN_TIMEOUT_MS = 1_200_000; // paced 0G calls make a full field take longer
// Poker runs no 0G calls in the match loop (a deterministic engine) and the match is
// capped at POKER_MATCH_SECONDS, so a healthy poker run (match + on-chain settle) is
// done in a few minutes. A tighter watchdog frees a hung poker run fast, so the next
// sweep retries or the stale ceiling refunds it, instead of holding the slot 20 minutes.
const POKER_RUN_TIMEOUT_MS = Number(process.env.POKER_RUN_TIMEOUT_MS ?? "600000"); // 10 min
function runTimeoutFor(kind: ContestKind): number {
  return kind === "poker" ? POKER_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS;
}

// The wait before the next open: the fixed override, or a jittered draw around
// the per-day average so gaps differ and drift across the clock day to day.
function nextGapMs(): number {
  if (FIXED_INTERVAL_MS) return FIXED_INTERVAL_MS;
  const swing = 1 + (Math.random() * 2 - 1) * GAP_JITTER;
  return Math.max(60_000, Math.floor(BASE_GAP_MS * swing));
}

// How many contests the database still considers live. Used to hold off opening
// when one is already up, so the feed does not stack.
async function openContestCount(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    "select count(*)::int as n from contests_meta where status in ('open','running')",
  );
  return Number(rows[0]?.n ?? 0);
}

const HOUSE_NAMES = ["Pixel", "Nova", "Byte", "Echo", "Quark", "Volt"];

// House agents span a mix of Compute tiers instead of a flat level-0 baseline, so the
// arena looks alive: the ladder shows a real gradient, poker is skill-based (a stronger
// tier out-plays a weaker one rather than a chaotic level-0 wipeout, and the winner is
// the strongest agent), and the higher-tier house agents actually have the model and the
// live-insight data to answer the hard puzzles instead of failing them. Comma-separated
// per agent, cycled across the roster. Tunable with AUTOPILOT_HOUSE_TIERS.
const HOUSE_TIERS = (process.env.AUTOPILOT_HOUSE_TIERS ?? "2,3,4,5")
  .split(",")
  .map((s) => Math.max(0, Math.min(5, Math.floor(Number(s.trim()) || 0))))
  .filter((n) => Number.isFinite(n));
function houseTierFor(i: number): number {
  return HOUSE_TIERS.length ? HOUSE_TIERS[i % HOUSE_TIERS.length]! : Math.min(5, i);
}

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

    // Assign this house agent its tier from the spread. Set on every startup so the
    // roster's gradient is stable. A real player who trains to Apex (5) still tops the
    // best house agent, so the leaderboard remains real players' to win.
    const level = houseTierFor(i);
    await query(
      `insert into agents_meta (agent_id, owner, name, compute_level, is_house) values ($1,$2,$3,$4,true)
         on conflict (agent_id) do update set
           name = excluded.name,
           compute_level = $4,
           is_house = true`,
      [agentId, account.address.toLowerCase(), name, level],
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

// Fill a contest up to `target` seats with house agents, taking only seats not
// already held by a real player or a house agent. House agents enter on chain like
// anyone else; the mirror row follows.
export async function seedHouseInto(contestId: number, target = HOUSE_SIZE): Promise<void> {
  const dep = loadDeployment();
  // House agents never enter duels (a duel is real-vs-real by rule) and never enter
  // challenges (they cannot pay the entry fee). The house only fills open, staked
  // contests. A duel that never gets its second real agent cancels and refunds.
  const { rows: metaRows } = await query<{ entry_fee: string | null; max_operators: number | null }>(
    "select entry_fee, max_operators from contests_meta where contest_id = $1",
    [contestId],
  );
  if (metaRows[0]?.max_operators === 2) return;
  if ((metaRows[0]?.entry_fee ?? "0") !== "0") return;
  const { rows: inRows } = await query<{ agent_id: string }>(
    "select agent_id from contest_entries where contest_id = $1",
    [contestId],
  );
  const already = new Set(inRows.map((r) => Number(r.agent_id)));
  const need = Math.max(0, target - already.size);
  if (need === 0) return;
  const house = (await ensureHouseRoster()).filter((h) => !already.has(h.agentId)).slice(0, need);
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

// How close to the window close the LAST house entry should land. Real players get
// almost the whole window to enter first before a house agent takes a seat.
const HOUSE_JOIN_LEAD_MS = Number(process.env.AUTOPILOT_HOUSE_JOIN_LEAD_SECONDS ?? "7") * 1000;
// How often the house-fill poll runs. Also the slack a fill window must exceed so a
// tick cannot skip over it.
const HOUSE_FILL_POLL_MS = Number(process.env.AUTOPILOT_HOUSE_FILL_POLL_MS ?? "5000");
// Rough time for one house entry to confirm on chain. Each empty seat is registered
// on chain in sequence, so the fill needs this much lead per seat to seat the whole
// field before the window closes.
const HOUSE_ENTRY_CONFIRM_MS = Number(process.env.AUTOPILOT_HOUSE_ENTRY_CONFIRM_MS ?? "4500");

// Contests whose house fill is in flight, so overlapping poll ticks do not double
// seat (and collide on the house wallet nonce).
const fillingHouse = new Set<number>();

// Deprecated: the house fill now runs on a dedicated poll (fillClosingContests),
// which is restart safe and scales its lead to the number of empty seats. A fixed
// per-contest timer fired too early for multi-seat tables and was lost on restart,
// so this is a no-op kept only for callers that still reference it.
export function scheduleHouseFill(_contestId: number, _target: number, _secondsUntilClose: number): void {
  // intentionally empty; see fillClosingContests / startHouseFillPoll
}

// Open contests (status OPEN = 1) whose window has closed, any sponsor.
interface DueContest {
  id: number;
  kind: ContestKind;
  overdueSec: number; // seconds since the entry window closed
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

  // Candidate ids: the recent on-chain window (covers contests not yet mirrored to
  // the database, like one just hosted) plus every id the database still considers
  // open or running. The database pass is what catches contests older than the
  // lookback window, which the recent scan alone would miss and leave open forever.
  const ids = new Set<number>();
  for (let id = latest; id >= floor; id--) ids.add(id);
  const { rows } = await query<{ contest_id: string }>(
    "select contest_id from contests_meta where status in ('open','running')",
  );
  for (const r of rows) {
    const id = Number(r.contest_id);
    if (id >= 1 && id <= latest) ids.add(id);
  }

  // World Cup missions stay on-chain OPEN while they wait for the real events to
  // resolve (deferred settlement). They are intentionally long-lived, so exclude them
  // here: otherwise the sweeper would re-run their forecast phase or, past the stale
  // cutoff, cancel and refund a mission that is simply waiting on Polymarket.
  const { rows: awaiting } = await query<{ contest_id: string }>(
    "select contest_id from contests_meta where status = 'awaiting_resolution'",
  );
  const parked = new Set(awaiting.map((r) => Number(r.contest_id)));

  const due: DueContest[] = [];
  for (const id of ids) {
    if (parked.has(id)) continue;
    const c = await publicClient.readContract({
      address: dep.contestEngine,
      abi: contestEngineAbi,
      functionName: "getContest",
      args: [BigInt(id)],
    });
    if (Number(c.status) === 1 && Number(c.endTime) <= nowSec) {
      due.push({ id, kind: kindFromMetric(c.metric as string), overdueSec: nowSec - Number(c.endTime) });
    }
  }
  return due.sort((a, b) => a.id - b.id); // oldest first
}

// Make sure a contests_meta row exists for an on-chain contest, so the runner
// and the API have its kind and pool. Covers user-hosted contests too.
async function ensureContestMeta(id: number): Promise<void> {
  const dep = loadDeployment();
  const c = await publicClient.readContract({
    address: dep.contestEngine,
    abi: contestEngineAbi,
    functionName: "getContest",
    args: [BigInt(id)],
  });
  const kind = kindFromMetric(c.metric as string);
  const metricLabel =
    kind === "analyst" ? "PREDICTION" : kind === "poker" ? "POKER" : kind === "worldcup" ? "WORLDCUP" : "PUZZLE";
  await query(
    `insert into contests_meta (contest_id, status, puzzle_count, metric, prize_pool, kind, ends_at)
       values ($1, 'open', 4, $2, $3, $4, to_timestamp($5))
       on conflict (contest_id) do update set
         kind = excluded.kind, prize_pool = excluded.prize_pool, ends_at = excluded.ends_at`,
    [id, metricLabel, c.prizePool.toString(), kind, Number(c.endTime)],
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

// Fill the house into any open contest that is about to close and is still short of
// its target field, so real players get almost the whole window to enter first. The
// lead scales with how many seats are empty: a 1-seat duel fills only ~7-12s before
// close (real players keep nearly the whole window), while a bigger table gets the
// head start it needs to seat every house agent on chain before the window shuts.
// Runs on a dedicated poll, so it survives restarts (unlike a per-contest timer).
async function fillClosingContests(): Promise<void> {
  const nowMs = Date.now();
  const { rows } = await query<{ contest_id: string; kind: string | null; max_operators: number | null; agent_count: number | null; ends_at_ms: string | null }>(
    `select contest_id, kind, max_operators, agent_count, (extract(epoch from ends_at) * 1000)::bigint as ends_at_ms
       from contests_meta where status = 'open' and ends_at is not null`,
  );
  for (const r of rows) {
    const id = Number(r.contest_id);
    if (fillingHouse.has(id)) continue; // a fill for this contest is already running
    const endsAtMs = Number(r.ends_at_ms ?? 0);
    if (endsAtMs <= nowMs) continue; // window already closed
    // Seed every contest to a full field: any seat still empty near close is taken by
    // a house agent, so a contest never runs under-seated. A capped contest fills to
    // its cap; an uncapped field fills to the full house roster (HOUSE_SIZE). Real
    // players still get almost the whole window first (the house joins in the final
    // seconds, scaled lead below), and the fill is bounded by the roster. Duels and
    // challenges are refused inside seedHouseInto, so the house never enters those.
    const cap = r.max_operators ?? HOUSE_SIZE;
    const target = cap;
    const need = target - (r.agent_count ?? 0);
    if (need <= 0) continue; // already at the target field

    // Start just early enough that every needed house entry confirms before close:
    // a base lead (floor), or one confirmation window per empty seat if that is
    // longer, plus the poll gap so a tick cannot miss the window.
    const leadMs = Math.max(HOUSE_JOIN_LEAD_MS, need * HOUSE_ENTRY_CONFIRM_MS) + HOUSE_FILL_POLL_MS;
    if (endsAtMs - nowMs > leadMs) continue; // not close enough to the window yet

    // Fill contests one at a time. House agents share a small roster of wallets, so
    // running fills concurrently could make the same house wallet send two entries at
    // once and drop one on a nonce clash, silently under-seating a contest. Sequential
    // fills keep each house wallet's nonces in order; the poll already awaits this.
    fillingHouse.add(id);
    try {
      await seedHouseInto(id, target);
    } catch (e) {
      console.error(`autopilot: house fill for ${id} failed:`, (e as Error).message);
    } finally {
      fillingHouse.delete(id);
    }
  }
}

// The dedicated house-fill loop. Runs far more often than the settle sweeper so the
// house can join late (near close) yet reliably, independent of restarts.
async function startHouseFillPoll(): Promise<void> {
  for (;;) {
    await sleep(HOUSE_FILL_POLL_MS);
    try {
      await fillClosingContests();
    } catch (err) {
      console.error("autopilot: house fill poll failed:", (err as Error).message);
    }
  }
}

const inFlight = new Set<number>();

async function runOnce(id: number, kind: ContestKind): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    await ensureContestMeta(id).catch(() => {});
    const runner =
      kind === "analyst"
        ? runAnalystContest
        : kind === "poker"
          ? runPokerContest
          : kind === "worldcup"
            ? runWorldCupContest
            : runContest;
    const work = runner(id);
    work.catch(() => {}); // the awaiter below handles errors; avoid an unhandled rejection
    // Race the run against a watchdog. Releasing the in-flight slot in the finally
    // (rather than only when `work` resolves) is critical: a runner that HANGS — a 0G
    // Compute call or an RPC read that never returns — would otherwise never clear the
    // slot, and since the sweeper skips any in-flight contest, that contest would sit
    // OPEN forever, never retried and never even reaching the stale-refund path. With
    // the slot freed after the watchdog fires, the next sweep retries it, or refunds
    // it once it is stale. The hung promise, if it ever settles, no longer holds the
    // slot.
    await Promise.race([
      work,
      new Promise((_, reject) => setTimeout(() => reject(new Error("watchdog")), runTimeoutFor(kind))),
    ]).catch((err) => {
      console.error(`autopilot: contest ${id} watchdog: ${(err as Error).message}`);
    });
  } finally {
    inFlight.delete(id);
  }
}

async function startDueSweeper(): Promise<void> {
  for (;;) {
    await sleep(SWEEP_MS);
    try {
      for (const d of await findDueContests()) {
        if (inFlight.has(d.id)) continue;
        if (d.overdueSec > staleAfterFor(d.kind)) {
          // Overdue past this kind's ceiling and not currently running: either it never
          // ran (the autopilot was down through it) or its settlement keeps failing.
          // Running it now would score a stale field, and for poker a stuck settlement
          // should not linger, so refund the sponsor/entrants and let it leave the open
          // state instead of showing "running" indefinitely.
          console.log(
            `autopilot: contest ${d.id} (${d.kind}) abandoned ${Math.round(d.overdueSec / 60)}m past close, refunding`,
          );
          await cancelContest(d.id).catch((err) =>
            console.error(`autopilot: cancel ${d.id} failed:`, (err as Error).message),
          );
          continue;
        }
        console.log(`autopilot: settling due ${d.kind} contest ${d.id}`);
        await runOnce(d.id, d.kind).catch((err) =>
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

// The set of contest kinds already opened today (UTC day). The daily opener opens
// exactly one of each kind per day; this is what enforces that. It counts any contest
// of a kind created today, so it is restart-safe (survives a coordinator restart
// mid-day) and also stands down on a kind a user hosted today.
async function kindsOpenedToday(): Promise<Set<string>> {
  const { rows } = await query<{ kind: string | null }>(
    "select distinct kind from contests_meta where created_at >= date_trunc('day', now())",
  );
  return new Set(rows.map((r) => (r.kind ?? "").toLowerCase()).filter(Boolean));
}

async function startOpenLoop(): Promise<void> {
  // Build (and tier-upgrade) the house roster once up front. The first-time upgrade
  // takes longer than a contest window, so warming it here keeps the first contest's
  // house fill ready before its window closes.
  await ensureHouseRoster().catch((err) =>
    console.error("autopilot: house warmup failed:", (err as Error).message),
  );
  // Open exactly one contest of each configured kind per UTC day, every one a
  // many-entrant field (poker as a multi-seat table, the rest as open fields). The
  // house-fill poll seeds each field with platform agents ~7s before its close, so
  // there is always a field to watch. When the day's full set is out, hold until the
  // next day, when the kinds become eligible again.
  for (;;) {
    // Do not open contests the coordinator cannot afford to settle.
    if (coordinatorGasLow()) {
      console.warn("autopilot: coordinator gas low, holding auto-open until it is topped up");
      await sleep(GAS_CHECK_MS);
      continue;
    }
    let waitMs = OPEN_GAP_MS;
    try {
      const opened = await kindsOpenedToday();
      const remaining = DAILY_KINDS.filter((k) => !opened.has(k));
      if (remaining.length === 0) {
        console.log("autopilot: one of each kind already open today; holding for the next day");
        waitMs = DAY_COMPLETE_HOLD_MS;
      } else {
        const kind = remaining[0]!;
        const isPoker = kind === "poker";
        // Poker is a multi-seat table; every other kind is an open, uncapped field.
        // Neither is a duel. The house fills the seats near close (see the house-fill
        // poll), bounded by the house roster.
        const seatCap = isPoker ? POKER_TABLE_SEATS : undefined;
        const winnerTakeAll = isPoker; // poker: chip leader takes it; fields pay the top 3
        const pool = POOL_CHOICES[Math.floor(Math.random() * POOL_CHOICES.length)]!;
        console.log(`autopilot: opening today's ${kind} field (${pool} tUSDC)`);
        const id = await openContest({
          prizePoolUsdc: pool,
          durationSecs: WINDOW_S,
          topN: winnerTakeAll ? 1 : 3,
          puzzleCount: AUTOPILOT_TASK_COUNT,
          kind,
          maxOperators: seatCap,
        });
        console.log(`autopilot: ${kind} ${id} open; house seeds the field ~7s before close`);
      }
    } catch (err) {
      console.error("autopilot open failed:", (err as Error).message);
    }
    await sleep(waitMs);
  }
}

export function autopilotEnabled(): boolean {
  return (process.env.AUTOPILOT ?? "off").toLowerCase() === "on" && Boolean(config.signerKey);
}

export function startAutopilot(): void {
  // The coordinator needs its signer key to send any settlement transaction.
  if (!config.signerKey) {
    console.warn("coordinator: no signer key; settlement and autopilot are both off.");
    return;
  }

  // Settlement, World Cup resolution, house fills, and the gas guard run whenever the
  // coordinator is up, independent of the AUTOPILOT toggle. Otherwise user-hosted
  // contests (poker duels, challenges, missions) never get run, settled, cancelled, or
  // resolved, and sit OPEN forever. AUTOPILOT only controls whether the platform also
  // opens its own contests.
  void startGasGuard();
  void startDueSweeper();
  void startWorldCupResolver();
  void startHouseFillPoll();

  // Print the live tier -> model routing once, so it is obvious from the logs whether
  // the premium tiers actually reach the stronger 0G models or fall back to the base
  // model. This is the "is multi-model real on testnet?" answer, on every boot.
  if (computeMode() === "0g-compute") {
    const tierModels = Array.from({ length: MAX_COMPUTE_LEVEL + 1 }, (_, l) => computePlan(l).models ?? []);
    void logTierRouting(tierModels);
  }

  if (autopilotEnabled()) {
    console.log(
      `autopilot: on. Opening one of each kind [${DAILY_KINDS.join(", ")}] per day as many-entrant ` +
        `fields, ${WINDOW_S}s window, house-seeded ~7s before close.`,
    );
    void startOpenLoop();
  } else {
    console.log("coordinator: settlement, World Cup resolver, and house fill running; auto-open is off.");
  }
}
