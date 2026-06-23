import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "../config/index.js";
import { query } from "../db/pool.js";
import { computeMode, computeConfigured } from "../compute/client.js";
import { deploymentReady, loadDeployment } from "../chain/contracts.js";
import { storageConfigured } from "../storage/zgStorage.js";
import { openContest } from "../coordinator/contestOps.js";
import { runContest } from "../coordinator/runContest.js";
import { runAnalystContest } from "../coordinator/runAnalystContest.js";

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

app.post("/api/contests/:id/enter", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const agentId = Number(body.agentId);
  const operator = String(body.operator ?? "").toLowerCase();
  if (!agentId || !operator) return c.json({ error: "agentId and operator required" }, 400);
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

app.get("/api/agents", async (c) => {
  const owner = String(c.req.query("owner") ?? "").toLowerCase();
  if (!owner) return c.json({ agents: [] });
  // Each agent with its record: matches entered, wins (placed first), and how
  // many answers it has produced on 0G Compute.
  const { rows } = await query(
    `select m.agent_id, m.owner, m.name, m.created_at,
            count(distinct e.contest_id) as matches,
            count(p.*) filter (where p.rank = 1) as wins,
            (select count(*) from solve_runs s
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
  const { rows } = await query(
    `select e.operator,
            count(distinct e.contest_id) as matches,
            count(p.*) filter (where p.rank = 1) as wins,
            coalesce(sum(p.amount::numeric), 0)::text as winnings,
            (select name from agents_meta am where lower(am.owner) = lower(e.operator)
               order by am.agent_id asc limit 1) as agent_name
       from contest_entries e
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
      group by e.operator
      order by winnings desc, wins desc, matches desc
      limit 50`,
  );
  return c.json({ leaderboard: rows.map((r, i) => ({ rank: i + 1, ...r })) });
});

// Operator profile: lifetime stats, their agents, and recent match history.
app.get("/api/operators/:address", async (c) => {
  const operator = String(c.req.param("address")).toLowerCase();

  const statsQ = await query(
    `select count(distinct e.contest_id) as matches,
            count(p.*) filter (where p.rank = 1) as wins,
            coalesce(sum(p.amount::numeric), 0)::text as winnings,
            (select count(*) from solve_runs s where lower(s.operator) = $1 and s.source = '0g-compute') as og_calls
       from contest_entries e
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
      where lower(e.operator) = $1`,
    [operator],
  );

  const agentsQ = await query(
    `select m.agent_id, m.name,
            count(distinct e.contest_id) as matches,
            count(p.*) filter (where p.rank = 1) as wins
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
