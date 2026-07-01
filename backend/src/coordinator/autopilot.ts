import { createWalletClient, http, keccak256, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config/index.js";
import { query } from "../db/pool.js";
import { openContest, kindFromMetric } from "./contestOps.js";
import { runContest } from "./runContest.js";
import { runAnalystContest } from "./runAnalystContest.js";
import { runPokerContest } from "./runPokerContest.js";
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

function pickAutopilotKind(): "poker" | "analyst" | "solver" {
  const total = Math.max(1, W_POKER + W_PREDICTION + W_PUZZLE);
  const r = Math.random() * total;
  if (r < W_POKER) return "poker";
  if (r < W_POKER + W_PREDICTION) return "analyst";
  return "solver";
}
// A contest still open this long after its window closed was abandoned (the
// autopilot was down through its run). Refund the sponsor rather than run it late.
const STALE_AFTER_SEC = Number(process.env.AUTOPILOT_STALE_AFTER_SECONDS ?? "3600");
const WINDOW_S = Number(process.env.AUTOPILOT_WINDOW_SECONDS ?? "300");
const POOL_USDC = Number(process.env.AUTOPILOT_POOL_USDC ?? "30");
// Pools the autopilot picks from at random, so prizes vary contest to contest.
const POOL_CHOICES = [25, 30, 40, 50, 60, 70, 80, 100];
const HOUSE_SIZE = Number(process.env.AUTOPILOT_HOUSE ?? "4");
const SWEEP_MS = 30_000;
const RUN_TIMEOUT_MS = 1_200_000; // paced 0G calls make a full field take longer

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

// Fill a contest up to `target` seats with house agents, taking only seats not
// already held by a real player or a house agent. House agents enter on chain like
// anyone else; the mirror row follows.
export async function seedHouseInto(contestId: number, target = HOUSE_SIZE): Promise<void> {
  const dep = loadDeployment();
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
  kind: "solver" | "analyst" | "poker";
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

  const due: DueContest[] = [];
  for (const id of ids) {
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
  const metricLabel = kind === "analyst" ? "PREDICTION" : kind === "poker" ? "POKER" : "PUZZLE";
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
  const { rows } = await query<{ contest_id: string; max_operators: number | null; agent_count: number | null; ends_at_ms: string | null }>(
    `select contest_id, max_operators, agent_count, (extract(epoch from ends_at) * 1000)::bigint as ends_at_ms
       from contests_meta where status = 'open' and ends_at is not null`,
  );
  for (const r of rows) {
    const id = Number(r.contest_id);
    if (fillingHouse.has(id)) continue; // a fill for this contest is already running
    const endsAtMs = Number(r.ends_at_ms ?? 0);
    if (endsAtMs <= nowMs) continue; // window already closed
    const target = r.max_operators ?? HOUSE_SIZE;
    const need = target - (r.agent_count ?? 0);
    if (need <= 0) continue; // already full

    // Start just early enough that every needed house entry confirms before close:
    // a base lead (floor), or one confirmation window per empty seat if that is
    // longer, plus the poll gap so a tick cannot miss the window.
    const leadMs = Math.max(HOUSE_JOIN_LEAD_MS, need * HOUSE_ENTRY_CONFIRM_MS) + HOUSE_FILL_POLL_MS;
    if (endsAtMs - nowMs > leadMs) continue; // not close enough to the window yet

    fillingHouse.add(id);
    void seedHouseInto(id, target)
      .catch((e) => console.error(`autopilot: house fill for ${id} failed:`, (e as Error).message))
      .finally(() => fillingHouse.delete(id));
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

async function runOnce(id: number, kind: "solver" | "analyst" | "poker"): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  await ensureContestMeta(id).catch(() => {});
  const runner = kind === "analyst" ? runAnalystContest : kind === "poker" ? runPokerContest : runContest;
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
        if (d.overdueSec > STALE_AFTER_SEC) {
          // Window closed long ago and it never ran (the autopilot was down through
          // it). Running it now would score a stale field, so refund the sponsor and
          // let it leave the open state.
          console.log(
            `autopilot: contest ${d.id} abandoned ${Math.round(d.overdueSec / 60)}m past close, refunding`,
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

async function startOpenLoop(): Promise<void> {
  // Build (and tier-upgrade) the house roster once up front. The first-time
  // upgrade takes longer than a contest window, so warming it here keeps the
  // first contest from closing before the house can join.
  await ensureHouseRoster().catch((err) =>
    console.error("autopilot: house warmup failed:", (err as Error).message),
  );
  // Lead with Solver contests: that is the reasoning arena where Compute reliably
  // wins. Analyst contests forecast real markets, which is knowledge-bound (the
  // model cannot out-forecast an event it has no data on), so they run only every
  // Nth cycle. Set AUTOPILOT_ANALYST_EVERY=0 for solver-only, 2 for an even split.
  for (;;) {
    let held = false;
    try {
      const open = await openContestCount().catch(() => 0);
      if (open >= MAX_OPEN) {
        // One is still up. Skip this slot rather than stack the feed, and re-check
        // soon (not a full gap later) so a contest opens shortly after the sweeper
        // resolves the current one.
        held = true;
        console.log(`autopilot: ${open} contest(s) still open, holding this slot`);
      } else {
        const kind = pickAutopilotKind();
        // Poker opens as a heads-up duel, or a multi-player table part of the time; a
        // prediction opens as a 1v1 duel part of the time so both fill the duels tab.
        // Puzzles stay a full field.
        const pokerTable = kind === "poker" && Math.random() < POKER_TABLE_PCT;
        const isDuel =
          kind === "poker" ? !pokerTable : kind === "analyst" ? Math.random() < PREDICTION_DUEL_PCT : false;
        const seatCap = pokerTable ? 6 : isDuel ? 2 : undefined;
        const houseSeats = pokerTable ? 6 : isDuel ? 2 : HOUSE_SIZE;
        // Poker is winner-take-all whether duel or table; other contests rank a field.
        const winnerTakeAll = kind === "poker" || isDuel;
        const format = pokerTable ? "table" : isDuel ? "duel" : "contest";
        // Vary the pool so the arena does not look canned.
        const pool = POOL_CHOICES[Math.floor(Math.random() * POOL_CHOICES.length)]!;
        console.log(`autopilot: opening a ${kind} ${format} (${pool} tUSDC)`);
        const id = await openContest({
          prizePoolUsdc: pool,
          durationSecs: WINDOW_S,
          topN: winnerTakeAll ? 1 : 3,
          puzzleCount: 6,
          kind,
          maxOperators: seatCap,
        });
        // The house fills any empty seats near the end of the window, not now, so
        // real players have the whole window to join first.
        scheduleHouseFill(id, houseSeats, WINDOW_S);
        console.log(`autopilot: ${kind} ${format} ${id} open, house fills near close`);
      }
    } catch (err) {
      console.error("autopilot open failed:", (err as Error).message);
    }
    await sleep(held ? HOLD_RETRY_MS : nextGapMs());
  }
}

export function autopilotEnabled(): boolean {
  return (process.env.AUTOPILOT ?? "off").toLowerCase() === "on" && Boolean(config.signerKey);
}

export function startAutopilot(): void {
  if (!autopilotEnabled()) return;
  const cadence = FIXED_INTERVAL_MS
    ? `every ${FIXED_INTERVAL_MS / 1000}s`
    : `~${PER_DAY}/day (±${Math.round(GAP_JITTER * 100)}%)`;
  console.log(
    `autopilot: on. opening ${cadence}, ${WINDOW_S}s window, ${POOL_USDC} tUSDC pool, max ${MAX_OPEN} open.`,
  );
  void startOpenLoop();
  void startDueSweeper();
  void startHouseFillPoll();
}
