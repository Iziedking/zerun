import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "../config/index.js";
import { claimVoteGas, voteGasStatus } from "./voteGas.js";
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
  memoryEscrowAddress,
} from "../chain/contracts.js";
import {
  nextLevelCostWei,
  MAX_COMPUTE_LEVEL,
  computeLevelClamp,
  COMPUTE_COSTS_OG,
} from "../runners/computeLevels.js";
import { storageConfigured, uploadBytes, downloadBytes, downloadJson } from "../storage/zgStorage.js";
import { openContest, onchainEntryCount } from "../coordinator/contestOps.js";
import { runContest } from "../coordinator/runContest.js";
import { runAnalystContest } from "../coordinator/runAnalystContest.js";
import { runPokerContest } from "../coordinator/runPokerContest.js";
import { runWorldCupContest } from "../coordinator/runWorldCupContest.js";
import { runChessContest } from "../coordinator/runChessContest.js";
import { cancelContest, resettleFromStored } from "../coordinator/finalize.js";
import { standingsFor } from "../coordinator/standings.js";
import { pokerLadder, currentPokerSeason } from "../runners/poker/ratings.js";
import { chessLadder, currentChessSeason, chessQualify } from "../runners/chess/ratings.js";
import { submitChessAgent, myChessAgent, uploadsOpen, SubmitError } from "../runners/chess/submissions.js";
import { verifyChessSubmit } from "../auth/chessSubmitSig.js";
import { getLiveGame, getAgentGame } from "../coordinator/chessLadderRunner.js";
import { settlePokerSeason } from "../coordinator/pokerSeason.js";
import { getAgentMemory, memoryEnabled, memoryLift, memoryQueueDepth } from "../runners/agentMemory.js";
import { agentAddress } from "../runners/agentWallet.js";
import {
  accountOf,
  isPaidMemoryKind,
  memoryMarketConfigured,
  pricePerCallWei,
  unsettledWei,
  type MemoryKind,
} from "../runners/memoryMarket.js";
import { xConfigured, verifyWalletSig, beginXAuth, completeXAuth, xIdentityFor } from "../auth/xConnect.js";
import { scheduleHouseFill, coordinatorGasBalance } from "../coordinator/autopilot.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { buildDossier, dossierTierCap, revealDossier } from "../runners/poker/dossier.js";
import {
  freeAllotment,
  purchasedTier,
  recordDossierPurchase,
  freeUsed,
  consumeFree,
  buildRequirements,
  decodePaymentHeader,
  verifyPaymentTx,
  consumePaymentTx,
} from "../runners/poker/x402.js";
import { verifyAgentOwner } from "../auth/agentSig.js";

// Read API plus the admin/demo triggers. The live feed itself goes over the
// WebSocket; these endpoints serve initial loads, lookups, and the proofs
// winners need to claim.

export const app = new Hono();
app.use("/*", cors());

const adminToken = process.env.ADMIN_TOKEN ?? "";
function adminOk(c: { req: { header: (k: string) => string | undefined } }): boolean {
  // Fail closed: with no token set, every admin and money route is denied rather
  // than left open. Production must set ADMIN_TOKEN for the support console to work.
  if (!adminToken) return false;
  return c.req.header("x-admin-token") === adminToken;
}

// Liveness, plus the one background queue that can silently fall behind: agent memory is
// written off the settle path, so its depth is the only way to see it backing up.
app.get("/api/health", (c) =>
  c.json({ ok: true, memory: { enabled: memoryEnabled(), queue: memoryQueueDepth() } }),
);

// Client-side failure sink. Some failures (hosting, entering, training) happen in
// a wallet transaction that goes straight from the browser to the 0G RPC and never
// touches this backend, so they leave no server trace. The frontend posts them here
// so the real error lands in the container logs (docker logs / the platform console)
// where it can be traced, instead of only living in a user's browser console. Best
// effort and size-capped; it only writes to stderr, never to the database.
app.post("/api/client-error", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    context?: unknown;
    message?: unknown;
    detail?: unknown;
    address?: unknown;
  };
  const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
  const context = clip(body.context, 120) || "unknown";
  const message = clip(body.message, 500);
  const detail = clip(body.detail, 4000);
  const address = clip(body.address, 60);
  const ua = clip(c.req.header("user-agent"), 200);
  console.error(
    `[client-error] context=${context} address=${address || "-"} ua=${ua}\n  message=${message}${
      detail ? `\n  detail=${detail}` : ""
    }`,
  );
  return c.body(null, 204);
});

app.get("/api/compute/status", (c) =>
  c.json({ mode: computeMode(), configured: computeConfigured() }),
);

app.get("/api/storage/status", (c) => c.json({ enabled: storageConfigured() }));

// X (Twitter) connect, OAuth 2.0 + PKCE. Soft-gate: a verified badge, nothing blocked.
// start: the wallet signs a message, we return the X authorize URL. callback: exchange
// the code and bind the X identity to the wallet. The public read returns a wallet's
// linked handle for the badge.
app.get("/api/social/x/status", (c) => c.json({ enabled: xConfigured() }));

