import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "../config/index.js";
import { query } from "../db/pool.js";
import { computeMode, computeConfigured } from "../compute/client.js";
import {
  deploymentReady,
  loadDeployment,
  publicClient,
  contestEngineAbi,
  testUsdcAbi,
  coordinatorAddress,
  coordinatorWallet,
  coordinatorAccount,
  waitReceipt,
  GAS_PRICE,
} from "../chain/contracts.js";
import {
  nextLevelCostWei,
  MAX_COMPUTE_LEVEL,
  computeLevelClamp,
  COMPUTE_COSTS_OG,
} from "../runners/computeLevels.js";
import { storageConfigured, uploadBytes, downloadBytes } from "../storage/zgStorage.js";
import { openContest, onchainEntryCount } from "../coordinator/contestOps.js";
import { runContest } from "../coordinator/runContest.js";
import { runAnalystContest } from "../coordinator/runAnalystContest.js";
import { cancelContest, resettleFromStored } from "../coordinator/finalize.js";

// Read API plus the admin/demo triggers. The live feed itself goes over the
// WebSocket; these endpoints serve initial loads, lookups, and the proofs
// winners need to claim.

export const app = new Hono();
app.use("/*", cors());

const adminToken = process.env.ADMIN_TOKEN ?? "";
function adminOk(c: { req: { header: (k: string) => string | undefined } }): boolean {
  if (!adminToken) return true; // open on the testnet MVP if no token set
  return c.req.header("x-admin-token") === adminToken;
}

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/compute/status", (c) =>
  c.json({ mode: computeMode(), configured: computeConfigured() }),
);

app.get("/api/storage/status", (c) => c.json({ enabled: storageConfigured() }));

// Arena-wide stats for the home page.
app.get("/api/stats", async (c) => {
  const { rows } = await query(
    `select
       (select count(*)::int from contests_meta) as contests,
       (select count(*)::int from contests_meta where status = 'settled') as settled,
       (select count(*)::int from contests_meta where status in ('open','pending','running','active')) as live,
       (select count(*)::int from agents_meta) as agents,
       (select count(*)::int from solve_runs where source = '0g-compute') as og_calls,
       (select coalesce(sum(prize_pool::numeric), 0)::text from contests_meta where status = 'settled') as settled_pool`,
  );
  return c.json(rows[0] ?? {});
});

// tUSDC faucet, capped to 100 tUSDC per operator per rolling 7 days so it cannot
// be farmed. The coordinator mints to the operator and pays the gas.
const USDC_WEEKLY_CAP = 100_000000n; // 100 tUSDC (6 decimals)

async function usdcClaimedThisWeek(owner: string): Promise<bigint> {
  const { rows } = await query<{ sum: string }>(
    `select coalesce(sum(amount_wei::numeric), 0)::text as sum
       from usdc_claims where lower(operator) = $1 and created_at > now() - interval '7 days'`,
    [owner],
  );
  return BigInt(rows[0]?.sum ?? "0");
}

// How much of the weekly faucet an operator has left, so the UI can disable the
// claim button before they try.
app.get("/api/faucet/usdc", async (c) => {
  const owner = String(c.req.query("owner") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) {
    return c.json({ remainingWei: USDC_WEEKLY_CAP.toString(), capped: false });
  }
  const claimed = await usdcClaimedThisWeek(owner);
  const remaining = USDC_WEEKLY_CAP - claimed;
  return c.json({
    claimedWei: claimed.toString(),
    remainingWei: (remaining > 0n ? remaining : 0n).toString(),
    capped: remaining <= 0n,
  });
});

app.post("/api/faucet/usdc", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const owner = String(body.owner ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) return c.json({ error: "a valid wallet is required" }, 400);

  const claimedWei = await usdcClaimedThisWeek(owner);
  const remaining = USDC_WEEKLY_CAP - claimedWei;
  if (remaining <= 0n) {
    return c.json(
      { error: "you have claimed your 100 tUSDC for this week. It resets in a few days." },
      429,
    );
  }

  const dep = loadDeployment();
  const hash = await coordinatorWallet().writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "mint",
    args: [owner as `0x${string}`, remaining],
    account: coordinatorAccount(),
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await waitReceipt(hash);
  await query("insert into usdc_claims (operator, amount_wei) values ($1, $2)", [owner, remaining.toString()]);
  return c.json({ ok: true, minted: remaining.toString(), txHash: hash });
});

