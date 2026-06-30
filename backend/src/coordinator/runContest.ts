import { query } from "../db/pool.js";
import { generatePuzzles } from "../runners/puzzles.js";
import { fetchLiveInsight } from "../runners/onchain.js";
import { solvePuzzle } from "../runners/solver.js";
import { getAgentCompute } from "../runners/traitStore.js";
import { computePlan } from "../runners/computeLevels.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { broadcast } from "./ws.js";
import { finalizeContest, pushStandings, cancelContest, type RunResult } from "./finalize.js";
import { onchainEntryCount, syncEntriesFromChain, keepOnchainEntrants } from "./contestOps.js";
import {
  CONTEST_TYPE,
  agentRegistryAbi,
  contestEngineAbi,
  coordinatorAddress,
  loadDeployment,
  publicClient,
} from "../chain/contracts.js";

// The Solver contest loop. Reads the field, runs every agent through the Solver
// runner at its on-chain tier (each answer is a paid 0G Compute call), scores by
// correct count with speed as the tiebreak, then hands the ranked field to the
// shared settlement. Broadcasts the live feed throughout.

const DEFAULT_PUZZLE_COUNT = 6;
// Stay under the 0G Compute rate limits (~30 req/min, ~5 concurrent).
const AGENT_CONCURRENCY = 3;