app.post("/api/social/x/start", async (c) => {
  if (!xConfigured()) return c.json({ error: "X connect is not configured on this server" }, 503);
  const body = await c.req.json().catch(() => ({}));
  const owner = String(body.owner ?? "");
  const ok = await verifyWalletSig(owner, Number(body.issuedAt ?? 0), String(body.signature ?? ""));
  if (!ok) return c.json({ error: "a fresh wallet signature is required" }, 401);
  const { url } = beginXAuth(owner);
  return c.json({ url });
});

app.post("/api/social/x/callback", async (c) => {
  if (!xConfigured()) return c.json({ error: "X connect is not configured on this server" }, 503);
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code ?? "");
  const state = String(body.state ?? "");
  if (!code || !state) return c.json({ error: "code and state are required" }, 400);
  try {
    const res = await completeXAuth(code, state);
    return c.json({ ok: true, wallet: res.wallet, handle: res.handle, name: res.name });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get("/api/social/x/:address", async (c) => {
  const identity = await xIdentityFor(c.req.param("address"));
  return c.json({ identity });
});

// Resolve a verified X handle to the wallet it is bound to, so an operator can send tUSDC to
// "@someone" instead of pasting 42 hex characters. The binding is one-to-one and enforced by
// `unique (x_id)` on social_identity, so a handle can never point at two wallets.
//
// Read-only, and it reveals only what the profile page already shows: a public handle next to
// a public address. Returns 404 when the handle is not connected, which is the honest answer:
// sending to an unverified handle would mean guessing at an address.
app.get("/api/social/resolve/:handle", async (c) => {
  const raw = (c.req.param("handle") ?? "").trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) return c.json({ error: "not a valid X handle" }, 400);
  const { rows } = await query<{ wallet: string; x_handle: string; x_name: string | null; x_avatar: string | null }>(
    "select wallet, x_handle, x_name, x_avatar from social_identity where lower(x_handle) = lower($1) limit 1",
    [raw],
  );
  const hit = rows[0];
  if (!hit) return c.json({ error: `@${raw} has not connected X to a Zerun wallet` }, 404);
  return c.json({ wallet: hit.wallet, handle: hit.x_handle, name: hit.x_name, avatar: hit.x_avatar });
});

// Map of agent id -> the owner's X profile image, for every agent whose operator has
// linked X. The UI uses this as the agent's avatar everywhere (games, standings,
// ladder, leaderboard), overriding an uploaded skin; the skin stays the fallback when
// X is not connected. Small (only linked operators) and cacheable.
app.get("/api/social/avatars", async (c) => {
  const { rows } = await query<{ agent_id: string; x_avatar: string | null }>(
    `select a.agent_id, s.x_avatar
       from agents_meta a
       join social_identity s on lower(s.wallet) = lower(a.owner)
      where s.x_avatar is not null`,
  );
  const avatars: Record<string, string> = {};
  for (const r of rows) if (r.x_avatar) avatars[String(r.agent_id)] = r.x_avatar;
  return c.json({ avatars });
});

// Arena-wide stats for the home page.
app.get("/api/stats", async (c) => {
  const { rows } = await query(
    `select
       (select count(*)::int from contests_meta) as contests,
       (select count(*)::int from contests_meta where status = 'settled') as settled,
       (select count(*)::int from contests_meta where status in ('open','pending','running','active','awaiting_resolution')) as live,
       (select count(*)::int from agents_meta) as agents,
       (select count(*)::int from solve_runs where source = '0g-compute') as og_calls,
       (select coalesce(sum(prize_pool::numeric), 0)::text from contests_meta where status = 'settled') as settled_pool`,
  );
  return c.json(rows[0] ?? {});
});

// Per-model performance, aggregated from every 0G Compute answer. Powers the model
// studies page: how each 0G model actually performs at real, graded work, sourced from
// provable runs rather than self-reported benchmarks. Accuracy is over graded answers
// only (Solver and Analyst, where a call is correct or wrong); poker moves and pending
// forecasts still count as usage. Only true 0G Compute answers are included.
app.get("/api/models/stats", async (c) => {
  const MODEL_FILTER =
    "source = '0g-compute' and model is not null and model <> '' and model not in ('error', 'offline-dev')";

  // Per-model usage and accuracy over every 0G Compute answer.
  const { rows } = await query<{
    model: string;
    answers: number;
    correct: number;
    wrong: number;
    errors: number;
    verified: number;
    contests: number;
    agents: number;
    avg_latency_ms: number;
  }>(
    `select
       model,
       count(*)::int as answers,
       count(*) filter (where verdict = 'correct')::int as correct,
       count(*) filter (where verdict = 'wrong')::int as wrong,
       count(*) filter (where verdict = 'error')::int as errors,
       count(*) filter (where verified = true)::int as verified,
       count(distinct contest_id)::int as contests,
       count(distinct agent_id)::int as agents,
       coalesce(avg(latency_ms) filter (where latency_ms is not null), 0)::int as avg_latency_ms
     from solve_runs
     where ${MODEL_FILTER}
     group by model`,
  );

  // Contest wins per model: the model the rank-1 operator's agent used in each settled
  // contest, plus how many settled contests each model competed in (the win-rate base).
  const { rows: winRows } = await query<{ model: string; wins: number; settled_contests: number }>(
    `with competed as (
       select sr.model, count(distinct sr.contest_id)::int as settled_contests
         from solve_runs sr
         join contests_meta m on m.contest_id = sr.contest_id and m.status = 'settled'
        where ${MODEL_FILTER}
        group by sr.model
     ),
     winner_model as (
       select distinct on (p.contest_id) p.contest_id, sr.model
         from payouts p
         join solve_runs sr on sr.contest_id = p.contest_id and lower(sr.operator) = lower(p.operator)
        where p.rank = 1 and sr.source = '0g-compute'
          and sr.model is not null and sr.model <> '' and sr.model not in ('error', 'offline-dev')
        order by p.contest_id, sr.id
     ),
     wins as (select model, count(*)::int as wins from winner_model group by model)
     select c.model, coalesce(w.wins, 0)::int as wins, c.settled_contests
       from competed c left join wins w on w.model = c.model`,
  );
  const winByModel = new Map(winRows.map((r) => [r.model, r]));

  // Accuracy split by contest flavor (only Solver and Analyst are graded).
  const { rows: kindRows } = await query<{ model: string; kind: string | null; correct: number; wrong: number }>(
    `select sr.model, m.kind,
            count(*) filter (where sr.verdict = 'correct')::int as correct,
            count(*) filter (where sr.verdict = 'wrong')::int as wrong
       from solve_runs sr
       join contests_meta m on m.contest_id = sr.contest_id
      where ${MODEL_FILTER} and sr.verdict in ('correct', 'wrong')
      group by sr.model, m.kind`,
  );
  const kindByModel = new Map<string, { kind: string; correct: number; wrong: number; accuracy: number | null }[]>();
  for (const r of kindRows) {
    const graded = r.correct + r.wrong;
    const list = kindByModel.get(r.model) ?? [];
    list.push({
      kind: r.kind ?? "unknown",
      correct: r.correct,
      wrong: r.wrong,
      accuracy: graded > 0 ? r.correct / graded : null,
    });
    kindByModel.set(r.model, list);
  }

  const models = rows
    .map((r) => {
      const graded = r.correct + r.wrong;
      const win = winByModel.get(r.model);
      const wins = win?.wins ?? 0;
      const settledContests = win?.settled_contests ?? 0;
      return {
        model: r.model,
        answers: r.answers,
        gradedAnswers: graded,
        correct: r.correct,
        wrong: r.wrong,
        errors: r.errors,
        accuracy: graded > 0 ? r.correct / graded : null,
        verified: r.verified,
        verifiedRate: r.answers > 0 ? r.verified / r.answers : 0,
        contests: r.contests,
        agents: r.agents,
        avgLatencyMs: r.avg_latency_ms,
        wins,
        settledContests,
        winRate: settledContests > 0 ? wins / settledContests : null,
        byKind: (kindByModel.get(r.model) ?? []).sort((a, b) => a.kind.localeCompare(b.kind)),
      };
    })
    .sort((a, b) => {
      // Ranked by accuracy where graded, most-graded as the tiebreak. Models with no
      // graded answers fall to the bottom, ordered by usage.
      if (a.accuracy === null && b.accuracy === null) return b.answers - a.answers;
      if (a.accuracy === null) return 1;
      if (b.accuracy === null) return -1;
      if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
      return b.gradedAnswers - a.gradedAnswers;
    });

  return c.json({ models });
});

// tUSDC faucet, capped to 100 tUSDC per operator per rolling 7 days so it cannot
// be farmed. The coordinator mints to the operator and pays the gas.
const USDC_WEEKLY_CAP = 100_000000n; // 100 tUSDC (6 decimals)

// Serialize faucet claims per operator within this process, so two concurrent
// requests cannot both pass the cap check before either records its claim and
// each mint the full remaining amount.
const faucetInFlight = new Set<string>();

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

  if (faucetInFlight.has(owner)) {
    return c.json({ error: "a claim is already in progress for this wallet" }, 429);
  }
  faucetInFlight.add(owner);
  try {
    const claimedWei = await usdcClaimedThisWeek(owner);
    const remaining = USDC_WEEKLY_CAP - claimedWei;
    if (remaining <= 0n) {
      return c.json(
        { error: "you have claimed your 100 tUSDC for this week. It resets in a few days." },
        429,
      );
    }

    // Reserve the allowance before minting so a retry during a slow mint cannot
    // double-spend it, but roll the reservation back if the mint itself fails, so a
    // failed mint never locks the user out of the faucet for the week.
    const claim = await query<{ id: string }>(
      "insert into usdc_claims (operator, amount_wei) values ($1, $2) returning id",
      [owner, remaining.toString()],
    );
    const claimId = claim.rows[0]?.id;
    const dep = loadDeployment();
    try {
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
      return c.json({ ok: true, minted: remaining.toString(), txHash: hash });
    } catch (err) {
      if (claimId != null) {
        await query("delete from usdc_claims where id = $1", [claimId]).catch(() => {});
      }
      console.error(`faucet mint for ${owner} failed:`, (err as Error).message);
      return c.json({ error: "the mint did not go through, please try again" }, 502);
    }
  } finally {
    faucetInFlight.delete(owner);
  }
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

// Settle the poker season pot on-chain: pay the top real-operator agents ranked by
// their TrueSkill rating, funded by the given pool, through the normal merkle payout.
// Admin-triggered (season end is a call the operator makes); winners then claim their
// prizes on their profiles. To start a fresh season afterwards, bump POKER_SEASON.
app.post("/api/admin/poker/settle-season", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const poolUsdc = Number(body.poolUsdc ?? 0);
  const topN = Math.max(1, Math.min(5, Number(body.topN ?? 3)));
  if (!(poolUsdc > 0)) return c.json({ error: "poolUsdc (a positive number) is required" }, 400);
  const result = await settlePokerSeason(poolUsdc, topN);
  return c.json(result, result.ok ? 200 : 409);
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

// Repair a contest whose stored proofs no longer match the immutable on-chain
// root (a pre-idempotency re-settle recomputed and overwrote them). The on-chain
// root cannot change, so those proofs are unclaimable. For each winner: if they
// already claimed on chain, just sync the DB flag; otherwise credit the owed
// amount directly and mark it claimed so the broken claim button settles. Safe by
// default (dry run: reports the plan, mints nothing); pass ?credit=true to act.
app.post("/api/admin/contest/:id/repair-claims", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "contest id required" }, 400);
  const doCredit = c.req.query("credit") === "true";

  const engine = loadDeployment().contestEngine;
  const contest = await publicClient.readContract({
    address: engine,
    abi: contestEngineAbi,
    functionName: "getContest",
    args: [BigInt(id)],
  });
  const chainRoot = String(contest.finalRoot).toLowerCase();
  const { rows: meta } = await query<{ final_root: string | null }>(
    "select final_root from contests_meta where contest_id = $1",
    [id],
  );
  const dbRoot = (meta[0]?.final_root ?? "").toLowerCase();
  if (!dbRoot) return c.json({ error: "no stored root for this contest" }, 400);
  if (dbRoot === chainRoot) {
    return c.json({ ok: true, note: "roots match; proofs are valid, no repair needed", chainRoot });
  }

  const { rows: payouts } = await query<{ operator: string; amount: string; claimed: boolean }>(
    "select operator, amount, claimed from payouts where contest_id = $1 order by rank asc",
    [id],
  );
  const results: { operator: string; amountWei: string; action: string; tx?: string }[] = [];
  for (const p of payouts) {
    const op = p.operator.toLowerCase() as `0x${string}`;
    const onchainClaimed = await publicClient.readContract({
      address: engine,
      abi: contestEngineAbi,
      functionName: "prizeClaimed",
      args: [BigInt(id), op],
    });
    if (onchainClaimed) {
      if (doCredit) await query("update payouts set claimed = true where contest_id = $1 and lower(operator) = $2", [id, op]);
      results.push({ operator: op, amountWei: p.amount, action: "already-claimed-on-chain (sync only)" });
      continue;
    }
    if (p.claimed) {
      results.push({ operator: op, amountWei: p.amount, action: "db-already-claimed (skip)" });
      continue;
    }
    if (!doCredit) {
      results.push({ operator: op, amountWei: p.amount, action: "WOULD credit (dry run)" });
      continue;
    }
    const hash = await coordinatorWallet().writeContract({
      address: loadDeployment().testUSDC,
      abi: testUsdcAbi,
      functionName: "mint",
      args: [op, BigInt(p.amount)],
      account: coordinatorAccount(),
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await waitReceipt(hash);
    await query("update payouts set claimed = true where contest_id = $1 and lower(operator) = $2", [id, op]);
    results.push({ operator: op, amountWei: p.amount, action: "credited", tx: hash });
  }
  return c.json({ ok: true, contestId: id, dryRun: !doCredit, chainRoot, dbRoot, results });
});

app.post("/api/admin/contest/:id/cancel", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "contest id required" }, 400);
  await cancelContest(id);
  return c.json({ ok: true });
});