// Where training payments go, and the 0G cost ladder, so the frontend can send
// the right amount to the right address.
app.get("/api/compute/info", (c) =>
  c.json({
    coordinator: coordinatorAddress(),
    costsOg: COMPUTE_COSTS_OG,
    maxLevel: MAX_COMPUTE_LEVEL,
  }),
);

// Train an agent: the owner paid 0G to the coordinator (which funds the 0G
// Compute ledger). We verify that on-chain payment, credit one compute level, and
// record the transaction so it can never be reused.
app.post("/api/agents/:id/train", async (c) => {
  const agentId = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const owner = String(body.owner ?? "").toLowerCase();
  const txHash = String(body.txHash ?? "");
  if (!agentId || !owner || !txHash) return c.json({ error: "agentId, owner, and txHash required" }, 400);

  const own = await query<{ owner: string; compute_level: number }>(
    "select owner, compute_level from agents_meta where agent_id = $1",
    [agentId],
  );
  if (own.rows.length === 0) return c.json({ error: "unknown agent" }, 404);
  if (own.rows[0]!.owner.toLowerCase() !== owner) return c.json({ error: "not your agent" }, 403);
  const current = own.rows[0]!.compute_level ?? 0;
  if (current >= MAX_COMPUTE_LEVEL) return c.json({ error: "this agent is already at max compute" }, 409);

  const used = await query("select 1 from compute_trainings where tx_hash = $1", [txHash]);
  if (used.rows.length > 0) return c.json({ error: "that payment was already used" }, 409);

  const cost = nextLevelCostWei(current)!;
  let tx: Awaited<ReturnType<typeof publicClient.getTransaction>>;
  let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>;
  try {
    receipt = await waitReceipt(txHash as `0x${string}`);
    tx = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
  } catch {
    return c.json({ error: "could not read that payment yet, give it a moment and retry" }, 400);
  }
  if (receipt.status !== "success") return c.json({ error: "that payment did not go through" }, 400);
  if (tx.from.toLowerCase() !== owner) return c.json({ error: "that payment was not from your wallet" }, 400);
  if ((tx.to ?? "").toLowerCase() !== coordinatorAddress().toLowerCase()) {
    return c.json({ error: "that payment went to the wrong address" }, 400);
  }
  if (tx.value < cost) return c.json({ error: "that payment was not enough for the next level" }, 400);

  const levelAfter = computeLevelClamp(current + 1);
  await query("update agents_meta set compute_level = $2 where agent_id = $1", [agentId, levelAfter]);
  await query(
    "insert into compute_trainings (tx_hash, agent_id, operator, amount_wei, level_after) values ($1,$2,$3,$4,$5)",
    [txHash, agentId, owner, tx.value.toString(), levelAfter],
  );
  return c.json({ ok: true, computeLevel: levelAfter });
});

// --- Admin support tools (gated by x-admin-token) ---------------------------

// Verify a token so the console can act as a login gate.
app.get("/api/admin/check", (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ ok: true });
});

// Inspect an agent: owner, compute level, and recent training payments.
app.get("/api/admin/agent/:id", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const agentId = Number(c.req.param("id"));
  if (!agentId) return c.json({ error: "agentId required" }, 400);
  const a = await query(
    "select agent_id, owner, name, compute_level, is_house from agents_meta where agent_id = $1",
    [agentId],
  );
  if (a.rows.length === 0) return c.json({ error: "unknown agent" }, 404);
  const trainings = await query(
    "select tx_hash, amount_wei, level_after, created_at from compute_trainings where agent_id = $1 order by created_at desc limit 10",
    [agentId],
  );
  return c.json({ agent: a.rows[0], trainings: trainings.rows });
});

