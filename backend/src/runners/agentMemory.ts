import { query } from "../db/pool.js";
import { callModel } from "../compute/client.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import {
  emptySession,
  freeSession,
  isPaidMemoryKind,
  memoryKindFor,
  openPaidSession,
  type MemoryKind,
  type MemorySession,
} from "./memoryMarket.js";

export type { MemoryKind, MemorySession };

// Agent memory: retrieved-context evolution. After a contest settles, an agent's own
// recent play is summarized by a 0G Compute call into a compact self-profile and stored
// here; at decision time that summary is injected into the agent's prompt, so a seasoned
// agent reasons with its accumulated read instead of a blank prior. The summary is
// authored on 0G and anchored on 0G Storage, so "the agent learned on 0G" is provable.
// This is the agent's memory of ITSELF, distinct from the poker dossier (memory of
// OPPONENTS). Gated by AGENT_MEMORY so the lift can be A/B measured (memory on vs off);
// with the flag off, every function here is a cheap no-op and behaviour is unchanged.

export function memoryEnabled(): boolean {
  const v = (process.env.AGENT_MEMORY ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

// Memory runs on the settle path, so every knob here exists to keep it from becoming a
// way for a contest to hang, churn 0G calls, or write a memory it cannot prove.
//
// A summary needs this many graded answers before it means anything.
const MIN_GRADED = Number(process.env.AGENT_MEMORY_MIN_GRADED ?? "3");
// New graded answers required since the last summary. Without this an agent is
// re-summarized after every contest even when it learned nothing new, burning a 0G call
// and a 0G Storage write to produce the same note.
const MIN_NEW_GRADED = Number(process.env.AGENT_MEMORY_MIN_NEW_GRADED ?? "1");
// A floor between two summaries for the same agent. 0 disables it; the new-graded guard
// above is the real brake, this just smooths a burst of back-to-back contests.
const COOLDOWN_MS = Number(process.env.AGENT_MEMORY_COOLDOWN_MS ?? "0");
// Hard bound on one agent's whole update (0G summarize + 0G Storage anchor + write).
const UPDATE_TIMEOUT_MS = Number(process.env.AGENT_MEMORY_UPDATE_TIMEOUT_MS ?? "120000");
// The background queue never grows without limit. If the arena settles faster than memory
// can be written, we drop the overflow and say so rather than accumulating forever.
const QUEUE_MAX = Number(process.env.AGENT_MEMORY_QUEUE_MAX ?? "64");
// Longest summary we will inject into a prompt, so a pathological note cannot crowd out
// the task it is meant to help with.
const HINT_MAX_CHARS = Number(process.env.AGENT_MEMORY_HINT_CHARS ?? "400");

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

export interface AgentMemory {
  summary: string;
  tendencies: MemoryTendencies;
  contests: number;
  model: string | null;
  chatId: string | null;
  storageRoot: string | null;
  updatedAt: string | null;
}

// An agent keeps a separate memory per kind, because what it learned about arithmetic is
// not what it learned about the Sicilian. Each kind's record is built from that kind's own
// signal: correctness for the graded kinds, chips and ratings for poker, placements and
// material for chess.
export interface MemoryTendencies {
  // "general" (solver + analyst): a graded correct/wrong record.
  graded: number;
  correct: number;
  wrong: number;
  accuracy: number | null;
  byKind: Record<string, { correct: number; wrong: number }>;
  recentForm: string; // "WWLWL", newest first
  // "poker" and "chess": the kind's own outcomes. `plays` is the sample size for both,
  // so the shared freshness guard (has anything new happened?) works across every kind.
  plays?: number;
  wins?: number;
  rating?: number | null; // poker: conservative TrueSkill (mu - 3*sigma)
  avgPlace?: number | null; // chess: mean bracket finish, 1 is the championship
  best?: number | null; // chess: best finish so far
}

/** The sample size for a kind, used to decide whether anything new has happened. */
function sampleSize(t: MemoryTendencies): number {
  return t.graded > 0 ? t.graded : (t.plays ?? 0);
}

// Read an agent's stored memory for one kind (or null). Cheap; safe at decision time.
export async function getAgentMemory(agentId: number, kind: MemoryKind = "general"): Promise<AgentMemory | null> {
  const { rows } = await query<{
    summary: string;
    tendencies: MemoryTendencies;
    contests: number;
    model: string | null;
    chat_id: string | null;
    storage_root: string | null;
    updated_at: string | null;
  }>(
    "select summary, tendencies, contests, model, chat_id, storage_root, updated_at from agent_memory where agent_id = $1 and kind = $2",
    [agentId, kind],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    summary: r.summary,
    tendencies: r.tendencies,
    contests: r.contests,
    model: r.model,
    chatId: r.chat_id,
    storageRoot: r.storage_root,
    updatedAt: r.updated_at,
  };
}

// A short prompt block to append to an agent's system prompt, or "" when disabled or the
// agent has no memory yet. Kept compact so it never crowds out the task.
//
// This returns the NOTE only. Whether the agent may actually use it is a separate
// question, answered by the memory market: poker and chess memory is paid for per call.
// See `openMemoryFor`.
export async function memoryHintFor(agentId: number, kind: MemoryKind = "general"): Promise<string> {
  if (!memoryEnabled()) return "";
  try {
    const m = await getAgentMemory(agentId, kind);
    if (!m || !m.summary) return "";
    const note = m.summary.slice(0, HINT_MAX_CHARS);
    return `\n\nYour memory from past contests (apply it; do not repeat past mistakes): ${note}`;
  } catch (err) {
    // A memoryless agent plays exactly as it did before memory existed. Never let a bad
    // read take a contest down with it.
    console.warn(`agent memory ${agentId}: hint read failed, playing without it:`, (err as Error).message);
    return "";
  }
}

/**
 * Open one agent's memory for one contest: the note, plus the budget that pays for it.
 *
 * Solver and Analyst memory is free, so they get a session that never runs out. Poker and
 * chess memory is a product the platform sells, so their session is funded from the
 * agent's MemoryEscrow balance and hands out the note one paid call at a time. An agent
 * whose owner has not funded it, or has revoked its allowance, simply plays memoryless.
 *
 * House agents have no owner, no escrow, and no memory. They get nothing.
 */
export async function openMemoryFor(
  agentId: number,
  contestId: number,
  contestKind: string,
  isHouse: boolean,
): Promise<MemorySession> {
  if (isHouse || !memoryEnabled()) return emptySession;
  const kind = memoryKindFor(contestKind);
  const hint = await memoryHintFor(agentId, kind);
  if (!hint) return emptySession;
  if (!isPaidMemoryKind(kind)) return freeSession(hint);
  return openPaidSession(agentId, contestId, kind, hint);
}

const EMPTY: MemoryTendencies = {
  graded: 0,
  correct: 0,
  wrong: 0,
  accuracy: null,
  byKind: {},
  recentForm: "",
};

// Poker leaves no correct/wrong record: every decision is an "action". Its signal is the
// only thing that actually settles a poker contest — chips — plus the season rating, which
// is the arena's own verdict on whether the agent is any good.
async function gatherPokerTendencies(agentId: number): Promise<MemoryTendencies> {
  const scores = await query<{ score: number }>(
    `select cs.score
       from contest_scores cs
       join contests_meta cm on cm.contest_id = cs.contest_id
      where cs.agent_id = $1 and cm.kind = 'poker'
      order by cs.updated_at desc
      limit 40`,
    [agentId],
  );
  const rating = await query<{ mu: number; sigma: number; games: number; wins: number }>(
    "select mu, sigma, games, wins from poker_ratings where agent_id = $1 order by updated_at desc limit 1",
    [agentId],
  );

  const chips = scores.rows.map((r) => Number(r.score));
  const r = rating.rows[0];
  // A poker contest is won on chips, so "did I finish up" is the honest win test here.
  const wins = chips.filter((c) => c > 0).length;
  return {
    ...EMPTY,
    plays: chips.length,
    wins: r ? r.wins : wins,
    rating: r ? r.mu - 3 * r.sigma : null,
    recentForm: chips.slice(0, 12).map((c) => (c > 0 ? "W" : "L")).join(""),
  };
}

// Chess settles on bracket placement: contest_scores holds `size + 1 - place`, so the
// place is recoverable, and the field size is the number of agents scored in that contest.
async function gatherChessTendencies(agentId: number): Promise<MemoryTendencies> {
  const { rows } = await query<{ contest_id: string; score: number; field: string }>(
    `select cs.contest_id::text,
            cs.score,
            (select count(*) from contest_scores x where x.contest_id = cs.contest_id)::text as field
       from contest_scores cs
       join contests_meta cm on cm.contest_id = cs.contest_id
      where cs.agent_id = $1 and cm.kind = 'chess'
      order by cs.updated_at desc
      limit 40`,
    [agentId],
  );

  const places: number[] = [];
  for (const r of rows) {
    const field = Number(r.field);
    const place = field + 1 - Number(r.score);
    if (Number.isFinite(place) && place >= 1) places.push(place);
  }
  if (places.length === 0) return { ...EMPTY, plays: 0, wins: 0, avgPlace: null, best: null };

  const wins = places.filter((p) => p === 1).length;
  return {
    ...EMPTY,
    plays: places.length,
    wins,
    avgPlace: places.reduce((a, b) => a + b, 0) / places.length,
    best: Math.min(...places),
    recentForm: places.slice(0, 12).map((p) => (p === 1 ? "W" : "L")).join(""),
  };
}

// Aggregate an agent's recent graded record (Solver + Analyst only; poker "action" and
// World Cup "forecast" are not graded). Looks across the agent's whole history so memory
// accumulates, capped to a recent window so it stays current.
async function gatherTendencies(agentId: number): Promise<MemoryTendencies> {
  const { rows } = await query<{ kind: string | null; verdict: string }>(
    `select cm.kind, sr.verdict
       from solve_runs sr
       join contests_meta cm on cm.contest_id = sr.contest_id
      where sr.agent_id = $1
        and cm.kind in ('solver','analyst')
        and sr.verdict in ('correct','wrong')
      order by sr.created_at desc
      limit 80`,
    [agentId],
  );
  const byKind: Record<string, { correct: number; wrong: number }> = {};
  let correct = 0;
  let wrong = 0;
  const form: string[] = [];
  for (const r of rows) {
    const k = r.kind ?? "solver";
    byKind[k] ??= { correct: 0, wrong: 0 };
    if (r.verdict === "correct") {
      correct += 1;
      byKind[k].correct += 1;
      if (form.length < 12) form.push("W");
    } else {
      wrong += 1;
      byKind[k].wrong += 1;
      if (form.length < 12) form.push("L");
    }
  }
  const graded = correct + wrong;
  return {
    graded,
    correct,
    wrong,
    accuracy: graded > 0 ? correct / graded : null,
    byKind,
    recentForm: form.join(""),
  };
}

// Turn the raw tendencies into a plain-language brief the model reflects on. Each kind
// reads the agent its OWN scoreboard, because "you were 62% correct" means nothing to a
// chess player and "you averaged 3rd of 8" means nothing to a solver.
function tendenciesBrief(t: MemoryTendencies, kind: MemoryKind): string {
  if (kind === "poker") {
    if (!t.plays) return "No poker contests yet.";
    const rating = t.rating != null ? t.rating.toFixed(1) : "unrated";
    const up = t.recentForm ? t.recentForm.split("").filter((c) => c === "W").length : 0;
    return (
      `Over your last ${t.plays} poker contests you finished up in ${up} of them, ` +
      `and your season rating is ${rating} across ${t.wins ?? 0} wins. ` +
      `Recent form (newest first, W = finished up): ${t.recentForm || "n/a"}.`
    );
  }

  if (kind === "chess") {
    if (!t.plays) return "No chess tournaments yet.";
    const avg = t.avgPlace != null ? t.avgPlace.toFixed(1) : "n/a";
    return (
      `Over your last ${t.plays} chess tournaments you averaged ${avg} place, ` +
      `your best finish was ${t.best ?? "n/a"}, and you won ${t.wins ?? 0}. ` +
      `Recent form (newest first, W = won the bracket): ${t.recentForm || "n/a"}.`
    );
  }

  if (t.graded === 0) return "No graded answers yet.";
  const acc = t.accuracy != null ? `${Math.round(t.accuracy * 100)}%` : "n/a";
  const kinds = Object.entries(t.byKind)
    .map(([k, v]) => {
      const n = v.correct + v.wrong;
      const a = n > 0 ? `${Math.round((v.correct / n) * 100)}%` : "n/a";
      return `${k}: ${v.correct}/${n} correct (${a})`;
    })
    .join("; ");
  return `Over your last ${t.graded} graded answers you were ${t.correct} correct and ${t.wrong} wrong (${acc}). By kind: ${kinds}. Recent form (newest first): ${t.recentForm || "n/a"}.`;
}

// The reflection each kind asks for. Chess and poker want a positional/strategic note the
// agent can actually apply mid-game, not a report card.
const SUMMARIZER_SYSTEM: Record<MemoryKind, string> = {
  general:
    "You are an AI agent reflecting on your own contest record to play better next time. " +
    "Given your recent results, write a SHORT memory note (2 to 3 sentences, under 60 words): " +
    "your genuine strengths, the recurring mistakes to avoid, and one concrete rule to apply next time. " +
    "Be specific and honest, write in the first person, and output only the note.",
  poker:
    "You are an AI poker agent reflecting on your own results to play better. Given your recent " +
    "record, write a SHORT strategy note (2 to 3 sentences, under 60 words) you will read before every " +
    "betting decision: the leak your results suggest (too loose, too passive, paying off value bets), " +
    "and one concrete adjustment. Be specific about streets and bet sizing, write in the first person, " +
    "and output only the note.",
  chess:
    "You are an AI chess agent reflecting on your own tournament results to play better. Given your " +
    "record, write a SHORT positional note (2 to 3 sentences, under 60 words) you will read before " +
    "choosing every move: the pattern your results suggest (trading down when behind, missing tactics " +
    "in sharp positions, drifting in quiet ones), and one concrete rule for picking between candidate " +
    "moves. Write in the first person, and output only the note.",
};

// Fetch the right signal for a kind.
async function gatherFor(agentId: number, kind: MemoryKind): Promise<MemoryTendencies> {
  if (kind === "poker") return gatherPokerTendencies(agentId);
  if (kind === "chess") return gatherChessTendencies(agentId);
  return gatherTendencies(agentId);
}

// Should we spend a 0G call summarizing this agent right now? Cheap, DB-only checks that
// run before anything is paid for.
async function shouldSummarize(agentId: number, kind: MemoryKind, tendencies: MemoryTendencies): Promise<boolean> {
  const now = sampleSize(tendencies);
  if (now < MIN_GRADED) return false; // too little signal to summarize yet

  const prev = await getAgentMemory(agentId, kind);
  if (!prev) return true;

  // Nothing new happened since the last memory, so there is nothing new to learn. A
  // re-summarize here would pay for a 0G call and a 0G Storage write to restate the note
  // the agent already has.
  const before = prev.tendencies ? sampleSize(prev.tendencies) : 0;
  if (now - before < MIN_NEW_GRADED) return false;

  if (COOLDOWN_MS > 0 && prev.updatedAt) {
    const age = Date.now() - new Date(prev.updatedAt).getTime();
    if (Number.isFinite(age) && age < COOLDOWN_MS) return false;
  }
  return true;
}

// Summarize one agent's own recent play into a fresh memory, authored on 0G Compute and
// anchored on 0G Storage. Any failure leaves the previous memory in place, untouched.
export async function updateAgentMemory(agentId: number, kind: MemoryKind = "general"): Promise<void> {
  const tendencies = await gatherFor(agentId, kind);
  if (!(await shouldSummarize(agentId, kind, tendencies))) return;

  let summary = "";
  let model: string | null = null;
  let chatId: string | null = null;
  try {
    const res = await callModel({
      systemPrompt: SUMMARIZER_SYSTEM[kind],
      userPrompt: tendenciesBrief(tendencies, kind),
      maxTokens: 160,
      temperature: 0.4,
    });
    summary = (res.text ?? "").trim().replace(/\s+/g, " ").slice(0, 400);
    model = res.model;
    chatId = res.chatID;
  } catch (err) {
    console.error(`agent memory ${agentId}: 0G summarize failed:`, (err as Error).message);
    return;
  }
  if (!summary) return;

  // Anchor this memory version on 0G Storage. The root is what proves the memory was
  // produced on 0G and can be read back and checked, which is the entire point of storing
  // it there. So when 0G Storage is configured and the anchor fails, we DO NOT write the
  // memory: an unanchored note would be an edge nobody can audit. The agent keeps its
  // previous, provable memory and re-summarizes on its next contest.
  let storageRoot: string | null = null;
  if (storageConfigured()) {
    try {
      const up = await uploadJson({ kind: "agent-memory", memoryKind: kind, agentId, summary, tendencies });
      storageRoot = up.rootHash;
    } catch (err) {
      console.error(
        `agent memory ${agentId} (${kind}): 0G storage anchor failed, keeping the previous anchored memory:`,
        (err as Error).message,
      );
      return;
    }
  }

  await query(
    `insert into agent_memory (agent_id, kind, summary, tendencies, contests, model, chat_id, storage_root, updated_at)
       values ($1, $2, $3, $4, 1, $5, $6, $7, now())
     on conflict (agent_id, kind) do update set
       summary = excluded.summary,
       tendencies = excluded.tendencies,
       contests = agent_memory.contests + 1,
       model = excluded.model,
       chat_id = excluded.chat_id,
       storage_root = excluded.storage_root,
       updated_at = now()`,
    [agentId, kind, summary, JSON.stringify(tendencies), model, chatId, storageRoot],
  );
  console.log(
    `agent memory ${agentId} (${kind}): refreshed on ${model ?? "0G"} over ${sampleSize(tendencies)} results` +
      (storageRoot ? `, anchored at ${storageRoot.slice(0, 10)}…` : " (storage off)"),
  );
}

export interface MemoryLiftBucket {
  graded: number;
  correct: number;
  accuracy: number | null;
}
export interface MemoryLift {
  withMemory: MemoryLiftBucket;
  withoutMemory: MemoryLiftBucket;
  lift: number | null; // accuracy(with) - accuracy(without), the measured improvement
}

// The A/B signal for "agents improve with memory": accuracy of graded Solver/Analyst
// answers produced WITH memory injected vs WITHOUT (memory_used tag). Pre-memory answers
// are the control. A positive lift is evidence the retrieved-context memory helps.
export async function memoryLift(): Promise<MemoryLift> {
  const { rows } = await query<{ memory_used: boolean; graded: string; correct: string }>(
    `select sr.memory_used,
            count(*) as graded,
            count(*) filter (where sr.verdict = 'correct') as correct
       from solve_runs sr
       join contests_meta cm on cm.contest_id = sr.contest_id
      where cm.kind in ('solver','analyst') and sr.verdict in ('correct','wrong')
      group by sr.memory_used`,
    [],
  );
  const bucket = (used: boolean): MemoryLiftBucket => {
    const r = rows.find((x) => x.memory_used === used);
    const graded = r ? Number(r.graded) : 0;
    const correct = r ? Number(r.correct) : 0;
    return { graded, correct, accuracy: graded > 0 ? correct / graded : null };
  };
  const withMemory = bucket(true);
  const withoutMemory = bucket(false);
  const lift =
    withMemory.accuracy != null && withoutMemory.accuracy != null
      ? withMemory.accuracy - withoutMemory.accuracy
      : null;
  return { withMemory, withoutMemory, lift };
}

// One update per agent AND kind at a time. Two contests settling close together must not
// summarize the same agent's chess memory twice in parallel: they would race the write and
// pay for two 0G calls to produce one memory. Different kinds are independent.
const inFlight = new Map<string, Promise<void>>();

// Memory work is queued and drained one agent at a time. Every 0G call already passes
// through the compute layer's global throttle, so parallelism here would buy nothing and
// only make a settle wave contend with the contests still running.
let queue: Promise<void> = Promise.resolve();
let queued = 0;

async function runOne(agentId: number, kind: MemoryKind): Promise<void> {
  const key = `${agentId}:${kind}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = withTimeout(updateAgentMemory(agentId, kind), UPDATE_TIMEOUT_MS, `agent memory ${key}`)
    .catch((err) => {
      // A memory that fails to refresh simply stays as it was. Never escalate.
      console.error(`agent memory ${key}: update failed:`, (err as Error).message);
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, p);
  return p;
}

// After a contest settles, fold this contest's play into each REAL agent's memory (house
// agents are never summarized). This deliberately does NOT block the caller: settlement has
// already paid out, and a summarize is one 0G call per agent through a 7s global throttle,
// so awaiting it would hold the contest in the autopilot's in-flight set for minutes and
// eat its run timeout for work that no longer affects the money.
//
// No-op unless AGENT_MEMORY is on. Never throws.
export function scheduleMemoryUpdates(
  contestLabel: string,
  entries: { agentId: number; isHouse: boolean }[],
  contestKind = "solver",
): void {
  if (!memoryEnabled()) return;

  // A contest only refreshes the memory for ITS OWN kind. A poker night teaches an agent
  // nothing about chess, and re-summarizing every kind after every contest would pay for
  // 0G calls to restate notes that did not change.
  const kind = memoryKindFor(contestKind);
  const agents = [...new Set(entries.filter((e) => !e.isHouse).map((e) => e.agentId))];
  if (agents.length === 0) return;

  for (const agentId of agents) {
    if (queued >= QUEUE_MAX) {
      console.warn(`${contestLabel}: memory queue full (${QUEUE_MAX}), skipping agent ${agentId}`);
      continue;
    }
    queued += 1;
    queue = queue
      .then(() => runOne(agentId, kind))
      .catch(() => undefined)
      .finally(() => {
        queued -= 1;
      });
  }
}

// How many agent memory updates are waiting or running. Surfaced for diagnostics.
export function memoryQueueDepth(): number {
  return queued;
}