// Zero Cup vote-gas faucet. Real mainnet 0G, one claim per wallet, hard campaign budget.
// See src/api/voteGas.ts for every guard and why each exists.
app.get("/api/vote/gas", async (c) => {
  const address = String(c.req.query("address") ?? "").toLowerCase();
  return c.json(await voteGasStatus(address));
});

app.post("/api/vote/gas", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const address = String(body.address ?? "").toLowerCase();
  const res = await claimVoteGas(address);
  if (!res.ok) return c.json({ error: res.error }, res.status as 400);
  return c.json({ txHash: res.txHash, amountOg: res.amountOg });
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
      // Optional: null until the memory market is deployed. The funding UI needs it to
      // build a depositAndAllow transaction from the operator's own wallet.
      memoryEscrow: memoryEscrowAddress(),
    },
  });
});

app.get("/api/contests", async (c) => {
  const { rows } = await query(
    `select contest_id, status, kind, puzzle_count, agent_count, max_operators, metric, prize_pool, entry_fee, fee_pool, final_root, created_at, settled_at
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
    `select id, agent_id, operator, puzzle_idx, prompt, answer, verdict, source, provider, model, chat_id, verified, latency_ms, samples, sources, created_at
       from solve_runs where contest_id = $1 and id > $2 order by id asc limit 500`,
    [id, since],
  );
  return c.json({ feed: rows });
});

app.get("/api/contests/:id/standings", async (c) => {
  const id = Number(c.req.param("id"));
  return c.json({ standings: await standingsFor(id) });
});

// The poker season ladder: agents ranked by conservative TrueSkill (mu - 3*sigma),
// updated after every duel and table. Proves the tier gradient over a season.
app.get("/api/poker/ladder", async (c) => {
  const season = c.req.query("season") || currentPokerSeason();
  const ladder = await pokerLadder(season);
  return c.json({ season, ladder });
});

// The community chess competition ladder: uploaded agents (and house benchmarks) ranked by
// conservative TrueSkill. `?uploads=1` returns the prize board — real player submissions only,
// the top of which win the event.
app.get("/api/chess/ladder", async (c) => {
  const season = c.req.query("season") || currentChessSeason();
  const onlyUploads = c.req.query("uploads") === "1";
  const ladder = await chessLadder(season, 200, onlyUploads);
  return c.json({ season, ladder, qualify: chessQualify() });
});

// Enter the competition: one Python file, signed by the wallet it will be credited to. The file is
// smoke-tested inside the real sandbox (three positions, a legal move required in each) before it
// becomes an agent, so a broken entry is rejected at the door instead of forfeiting live games.
app.post("/api/chess/agents", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    owner?: string;
    issuedAt?: number;
    signature?: string;
    name?: string;
    code?: string;
  };
  const name = String(body.name ?? "").trim();
  const code = String(body.code ?? "");
  if (!name || !code) return c.json({ error: "a name and a code file are required" }, 400);

  const auth = await verifyChessSubmit(body, name, code);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  try {
    const result = await submitChessAgent(auth.owner, name, code);
    return c.json(result);
  } catch (err) {
    if (err instanceof SubmitError) return c.json({ error: err.message }, err.status);
    console.error("chess submit failed:", (err as Error).message);
    return c.json({ error: "the submission could not be processed, try again" }, 500);
  }
});

// The game currently being played on the ladder, move by move, or null between games. Lets the
// board show a live game to anyone who opens the page.
app.get("/api/chess/live", (c) => {
  return c.json({ game: getLiveGame() });
});

// One agent's watchable game: the live one if it is playing, else its most recent finished game.
// Powers "click an agent, watch its game."
app.get("/api/chess/game/:agentId", (c) => {
  const id = Number(c.req.param("agentId"));
  if (!id) return c.json({ error: "a numeric agent id is required" }, 400);
  return c.json({ game: getAgentGame(id) });
});

// A wallet's own entry: what it submitted, and how it is doing on the board. `open` tells the UI
// whether submissions are being accepted at all.
app.get("/api/chess/agents/mine", async (c) => {
  const owner = String(c.req.query("owner") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) return c.json({ error: "a wallet address is required" }, 400);
  return c.json({ open: uploadsOpen(), agent: await myChessAgent(owner) });
});

// An agent's own memory: the 0G-authored self-summary it carries across contests, its
// tendencies, and the 0G Storage anchor. `enabled` reflects the AGENT_MEMORY flag so the
// UI can show whether memory is influencing play. Returns memory: null when the agent has
// none yet (or the flag is off and nothing was ever written).
// An agent's memory. `kind` selects which one: "general" (solver + analyst), "poker", or
// "chess". They are separate records, because what an agent learned about arithmetic is
// not what it learned about the Sicilian.
app.get("/api/agents/:id/memory", async (c) => {
  const agentId = Number(c.req.param("id"));
  if (!agentId) return c.json({ error: "a numeric agent id is required" }, 400);
  const raw = c.req.query("kind") ?? "general";
  const kind: MemoryKind = raw === "poker" || raw === "chess" ? raw : "general";
  const memory = await getAgentMemory(agentId, kind);
  return c.json({ enabled: memoryEnabled(), kind, paid: isPaidMemoryKind(kind), memory });
});

// The agent's wallet and its memory balance.
//
// The address is derived from a public extended key at the agent's own id. The backend
// cannot sign for it; it exists so an agent has a stable identity you can look up. Value
// lives in MemoryEscrow, where only the agent's owner can withdraw, and the coordinator
// can spend only up to the allowance that owner granted, only to an immutable treasury.
app.get("/api/agents/:id/wallet", async (c) => {
  const agentId = Number(c.req.param("id"));
  if (!agentId) return c.json({ error: "a numeric agent id is required" }, 400);

  const [account, owed] = await Promise.all([accountOf(agentId), unsettledWei(agentId).catch(() => 0n)]);
  const price = pricePerCallWei();
  const spendable = account ? (account.balanceWei < account.allowanceWei ? account.balanceWei : account.allowanceWei) : 0n;

  return c.json({
    agentId,
    address: agentAddress(agentId),
    escrow: memoryEscrowAddress(),
    market: memoryMarketConfigured(),
    pricePerCallWei: price.toString(),
    // How many more memory-assisted 0G calls this agent can afford right now. This is the
    // number that decides whether it plays poker and chess with its memory or without.
    callsRemaining: price > 0n ? Number(spendable / price) : 0,
    balanceWei: (account?.balanceWei ?? 0n).toString(),
    allowanceWei: (account?.allowanceWei ?? 0n).toString(),
    spentWei: (account?.spentWei ?? 0n).toString(),
    unsettledWei: owed.toString(),
  });
});

// The measured lift from agent memory: accuracy of graded answers produced with memory
// injected vs without, so "agents improve with memory" is provable, not just claimed.
app.get("/api/memory/lift", async (c) => {
  return c.json({ enabled: memoryEnabled(), ...(await memoryLift()) });
});

// An opponent dossier, gated by the x402 flow. Free within the requesting agent's
// tier allotment; beyond that this returns HTTP 402 with payment requirements, and
// serves the dossier once a testUSDC payment on 0G is verified. The `for` agent is
// the one buying the scouting report on `opponentId`.
app.get("/api/dossiers/:opponentId", async (c) => {
  const opponentId = Number(c.req.param("opponentId"));
  const forId = Number(c.req.query("for"));
  if (!opponentId || !forId) return c.json({ error: "opponentId and ?for= agent id are required" }, 400);

  const dossier = await buildDossier(opponentId);
  if (!dossier) return c.json({ error: "this agent has no duel history to scout yet" }, 404);

  // The free-allotment path spends the requesting agent's own reads, so it must be
  // authenticated as that agent's owner (via signed headers). Otherwise anyone could
  // pass ?for=<victim> to burn a victim's free reads and read the dossier for free.
  // Unauthenticated callers can still read through the paid x402 path below.
  const forOwner = c.req.header("x-zerun-owner");
  const forIssued = Number(c.req.header("x-zerun-issued") ?? 0);
  const forSig = c.req.header("x-zerun-signature") as `0x${string}` | undefined;
  const authed =
    Boolean(forOwner && forIssued && forSig) &&
    (await verifyAgentOwner("scout", forId, { owner: forOwner, issuedAt: forIssued, signature: forSig })).ok;

  // A dossier is sold in tiers and is never the full picture. How many tiers this agent may
  // ever hold on one opponent is capped by its Compute level: 1 below level 4, 2 at level
  // 4, 3 at level 5. Structured stats are withheld below tier 2 — a coarse read informs
  // reasoning, it does not let you model anyone mechanically.
  const level = await getAgentCompute(forId);
  const cap = dossierTierCap(level);
  const owned = await purchasedTier(forId, opponentId);
  const reveal = (tier: number) => ({
    dossier: revealDossier(dossier.stats, tier),
    tier,
    cap,
    ...(tier >= 2 ? { stats: dossier.stats } : {}),
  });

  if (owned >= cap) {
    // Already at the depth its 0G investment allows. More Compute is the only way deeper.
    return c.json({ ...reveal(owned), paid: false, atCap: true });
  }

  const allot = freeAllotment(level);
  const used = await freeUsed(forId);
  if (authed && used < allot) {
    await consumeFree(forId);
    await recordDossierPurchase(forId, opponentId, owned + 1, null, 0n, null);
    return c.json({ ...reveal(owned + 1), paid: false, freeRemaining: allot - used - 1 });
  }

  // Free allotment used up: require an x402 payment for the next tier.
  const resource = new URL(c.req.url).pathname;
  const description = `Opponent dossier on agent ${opponentId}, tier ${owned + 1} of ${cap}`;
  const header = c.req.header("x-payment");
  if (!header) return c.json(buildRequirements(resource, description), 402);
  const txHash = decodePaymentHeader(header);
  if (!txHash || !(await verifyPaymentTx(txHash))) {
    return c.json({ error: "payment required or not verified", ...buildRequirements(resource, description) }, 402);
  }
  // One payment, one read: claim the tx as spent so a captured X-PAYMENT header
  // (or a scraped transfer to payTo) cannot be replayed for unlimited dossiers.
  if (!(await consumePaymentTx(txHash, forId, opponentId))) {
    return c.json({ error: "this payment has already been used", ...buildRequirements(resource, description) }, 402);
  }
  await recordDossierPurchase(forId, opponentId, owned + 1, null, 0n, txHash);
  return c.json({ ...reveal(owned + 1), paid: true, txHash });
});

// The stored hand-by-hand replay of a poker duel, read back from 0G Storage by its
// root hash. Proves the duel is reconstructable and verifiable from decentralized
// storage, and powers the replay view.
app.get("/api/contests/:id/replay", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "contest id required" }, 400);
  const { rows } = await query<{ poker_root: string | null }>(
    "select poker_root from contests_meta where contest_id = $1",
    [id],
  );
  const root = rows[0]?.poker_root;
  if (!root) return c.json({ error: "no replay stored for this contest" }, 404);
  try {
    const replay = await downloadJson(root);
    return c.json({ root, replay });
  } catch (err) {
    console.error(`replay ${id} read failed:`, (err as Error).message);
    return c.json({ error: "replay could not be read from 0G Storage", root }, 502);
  }
});

// Keep a contest's puzzle or market count in a sane range, so a host cannot make
// every agent run thousands of paid 0G calls. Falls back to the kind's default for
// a missing or non-numeric value.
function clampPuzzleCount(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), 12);
}

// Register a contest an operator hosted on chain (they ran mint, approve, and
// listContest from their own wallet). We confirm it on chain and mirror it so it
// shows in the arena; the due-sweeper settles it when the window closes.
// Coordinator gas at a glance for the admin panel, so a low balance is caught before
// it stalls agents, settlement, or cancels (the failure the judges hit).
app.get("/api/admin/gas", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const g = await coordinatorGasBalance();
    return c.json({ og: g.og, min: g.min, low: g.low, wei: g.wei.toString() });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

app.post("/api/contests/host", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = Number(body.contestId);
  const kind =
    body.kind === "analyst"
      ? "analyst"
      : body.kind === "poker"
        ? "poker"
        : body.kind === "worldcup"
          ? "worldcup"
          : body.kind === "chess"
            ? "chess"
            : "solver";
  const puzzleCount = clampPuzzleCount(body.puzzleCount, kind === "analyst" ? 4 : 5);
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
    `insert into contests_meta (contest_id, status, puzzle_count, metric, prize_pool, kind, ends_at, max_operators, entry_fee, fee_pool)
       values ($1, 'open', $2, $3, $4, $5, to_timestamp($6), $7, $8, $9)
       on conflict (contest_id) do update set
         puzzle_count = excluded.puzzle_count, kind = excluded.kind,
         prize_pool = excluded.prize_pool, ends_at = excluded.ends_at,
         max_operators = excluded.max_operators, entry_fee = excluded.entry_fee`,
    [id, puzzleCount, kind === "analyst" ? "PREDICTION" : kind === "poker" ? "POKER" : kind === "worldcup" ? "WORLDCUP" : kind === "chess" ? "CHESS" : "PUZZLE", con.prizePool.toString(), kind, Number(con.endTime), maxOperators, con.entryFee.toString(), con.feePool.toString()],
  );

  // The house fills any empty seats near the end of the join window, so a real
  // challenger has the whole window to enter first. It targets the seat cap for a
  // capped contest (a duel fills to two), or a small field for an open one.
  const secondsUntilClose = Number(con.endTime) - Math.floor(Date.now() / 1000);
  scheduleHouseFill(id, maxOperators ?? 4, secondsUntilClose);
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

  // The chain is the source of truth for the field. Only mirror an entry the
  // operator actually registered on chain (registerEntry checks agent ownership),
  // so a forged enter request can never reach scoring or a payout. The frontend
  // sends registerEntry and waits for the receipt before calling this.
  const dep = loadDeployment();
  const entered = await publicClient
    .readContract({
      address: dep.contestEngine,
      abi: contestEngineAbi,
      functionName: "operatorEntered",
      args: [BigInt(id), operator as `0x${string}`],
    })
    .catch(() => false);
  if (!entered) {
    return c.json({ error: "register your entry on chain before joining" }, 409);
  }

  await query(
    `insert into contest_entries (contest_id, agent_id, operator) values ($1,$2,$3)
       on conflict (contest_id, agent_id) do nothing`,
    [id, agentId, operator],
  );
  // Refresh the field count and the mirrored challenge pot together. The engine holds
  // feePool == entryCount * entryFee (fee pulled in the same tx as the entry, one
  // entry per operator), so the pot derives from the entry count with no chain read;
  // a contest (entry_fee '0') stays at fee_pool '0'.
  await query(
    `update contests_meta set
        agent_count = (select count(*) from contest_entries where contest_id = $1),
        fee_pool = (entry_fee::numeric * (select count(*) from contest_entries where contest_id = $1))::text
      where contest_id = $1`,
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
  // Owner-signed: the name/owner mirror is public data, so require a wallet signature
  // proving the caller is the agent's on-chain owner. Without this anyone could rename
  // any agent by naming its public owner address.
  const auth = await verifyAgentOwner("name agent", agentId, {
    owner,
    issuedAt: Number(body.issuedAt),
    signature: body.signature,
  });
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  await query(
    `insert into agents_meta (agent_id, owner, name) values ($1,$2,$3)
       on conflict (agent_id) do update set name = excluded.name`,
    [agentId, auth.owner, name],
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

  // Only the agent's on-chain owner can set its skin. A wallet signature proves it;
  // the DB owner check alone is spoofable because owner addresses are public.
  const auth = await verifyAgentOwner("set skin", agentId, {
    owner,
    issuedAt: Number(body.issuedAt),
    signature: body.signature,
  });
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  // Skins go on 0G Storage as the decentralized anchor, but we ALWAYS keep the base64
  // bytes in the database too, so serving is a fast local read that never depends on a
  // live 0G download. (Nulling the local copy is what made the skin endpoint stall into a
  // gateway 503 whenever the 0G indexer was slow and the in-memory cache was cold.)
  let skinRoot: string | null = null;
  if (storageConfigured()) {
    const bytes = new Uint8Array(Buffer.from(dataB64, "base64"));
    // 0G storage nodes can drop a connection; a couple of tries clears it. The local
    // base64 copy below is kept regardless, so a failed upload just means no anchor yet.
    for (let attempt = 0; attempt < 3 && !skinRoot; attempt++) {
      try {
        const { rootHash } = await uploadBytes(bytes);
        skinRoot = rootHash;
      } catch (err) {
        console.error(`skin storage attempt ${attempt + 1} for agent ${agentId}:`, (err as Error).message);
      }
    }
  }

  await query(
    "update agents_meta set skin_mime = $2, skin_root = $3, skin_b64 = $4 where agent_id = $1",
    [agentId, mime, skinRoot, dataB64],
  );
  return c.json({ ok: true, skinRoot, source: skinRoot ? "0g-storage+db" : "db" });
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

  // Fast path: the locally-stored bytes. Always available and never dependent on a live
  // 0G download, so this can never stall into a gateway 503. This is the primary path for
  // every skin uploaded since we keep a local copy alongside the 0G anchor.
  if (row.skin_b64) {
    return c.body(Uint8Array.from(Buffer.from(row.skin_b64, "base64")), 200, {
      "Content-Type": row.skin_mime,
      "Cache-Control": "public, max-age=600",
    });
  }

  // Legacy path: skins uploaded before we kept a local copy live only on 0G Storage.
  // Serve from the in-memory cache, else fetch from 0G (now time-bounded, so a stalled
  // indexer returns a fast 404 the UI falls back on rather than hanging into a 503). On a
  // successful fetch, backfill skin_b64 so every later serve is fast and 0G-independent.
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
        // Self-heal: persist the bytes locally so this skin never needs 0G again.
        const b64 = Buffer.from(entry.bytes).toString("base64");
        void query("update agents_meta set skin_b64 = $2 where agent_id = $1 and skin_b64 is null", [agentId, b64]).catch(
          (err) => console.error(`skin ${agentId} backfill failed:`, (err as Error).message),
        );
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
      order by coalesce(sum(p.amount::numeric), 0) desc, wins desc, matches desc
      limit 100`,
  );
  // The board is real players only: the autopilot's house agents are contest
  // filler, never ranked, so they are dropped here regardless of their winnings.
  // Order by the numeric winnings, not the text column (else "63" beats "228").
  const visible = rows.filter((r) => !r.is_house).slice(0, 50);
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

  // Cancelled challenges this operator entered: candidates for an entry-fee refund. The
  // profile surfaces them so nobody has to hunt for a cancelled contest to reclaim; the
  // UI confirms on chain whether each is still owed (the refund is pull-based).
  const refundsQ = await query<{ contest_id: string }>(
    `select c.contest_id
       from contest_entries e
       join contests_meta c on c.contest_id = e.contest_id
      where lower(e.operator) = $1
        and c.status = 'cancelled'
        and coalesce(c.entry_fee, '0') <> '0'
      order by c.contest_id desc
      limit 50`,
    [operator],
  );

  return c.json({
    operator,
    stats: statsQ.rows[0] ?? { matches: 0, wins: 0, winnings: "0", og_calls: 0 },
    agents: agentsQ.rows,
    matches: matchesQ.rows,
    refunds: refundsQ.rows.map((r) => Number(r.contest_id)),
  });
});