// Credit a training payment that did not reflect (e.g. an RPC blip during the
// normal flow). Re-reads the on-chain payment with robust polling and credits
// the level if it checks out and was not already used.
app.post("/api/admin/credit-training", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const agentId = Number(body.agentId);
  const txHash = String(body.txHash ?? "");
  if (!agentId || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return c.json({ error: "agentId and a valid txHash are required" }, 400);
  }

  const own = await query<{ owner: string; compute_level: number }>(
    "select owner, compute_level from agents_meta where agent_id = $1",
    [agentId],
  );
  if (own.rows.length === 0) return c.json({ error: "unknown agent" }, 404);
  const current = own.rows[0]!.compute_level ?? 0;
  if (current >= MAX_COMPUTE_LEVEL) return c.json({ error: "agent is already at max compute" }, 409);

  const used = await query("select 1 from compute_trainings where tx_hash = $1", [txHash]);
  if (used.rows.length > 0) return c.json({ error: "that payment was already credited" }, 409);

  const cost = nextLevelCostWei(current)!;
  let tx: Awaited<ReturnType<typeof publicClient.getTransaction>>;
  let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>;
  try {
    receipt = await waitReceipt(txHash as `0x${string}`);
    tx = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
  } catch {
    return c.json({ error: "could not read that payment from the chain" }, 400);
  }
  if (receipt.status !== "success") return c.json({ error: "that payment failed on chain" }, 400);
  if ((tx.to ?? "").toLowerCase() !== coordinatorAddress().toLowerCase()) {
    return c.json({ error: "that payment went to the wrong address" }, 400);
  }
  if (tx.value < cost) {
    return c.json({ error: `payment too small for the next level (${tx.value} < ${cost})` }, 400);
  }

  const levelAfter = computeLevelClamp(current + 1);
  await query("update agents_meta set compute_level = $2 where agent_id = $1", [agentId, levelAfter]);
  await query(
    "insert into compute_trainings (tx_hash, agent_id, operator, amount_wei, level_after) values ($1,$2,$3,$4,$5)",
    [txHash, agentId, tx.from.toLowerCase(), tx.value.toString(), levelAfter],
  );
  return c.json({ ok: true, computeLevel: levelAfter, owner: tx.from.toLowerCase() });
});

// Emergency override: set an agent's compute level directly.
app.post("/api/admin/set-compute", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const agentId = Number(body.agentId);
  const level = computeLevelClamp(Number(body.level));
  if (!agentId) return c.json({ error: "agentId required" }, 400);
  const a = await query("select 1 from agents_meta where agent_id = $1", [agentId]);
  if (a.rows.length === 0) return c.json({ error: "unknown agent" }, 404);
  await query("update agents_meta set compute_level = $2 where agent_id = $1", [agentId, level]);
  return c.json({ ok: true, computeLevel: level });
});

// Diagnose an operator: their agents, on-chain tUSDC balance (why they cannot
// host or enter is usually here), faucet claims, and contests they touched.
app.get("/api/admin/operator/:address", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const owner = String(c.req.param("address")).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) return c.json({ error: "a valid address is required" }, 400);

  const agents = await query(
    "select agent_id, name, compute_level, is_house from agents_meta where lower(owner) = $1 order by agent_id asc",
    [owner],
  );
  const claimed = await query<{ sum: string }>(
    `select coalesce(sum(amount_wei::numeric), 0)::text as sum from usdc_claims
       where lower(operator) = $1 and created_at > now() - interval '7 days'`,
    [owner],
  );
  const contests = await query(
    `select distinct e.contest_id, c.status, c.kind
       from contest_entries e join contests_meta c on c.contest_id = e.contest_id
      where lower(e.operator) = $1 order by e.contest_id desc limit 10`,
    [owner],
  );

  let usdcWei = "0";
  try {
    const bal = (await publicClient.readContract({
      address: loadDeployment().testUSDC,
      abi: testUsdcAbi,
      functionName: "balanceOf",
      args: [owner as `0x${string}`],
    })) as bigint;
    usdcWei = bal.toString();
  } catch {
    /* leave 0 */
  }

  return c.json({
    owner,
    usdcWei,
    usdcClaimedThisWeekWei: claimed.rows[0]?.sum ?? "0",
    agents: agents.rows,
    contests: contests.rows,
  });
});

