import { query } from "../db/pool.js";
import { callModel } from "../compute/client.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";

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

export interface AgentMemory {
  summary: string;
  tendencies: MemoryTendencies;
  contests: number;
  model: string | null;
  chatId: string | null;
  storageRoot: string | null;
  updatedAt: string | null;
}

export interface MemoryTendencies {
  graded: number; // graded answers folded in
  correct: number;
  wrong: number;
  accuracy: number | null; // over graded (correct + wrong)
  byKind: Record<string, { correct: number; wrong: number }>;
  recentForm: string; // e.g. "WWLWL" newest first, a quick read of momentum
}

// Read an agent's stored memory (or null). Cheap; safe to call at decision time.
export async function getAgentMemory(agentId: number): Promise<AgentMemory | null> {
  const { rows } = await query<{
    summary: string;
    tendencies: MemoryTendencies;
    contests: number;
    model: string | null;
    chat_id: string | null;
    storage_root: string | null;
    updated_at: string | null;
  }>(
    "select summary, tendencies, contests, model, chat_id, storage_root, updated_at from agent_memory where agent_id = $1",
    [agentId],
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
export async function memoryHintFor(agentId: number): Promise<string> {
  if (!memoryEnabled()) return "";
  try {
    const m = await getAgentMemory(agentId);
    if (!m || !m.summary) return "";
    return `\n\nYour memory from past contests (apply it; do not repeat past mistakes): ${m.summary}`;
  } catch {
    return "";
  }
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

// Turn the raw tendencies into a plain-language brief the model reflects on.
function tendenciesBrief(t: MemoryTendencies): string {
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

const SUMMARIZER_SYSTEM =
  "You are an AI agent reflecting on your own contest record to play better next time. " +
  "Given your recent results, write a SHORT memory note (2 to 3 sentences, under 60 words): " +
  "your genuine strengths, the recurring mistakes to avoid, and one concrete rule to apply next time. " +
  "Be specific and honest, write in the first person, and output only the note.";

// Summarize one agent's own recent play into a fresh memory, authored on 0G Compute and
// anchored on 0G Storage. Best effort: any failure leaves the previous memory in place.
export async function updateAgentMemory(agentId: number): Promise<void> {
  const tendencies = await gatherTendencies(agentId);
  if (tendencies.graded < 3) return; // too little signal to summarize yet

  let summary = "";
  let model: string | null = null;
  let chatId: string | null = null;
  try {
    const res = await callModel({
      systemPrompt: SUMMARIZER_SYSTEM,
      userPrompt: tendenciesBrief(tendencies),
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

  // Anchor this memory version on 0G Storage for provenance (best effort, time-bounded
  // by the storage client). The root proves the memory was produced and stored on 0G.
  let storageRoot: string | null = null;
  if (storageConfigured()) {
    try {
      const up = await uploadJson({ kind: "agent-memory", agentId, summary, tendencies });
      storageRoot = up.rootHash;
    } catch (err) {
      console.error(`agent memory ${agentId}: 0G storage anchor failed:`, (err as Error).message);
    }
  }

  await query(
    `insert into agent_memory (agent_id, summary, tendencies, contests, model, chat_id, storage_root, updated_at)
       values ($1, $2, $3, 1, $4, $5, $6, now())
     on conflict (agent_id) do update set
       summary = excluded.summary,
       tendencies = excluded.tendencies,
       contests = agent_memory.contests + 1,
       model = excluded.model,
       chat_id = excluded.chat_id,
       storage_root = excluded.storage_root,
       updated_at = now()`,
    [agentId, summary, JSON.stringify(tendencies), model, chatId, storageRoot],
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

// After a contest settles, refresh memory for each REAL agent that played (house agents
// are never summarized). No-op unless AGENT_MEMORY is on. Best effort and sequential to
// keep the 0G call rate gentle; never throws into the settle path.
export async function updateMemoriesForContest(
  entries: { agentId: number; isHouse: boolean }[],
): Promise<void> {
  if (!memoryEnabled()) return;
  for (const e of entries) {
    if (e.isHouse) continue;
    try {
      await updateAgentMemory(e.agentId);
    } catch (err) {
      console.error(`agent memory: update for ${e.agentId} failed:`, (err as Error).message);
    }
  }
}