app.get("/api/contests/:id/claim", async (c) => {
  const id = Number(c.req.param("id"));
  const operator = String(c.req.query("operator") ?? "").toLowerCase();
  if (!operator) return c.json({ error: "operator required" }, 400);
  const { rows } = await query<{ claimed: boolean }>(
    "select operator, amount, leaf_index, proof, rank, claimed from payouts where contest_id = $1 and lower(operator) = $2",
    [id, operator],
  );
  if (rows.length === 0) return c.json({ eligible: false });
  const row = rows[0]!;

  // The chain is the source of truth for "claimed", not the DB flag. The flag is
  // set by a post-claim POST that can be missed if the receipt wait times out, so
  // a prize claimed on chain can still read unclaimed in the DB, which makes the UI
  // show a claim button that then reverts with AlreadyClaimed. Reconcile here: read
  // prizeClaimed on chain and, if claimed, self-heal the DB so the UI shows Claimed.
  if (!row.claimed) {
    try {
      const onchain = await publicClient.readContract({
        address: loadDeployment().contestEngine,
        abi: contestEngineAbi,
        functionName: "prizeClaimed",
        args: [BigInt(id), operator as `0x${string}`],
      });
      if (onchain) {
        row.claimed = true;
        await query("update payouts set claimed = true where contest_id = $1 and lower(operator) = $2", [id, operator]);
      }
    } catch {
      /* RPC blip: fall back to the DB flag */
    }
  }
  return c.json({ eligible: true, ...row });
});