// Grant tUSDC to an operator (no weekly cap). Unblocks a user who cannot host or
// enter for lack of funds.
app.post("/api/admin/grant-usdc", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const owner = String(body.owner ?? "").toLowerCase();
  const amount = Number(body.amount);
  if (!/^0x[0-9a-f]{40}$/.test(owner)) return c.json({ error: "a valid address is required" }, 400);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    return c.json({ error: "amount must be between 0 and 100000 tUSDC" }, 400);
  }
  const amountWei = BigInt(Math.round(amount * 1_000_000)); // tUSDC has 6 decimals
  const hash = await coordinatorWallet().writeContract({
    address: loadDeployment().testUSDC,
    abi: testUsdcAbi,
    functionName: "mint",
    args: [owner as `0x${string}`, amountWei],
    account: coordinatorAccount(),
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await waitReceipt(hash);
  return c.json({ ok: true, mintedWei: amountWei.toString(), txHash: hash });
});

// Inspect a contest: stored status vs the on-chain entry count, so a stuck or
// mis-mirrored contest is obvious.
app.get("/api/admin/contest/:id", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "contest id required" }, 400);
  const meta = await query(
    "select contest_id, status, kind, prize_pool, agent_count, max_operators, ends_at, settled_at from contests_meta where contest_id = $1",
    [id],
  );
  if (meta.rows.length === 0) return c.json({ error: "unknown contest" }, 404);
  const dbEntries = await query<{ n: string }>(
    "select count(*)::text as n from contest_entries where contest_id = $1",
    [id],
  );
  const onchain = await onchainEntryCount(id).catch(() => -1);
  return c.json({
    contest: meta.rows[0],
    dbEntries: Number(dbEntries.rows[0]?.n ?? "0"),
    onchainEntries: onchain,
  });
});

// Recover a stuck contest: resume settlement from the stored root, or cancel it.
app.post("/api/admin/contest/:id/resettle", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "contest id required" }, 400);
  await resettleFromStored(id);
  return c.json({ ok: true });
});

app.post("/api/admin/contest/:id/cancel", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "contest id required" }, 400);
  await cancelContest(id);
  return c.json({ ok: true });
});

app.get("/api/deployment", (c) => {
  if (!deploymentReady()) return c.json({ ready: false });
  const dep = loadDeployment();
  return c.json({
    ready: true,
    chainId: config.chain.chainId,
    rpcUrl: config.chain.rpcUrl,
    explorer: config.chain.explorer,
    contracts: {
      testUSDC: dep.testUSDC,
      prizeEscrow: dep.prizeEscrow,
      agentRegistry: dep.agentRegistry,
      contestEngine: dep.contestEngine,
    },
  });
});

app.get("/api/contests", async (c) => {
  const { rows } = await query(
    `select contest_id, status, kind, puzzle_count, agent_count, metric, prize_pool, final_root, created_at, settled_at
       from contests_meta order by contest_id desc`,
  );
  return c.json({ contests: rows });
});

app.get("/api/contests/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { rows } = await query("select * from contests_meta where contest_id = $1", [id]);
  if (rows.length === 0) return c.json({ error: "not found" }, 404);
  const standings = await standingsFor(id);
  return c.json({ contest: rows[0], standings });
});

app.get("/api/contests/:id/feed", async (c) => {
  const id = Number(c.req.param("id"));
  const since = Number(c.req.query("since") ?? "0");
  const { rows } = await query(
    `select id, agent_id, operator, puzzle_idx, prompt, answer, verdict, source, provider, model, chat_id, verified, latency_ms, created_at
       from solve_runs where contest_id = $1 and id > $2 order by id asc limit 500`,
    [id, since],
  );
  return c.json({ feed: rows });
});

app.get("/api/contests/:id/standings", async (c) => {
  const id = Number(c.req.param("id"));
  return c.json({ standings: await standingsFor(id) });
});

