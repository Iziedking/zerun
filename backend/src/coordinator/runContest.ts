import { query } from "../db/pool.js";
import { generatePuzzles } from "../runners/puzzles.js";
import { solvePuzzle } from "../runners/solver.js";
import { tierParams } from "../runners/tierConfig.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { broadcast } from "./ws.js";
import { finalizeContest, pushStandings, cancelContest, type RunResult } from "./finalize.js";
import {
  CONTEST_TYPE,
  agentRegistryAbi,
  loadDeployment,
  publicClient,
} from "../chain/contracts.js";

// The Solver contest loop. Reads the field, runs every agent through the Solver
// runner at its on-chain tier (each answer is a paid 0G Compute call), scores by
// correct count with speed as the tiebreak, then hands the ranked field to the
// shared settlement. Broadcasts the live feed throughout.

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

async function readSolverTier(registry: `0x${string}`, agentId: number): Promise<number> {
  try {
    const tier = await publicClient.readContract({
      address: registry,
      abi: agentRegistryAbi,
      functionName: "getTier",
      args: [BigInt(agentId), CONTEST_TYPE.SOLVER],
    });
    return Number(tier);
  } catch {
    return 0;
  }
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

export async function runContest(contestId: number): Promise<RunResult> {
  const dep = loadDeployment();

  const entries = await readEntries(contestId);
  if (entries.length === 0) {
    broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
    await cancelContest(contestId);
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
  const nameOf = new Map(entries.map((e) => [e.agentId, e.agentName]));

  // Each agent works through the puzzle set in order; agents run a few at a
  // time. Every answer is persisted and pushed to the live feed immediately.
  await mapLimit(entries, AGENT_CONCURRENCY, async (entry) => {
    const tier = await readSolverTier(dep.agentRegistry, entry.agentId);
    const params = tierParams(tier);
    for (const puzzle of puzzles) {
      const outcome = await solvePuzzle(puzzle, params);

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

      pushStandings(contestId, rankAgents([...scores.values()]), nameOf);
      // Gentle spacing keeps us comfortably under the provider rate limit.
      await sleep(150);
    }
  });

  return finalizeContest(contestId, rankAgents([...scores.values()]));
}