app.post("/api/contests/:id/claimed", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const operator = String(body.operator ?? "").toLowerCase();
  if (!id || !operator) return c.json({ error: "operator required" }, 400);
  // Anyone can post here, so confirm the prize is actually claimed on chain before
  // flipping the flag. Otherwise this could force a real winner's claim button to
  // disappear. The chain is the source of truth for claimed.
  const onchain = await publicClient
    .readContract({
      address: loadDeployment().contestEngine,
      abi: contestEngineAbi,
      functionName: "prizeClaimed",
      args: [BigInt(id), operator as `0x${string}`],
    })
    .catch(() => false);
  if (!onchain) return c.json({ error: "not claimed on chain" }, 409);
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
  const kind =
    body.kind === "analyst"
      ? "analyst"
      : body.kind === "poker"
        ? "poker"
        : body.kind === "worldcup"
          ? "worldcup"
          : body.kind === "chess"
            ? "chess"
            : "solver";
  const maxOperators = Number(body.maxOperators) > 0 ? Number(body.maxOperators) : undefined;
  const id = await openContest({
    prizePoolUsdc: Number(body.prizePoolUsdc ?? 100),
    durationSecs: Number(body.durationSecs ?? 120),
    topN: Number(body.topN ?? (kind === "poker" || kind === "chess" ? 1 : 3)),
    puzzleCount: clampPuzzleCount(body.puzzleCount, kind === "analyst" ? 4 : 5),
    kind,
    maxOperators,
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
  const run =
    kind === "analyst"
      ? runAnalystContest(id)
      : kind === "poker"
        ? runPokerContest(id)
        : kind === "worldcup"
          ? runWorldCupContest(id)
          : kind === "chess"
            ? runChessContest(id)
            : runContest(id);
  run.catch((err) => console.error(`run contest ${id} (${kind}) failed:`, err));
  return c.json({ ok: true, accepted: true, contestId: id, kind });
});