// Register a contest an operator hosted on chain (they ran mint, approve, and
// listContest from their own wallet). We confirm it on chain and mirror it so it
// shows in the arena; the due-sweeper settles it when the window closes.
app.post("/api/contests/host", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = Number(body.contestId);
  const kind = body.kind === "analyst" ? "analyst" : "solver";
  const puzzleCount = Number(body.puzzleCount ?? (kind === "analyst" ? 4 : 5));
  const maxOperators = Number(body.maxOperators ?? 0) > 0 ? Number(body.maxOperators) : null;
  if (!id) return c.json({ error: "contestId required" }, 400);

  const dep = loadDeployment();
  const con = await publicClient.readContract({
    address: dep.contestEngine,
    abi: contestEngineAbi,
    functionName: "getContest",
    args: [BigInt(id)],
  });
  if (con.sponsor === "0x0000000000000000000000000000000000000000") {
    return c.json({ error: "contest not found on chain" }, 404);
  }

  await query(
    `insert into contests_meta (contest_id, status, puzzle_count, metric, prize_pool, kind, ends_at, max_operators)
       values ($1, 'open', $2, $3, $4, $5, to_timestamp($6), $7)
       on conflict (contest_id) do update set
         puzzle_count = excluded.puzzle_count, kind = excluded.kind,
         prize_pool = excluded.prize_pool, ends_at = excluded.ends_at,
         max_operators = excluded.max_operators`,
    [id, puzzleCount, kind === "analyst" ? "PREDICTION" : "PUZZLE", con.prizePool.toString(), kind, Number(con.endTime), maxOperators],
  );
  return c.json({ ok: true, contestId: id, kind });
});

app.post("/api/contests/:id/enter", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const agentId = Number(body.agentId);
  const operator = String(body.operator ?? "").toLowerCase();
  if (!agentId || !operator) return c.json({ error: "agentId and operator required" }, 400);

  // Only the join window accepts entries, and only up to the host's cap.
  const meta = await query<{ status: string; max_operators: number | null; cnt: number }>(
    `select status, max_operators,
            (select count(*)::int from contest_entries where contest_id = $1) as cnt
       from contests_meta where contest_id = $1`,
    [id],
  );
  const m = meta.rows[0];
  if (m && !["open", "pending"].includes(m.status)) {
    return c.json({ error: "the join window for this contest has closed" }, 409);
  }
  if (m && m.max_operators && m.cnt >= m.max_operators) {
    return c.json({ error: "this contest is full" }, 409);
  }

  // One agent per operator per contest. The other agent is for other contests.
  const existing = await query(
    "select 1 from contest_entries where contest_id = $1 and lower(operator) = $2 limit 1",
    [id, operator],
  );
  if (existing.rows.length > 0) {
    return c.json({ error: "you already have an agent in this contest" }, 409);
  }

  // An agent can only be in one open contest at a time.
  const busy = await query(
    `select 1 from contest_entries ce
       join contests_meta cm on cm.contest_id = ce.contest_id
      where ce.agent_id = $1 and ce.contest_id <> $2
        and cm.status in ('open','pending','running','active')
      limit 1`,
    [agentId, id],
  );
  if (busy.rows.length > 0) {
    return c.json({ error: "this agent is already competing in another open contest" }, 409);
  }

  await query(
    `insert into contest_entries (contest_id, agent_id, operator) values ($1,$2,$3)
       on conflict (contest_id, agent_id) do nothing`,
    [id, agentId, operator],
  );
  await query(
    `update contests_meta set agent_count = (select count(*) from contest_entries where contest_id = $1) where contest_id = $1`,
    [id],
  );
  return c.json({ ok: true });
});

app.post("/api/agents", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const agentId = Number(body.agentId);
  const owner = String(body.owner ?? "").toLowerCase();
  const name = String(body.name ?? "").slice(0, 60) || `Agent #${agentId}`;
  if (!agentId || !owner) return c.json({ error: "agentId and owner required" }, 400);
  await query(
    `insert into agents_meta (agent_id, owner, name) values ($1,$2,$3)
       on conflict (agent_id) do update set name = excluded.name`,
    [agentId, owner, name],
  );
  return c.json({ ok: true });
});