interface Entry {
  agentId: number;
  operator: string;
  agentName: string;
  isHouse: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readEntries(contestId: number): Promise<Entry[]> {
  const { rows } = await query<{ agent_id: string; operator: string; name: string | null; is_house: boolean | null }>(
    `select e.agent_id, e.operator, m.name, m.is_house
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
    isHouse: Boolean(r.is_house),
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

type Puzzle = ReturnType<typeof generatePuzzles>[number];
type Outcome = Awaited<ReturnType<typeof solvePuzzle>>;

// Persist one answer, score it, and push it to the live feed. An errored answer
// contributes nothing (0 correct, 0 latency), so re-running it later and calling
// this again adds only the real result, never a double count.
async function recordOutcome(
  contestId: number,
  entry: Entry,
  puzzle: Puzzle,
  outcome: Outcome,
  scores: Map<number, AgentScore>,
  nameOf: Map<number, string>,
): Promise<void> {
  // House agents have no score entry: they still answer (persisted and broadcast
  // below for feed activity) but contribute nothing to standings or payouts.
  const score = scores.get(entry.agentId);
  if (score) {
    if (outcome.verdict === "correct") score.correct += 1;
    score.totalLatencyMs += outcome.latencyMs;
    score.passes = (score.passes ?? 0) + (outcome.samples ?? 0);
  }

  await query(
    `insert into solve_runs
       (contest_id, agent_id, operator, puzzle_idx, prompt, expected, answer, verdict, source, provider, model, chat_id, verified, latency_ms, samples, agreement)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (contest_id, agent_id, puzzle_idx) do update set
       answer = excluded.answer, verdict = excluded.verdict, source = excluded.source,
       provider = excluded.provider, model = excluded.model, chat_id = excluded.chat_id,
       verified = excluded.verified, latency_ms = excluded.latency_ms,
       samples = excluded.samples, agreement = excluded.agreement`,
    [
      contestId, entry.agentId, entry.operator, puzzle.idx, puzzle.prompt, puzzle.expected,
      outcome.answer, outcome.verdict, outcome.source, outcome.provider, outcome.model,
      outcome.chatID, outcome.verified, outcome.latencyMs, outcome.samples, outcome.agreement,
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
      samples: outcome.samples,
      agreement: outcome.agreement,
      liveInsight: outcome.liveInsight,
    },
  });

  if (score) pushStandings(contestId, rankAgents([...scores.values()]), nameOf);
}

export async function runContest(contestId: number): Promise<RunResult> {
  const dep = loadDeployment();

  let entries = await readEntries(contestId);
  if (entries.length === 0) {
    // The DB mirror can lag the on-chain registerEntry. The chain is the source
    // of truth, so never cancel a contest that actually has a field.
    const onchain = await onchainEntryCount(contestId).catch(() => 0);
    if (onchain > 0) {
      await syncEntriesFromChain(contestId);
      entries = await readEntries(contestId);
    }
    if (entries.length === 0) {
      if (onchain > 0) {
        // Field exists on chain but we could not read it yet; leave it open and
        // let the next sweep retry instead of cancelling a real contest.
        console.warn(`contest ${contestId}: ${onchain} on-chain entries not yet mirrored, retrying next sweep`);
        return { contestId, root: null, posted: false, settled: false, payouts: [] };
      }
      broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
      await cancelContest(contestId);
      return { contestId, root: null, posted: false, settled: false, payouts: [] };
    }
  }

  // Only operators that registered on chain may be scored or paid. Drop any entry
  // with no matching on-chain registerEntry, so the payout root can hold only real
  // entrants. If that leaves no field, cancel and refund the sponsor.
  entries = await keepOnchainEntrants(contestId, entries);
  if (entries.length === 0) {
    broadcast({ type: "status", contestId, payload: { status: "no-entries" } });
    await cancelContest(contestId);
    return { contestId, root: null, posted: false, settled: false, payouts: [] };
  }

  const puzzles = generatePuzzles(contestId, await puzzleCountFor(contestId));

  // Inject one or two live-insight puzzles (current on-chain data, via The Graph
  // or the 0G chain). Only Compute level 4-5 agents see the data, so these reward
  // the live-insight perk. Fetched once and shared, placed in the hard band.
  const liveCount = puzzles.length >= 6 ? 2 : 1;
  for (let k = 0; k < liveCount; k++) {
    const idx = puzzles.length - 1 - k;
    if (idx < 0) break;
    const li = await fetchLiveInsight(contestId + k).catch(() => null);
    if (!li) break;
    puzzles[idx] = { idx, prompt: li.prompt, expected: li.expected, context: li.context };
  }
  // Join window has closed; the contest is now running on 0G.
  await query("update contests_meta set status = 'running' where contest_id = $1", [contestId]);
  broadcast({
    type: "status",
    contestId,
    payload: { status: "running", detail: `${entries.length} agents, ${puzzles.length} puzzles` },
  });

  // Each agent's compute level (its 0G investment), fixed once. It builds the 0G
  // inference plan (more level = more passes and tokens) and breaks scoring ties.
  const levelOf = new Map<number, number>();
  for (const e of entries) levelOf.set(e.agentId, await getAgentCompute(e.agentId));
  const planOf = new Map<number, ReturnType<typeof computePlan>>();
  for (const e of entries) planOf.set(e.agentId, computePlan(levelOf.get(e.agentId)!));

  // House agents answer for the feed (activity) but are never scored, ranked, or
  // paid: they only fill space, so the prize goes to real operators. They are kept
  // only for an autopilot house-only demo (no real player, coordinator sponsor), so
  // it still settles; a hosted contest with no real player refunds its host instead.
  const hasReal = entries.some((e) => !e.isHouse);
  let excludeHouse = hasReal;
  if (!excludeHouse) {
    const sponsor = (
      await publicClient.readContract({
        address: dep.contestEngine,
        abi: contestEngineAbi,
        functionName: "getContest",
        args: [BigInt(contestId)],
      })
    ).sponsor;
    excludeHouse = sponsor.toLowerCase() !== coordinatorAddress().toLowerCase();
  }

  const scores = new Map<number, AgentScore>();
  for (const e of entries) {
    if (e.isHouse && excludeHouse) continue;
    scores.set(e.agentId, {
      agentId: e.agentId,
      operator: e.operator,
      correct: 0,
      totalLatencyMs: 0,
      computeLevel: levelOf.get(e.agentId) ?? 0,
    });
  }
  const nameOf = new Map(entries.map((e) => [e.agentId, e.agentName]));

  // Any answer that errored on a transient 0G blip (dropped fetch, slow
  // provider), to re-run once so it never lands as an unfair loss.
  const errored: { entry: Entry; puzzle: Puzzle }[] = [];

  // Each agent works through the puzzle set in order; agents run a few at a
  // time. Every answer is persisted and pushed to the live feed immediately.
  await mapLimit(entries, AGENT_CONCURRENCY, async (entry) => {
    const plan = planOf.get(entry.agentId)!;
    for (const puzzle of puzzles) {
      const outcome = await solvePuzzle(puzzle, plan);
      await recordOutcome(contestId, entry, puzzle, outcome, scores, nameOf);
      if (outcome.verdict === "error") errored.push({ entry, puzzle });
      // Gentle spacing keeps us comfortably under the provider rate limit.
      await sleep(150);
    }
  });

  // Retry sweep: transient infra errors must not cost an agent a puzzle. Re-run
  // the errored answers, up to a few rounds, until the blip clears.
  let pending = errored;
  for (let round = 1; round <= 3 && pending.length > 0; round++) {
    console.log(`contest ${contestId}: retry round ${round}, ${pending.length} errored answers`);
    broadcast({
      type: "status",
      contestId,
      payload: { status: "running", detail: `retrying ${pending.length} answers` },
    });
    const stillFailed: typeof pending = [];
    for (const { entry, puzzle } of pending) {
      const outcome = await solvePuzzle(puzzle, planOf.get(entry.agentId)!);
      await recordOutcome(contestId, entry, puzzle, outcome, scores, nameOf);
      if (outcome.verdict === "error") stillFailed.push({ entry, puzzle });
      await sleep(150);
    }
    pending = stillFailed;
  }

  return finalizeContest(contestId, rankAgents([...scores.values()]));
}