// Upload a custom skin for an agent. Stored for fast serving and also put on 0G
// Storage. The image then shows everywhere this agent appears.
const SKIN_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_SKIN_B64 = 1_200_000; // ~900 KB image

app.post("/api/agents/:id/skin", async (c) => {
  const agentId = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const owner = String(body.owner ?? "").toLowerCase();
  const mime = String(body.mime ?? "");
  const dataB64 = String(body.dataB64 ?? "");

  if (!agentId || !owner) return c.json({ error: "agentId and owner required" }, 400);
  if (!SKIN_MIMES.has(mime)) return c.json({ error: "skin must be a png, jpeg, webp, or gif" }, 400);
  if (!dataB64 || dataB64.length > MAX_SKIN_B64) {
    return c.json({ error: "skin image is missing or too large (max ~900 KB)" }, 400);
  }

  // Only the agent's owner can set its skin.
  const ownRows = await query<{ owner: string }>(
    "select owner from agents_meta where agent_id = $1",
    [agentId],
  );
  if (ownRows.rows.length === 0) return c.json({ error: "unknown agent" }, 404);
  if (ownRows.rows[0]!.owner.toLowerCase() !== owner) return c.json({ error: "not your agent" }, 403);

  // Skins live on 0G Storage. Upload the image and keep its root hash; the bytes
  // are served back from 0G, not from the database. If storage is off (local dev
  // without funds), fall back to keeping the base64 in the database.
  let skinRoot: string | null = null;
  if (storageConfigured()) {
    const bytes = new Uint8Array(Buffer.from(dataB64, "base64"));
    // 0G storage nodes can drop a connection; a couple of tries clears it before
    // we fall back to keeping the image in the database.
    for (let attempt = 0; attempt < 3 && !skinRoot; attempt++) {
      try {
        const { rootHash } = await uploadBytes(bytes);
        skinRoot = rootHash;
      } catch (err) {
        console.error(`skin storage attempt ${attempt + 1} for agent ${agentId}:`, (err as Error).message);
      }
    }
  }

  if (skinRoot) {
    await query(
      "update agents_meta set skin_mime = $2, skin_root = $3, skin_b64 = null where agent_id = $1",
      [agentId, mime, skinRoot],
    );
  } else {
    await query(
      "update agents_meta set skin_mime = $2, skin_root = null, skin_b64 = $3 where agent_id = $1",
      [agentId, mime, dataB64],
    );
  }
  return c.json({ ok: true, skinRoot, source: skinRoot ? "0g-storage" : "db" });
});

// Small in-memory cache so a skin is fetched from 0G Storage once, not on every
// request. Keyed by root hash, which changes when a new skin is uploaded.
const skinCache = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mime: string }>();
const SKIN_CACHE_MAX = 64;

// Serve an agent's skin image from 0G Storage, or 404 if it has none (the UI
// then falls back to the default character).
app.get("/api/skins/:id", async (c) => {
  const agentId = Number(c.req.param("id"));
  const { rows } = await query<{ skin_mime: string | null; skin_b64: string | null; skin_root: string | null }>(
    "select skin_mime, skin_b64, skin_root from agents_meta where agent_id = $1",
    [agentId],
  );
  const row = rows[0];
  if (!row || !row.skin_mime) return c.json({ error: "no skin" }, 404);

  // Prefer 0G Storage.
  if (row.skin_root) {
    let entry = skinCache.get(row.skin_root);
    if (!entry) {
      try {
        const bytes = await downloadBytes(row.skin_root);
        entry = { bytes: Uint8Array.from(bytes), mime: row.skin_mime };
        if (skinCache.size >= SKIN_CACHE_MAX) {
          const oldest = skinCache.keys().next().value;
          if (oldest) skinCache.delete(oldest);
        }
        skinCache.set(row.skin_root, entry);
      } catch (err) {
        console.error(`skin ${agentId} read from 0G failed:`, (err as Error).message);
      }
    }
    if (entry) {
      return c.body(entry.bytes, 200, {
        "Content-Type": entry.mime,
        "Cache-Control": "public, max-age=600",
      });
    }
  }

  // Local-dev fallback: base64 in the database.
  if (row.skin_b64) {
    return c.body(Uint8Array.from(Buffer.from(row.skin_b64, "base64")), 200, {
      "Content-Type": row.skin_mime,
      "Cache-Control": "public, max-age=600",
    });
  }
  return c.json({ error: "no skin" }, 404);
});

app.get("/api/agents", async (c) => {
  const owner = String(c.req.query("owner") ?? "").toLowerCase();
  if (!owner) return c.json({ agents: [] });
  // Each agent with its record: matches entered, wins (placed first), and how
  // many answers it has produced on 0G Compute.
  const { rows } = await query(
    `select m.agent_id, m.owner, m.name, m.created_at, m.compute_level,
            (m.skin_b64 is not null) as has_skin, m.skin_root,
            (exists (select 1 from contest_entries ce
               join contests_meta cm on cm.contest_id = ce.contest_id
              where ce.agent_id = m.agent_id
                and cm.status in ('open','pending','running','active'))) as in_contest,
            count(distinct e.contest_id)::int as matches,
            (sum(case when p.rank = 1 then 1 else 0 end))::int as wins,
            (select count(*)::int from solve_runs s
               where s.agent_id = m.agent_id and s.source = '0g-compute') as og_calls
       from agents_meta m
       left join contest_entries e on e.agent_id = m.agent_id
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
      where lower(m.owner) = $1
      group by m.agent_id, m.owner, m.name, m.created_at
      order by m.agent_id asc`,
    [owner],
  );
  return c.json({ agents: rows });
});

// Recent inference across all contests, for the landing proof strip. Each row
// is an agent answer produced on 0G Compute, newest first.
app.get("/api/feed/recent", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "12"), 50);
  const { rows } = await query(
    `select s.id, s.contest_id, s.agent_id, m.name as agent_name, s.verdict,
            s.source, s.provider, s.model, s.chat_id, s.verified, s.latency_ms, s.created_at
       from solve_runs s
       left join agents_meta m on m.agent_id = s.agent_id
      where s.source = '0g-compute'
      order by s.id desc limit $1`,
    [limit],
  );
  return c.json({ feed: rows });
});

// Leaderboard: operators ranked by total winnings. Scope to a mode (arenas =
// all contests for now; duels arrive with the challenge contract).
app.get("/api/leaderboard", async (c) => {
  const { rows } = await query<{ is_house: boolean | null }>(
    `select e.operator,
            count(distinct e.contest_id)::int as matches,
            (sum(case when p.rank = 1 then 1 else 0 end))::int as wins,
            coalesce(sum(p.amount::numeric), 0)::text as winnings,
            (select name from agents_meta am where lower(am.owner) = lower(e.operator)
               order by am.agent_id asc limit 1) as agent_name,
            (select am.agent_id from agents_meta am where lower(am.owner) = lower(e.operator)
               order by am.agent_id asc limit 1)::int as agent_id,
            coalesce((select bool_or(am.is_house) from agents_meta am
               where lower(am.owner) = lower(e.operator)), false) as is_house
       from contest_entries e
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
      group by e.operator
      order by is_house asc, winnings desc, wins desc, matches desc
      limit 100`,
  );
  // Real operators always rank above the autopilot's house agents. Once real
  // players scale, set LEADERBOARD_HIDE_HOUSE=on to drop the house entirely.
  const hideHouse = (process.env.LEADERBOARD_HIDE_HOUSE ?? "off").toLowerCase() === "on";
  const visible = (hideHouse ? rows.filter((r) => !r.is_house) : rows).slice(0, 50);
  return c.json({ leaderboard: visible.map((r, i) => ({ rank: i + 1, ...r })) });
});

// Operator profile: lifetime stats, their agents, and recent match history.
app.get("/api/operators/:address", async (c) => {
  const operator = String(c.req.param("address")).toLowerCase();

  const statsQ = await query(
    `select count(distinct e.contest_id)::int as matches,
            (sum(case when p.rank = 1 then 1 else 0 end))::int as wins,
            coalesce(sum(p.amount::numeric), 0)::text as winnings,
            (select count(*)::int from solve_runs s where lower(s.operator) = $1 and s.source = '0g-compute') as og_calls
       from contest_entries e
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
      where lower(e.operator) = $1`,
    [operator],
  );

  const agentsQ = await query(
    `select m.agent_id, m.name,
            count(distinct e.contest_id)::int as matches,
            (sum(case when p.rank = 1 then 1 else 0 end))::int as wins
       from agents_meta m
       left join contest_entries e on e.agent_id = m.agent_id
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
      where lower(m.owner) = $1
      group by m.agent_id, m.name order by m.agent_id asc`,
    [operator],
  );

  const matchesQ = await query(
    `select c.contest_id, c.kind, c.status, c.prize_pool, c.settled_at,
            p.amount, p.rank, p.claimed
       from contest_entries e
       join contests_meta c on c.contest_id = e.contest_id
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
      where lower(e.operator) = $1
      order by c.contest_id desc limit 20`,
    [operator],
  );

  return c.json({
    operator,
    stats: statsQ.rows[0] ?? { matches: 0, wins: 0, winnings: "0", og_calls: 0 },
    agents: agentsQ.rows,
    matches: matchesQ.rows,
  });
});

app.get("/api/contests/:id/claim", async (c) => {
  const id = Number(c.req.param("id"));
  const operator = String(c.req.query("operator") ?? "").toLowerCase();
  if (!operator) return c.json({ error: "operator required" }, 400);
  const { rows } = await query(
    "select operator, amount, leaf_index, proof, rank, claimed from payouts where contest_id = $1 and lower(operator) = $2",
    [id, operator],
  );
  if (rows.length === 0) return c.json({ eligible: false });
  return c.json({ eligible: true, ...rows[0] });
});

app.post("/api/contests/:id/claimed", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const operator = String(body.operator ?? "").toLowerCase();
  await query("update payouts set claimed = true where contest_id = $1 and lower(operator) = $2", [
    id,
    operator,
  ]);
  return c.json({ ok: true });
});

// ---- admin / demo ----

app.post("/api/admin/contests/open", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const kind = body.kind === "analyst" ? "analyst" : "solver";
  const id = await openContest({
    prizePoolUsdc: Number(body.prizePoolUsdc ?? 100),
    durationSecs: Number(body.durationSecs ?? 120),
    topN: Number(body.topN ?? 3),
    puzzleCount: Number(body.puzzleCount ?? (kind === "analyst" ? 4 : 5)),
    kind,
  });
  return c.json({ ok: true, contestId: id, kind });
});

app.post("/api/admin/contests/:id/run", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  const { rows } = await query<{ kind: string }>(
    "select kind from contests_meta where contest_id = $1",
    [id],
  );
  const kind = rows[0]?.kind ?? "solver";
  // Fire and forget; progress streams over the WebSocket.
  const run = kind === "analyst" ? runAnalystContest(id) : runContest(id);
  run.catch((err) => console.error(`run contest ${id} (${kind}) failed:`, err));
  return c.json({ ok: true, accepted: true, contestId: id, kind });
});

async function standingsFor(contestId: number) {
  const { rows } = await query<{
    agent_id: string;
    operator: string;
    name: string | null;
    correct: string;
    total_latency: string;
  }>(
    `select e.agent_id, e.operator, m.name,
            coalesce(sum(case when s.verdict = 'correct' then 1 else 0 end), 0) as correct,
            coalesce(sum(s.latency_ms), 0) as total_latency
       from contest_entries e
       left join agents_meta m on m.agent_id = e.agent_id
       left join solve_runs s on s.contest_id = e.contest_id and s.agent_id = e.agent_id
      where e.contest_id = $1
      group by e.agent_id, e.operator, m.name
      order by correct desc, total_latency asc, e.agent_id asc`,
    [contestId],
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    agentId: Number(r.agent_id),
    agentName: r.name ?? `Agent #${r.agent_id}`,
    operator: r.operator,
    correct: Number(r.correct),
    totalLatencyMs: Number(r.total_latency),
  }));
}
