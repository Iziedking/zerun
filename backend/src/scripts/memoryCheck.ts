import { query } from "../db/pool.js";
import { callModel } from "../compute/client.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import { memoryEnabled, getAgentMemory } from "../runners/agentMemory.js";

// Why does an agent have no memory?
//
// The memory write runs on the settle path and every failure inside it is deliberately caught
// and logged, so a broken memory can never stall a payout. The cost of that safety is silence:
// from the outside, "not enough contests yet", "the 0G summarize call failed" and "the 0G
// Storage anchor timed out" all look identical -- a card that says "No memory yet".
//
// This walks the exact same gates, in the exact same order, and says which one stopped.
//
//   AGENT=29 npx tsx src/scripts/memoryCheck.ts
//   AGENT=29 KIND=poker WRITE=1 npx tsx src/scripts/memoryCheck.ts   # actually do the write
//
// WRITE=1 spends one real 0G inference and one real 0G Storage upload. Without it, nothing is
// paid for and nothing is written: it only reports what WOULD happen.

const AGENT = Number(process.env.AGENT ?? "0");
const KINDS = (process.env.KIND ?? "general,poker,chess").split(",").map((s) => s.trim());
const WRITE = process.env.WRITE === "1";

const MIN_GRADED = Number(process.env.AGENT_MEMORY_MIN_GRADED ?? "3");
const MIN_NEW_GRADED = Number(process.env.AGENT_MEMORY_MIN_NEW_GRADED ?? "1");

function ok(b: boolean): string {
  return b ? "PASS" : "FAIL";
}

async function main() {
  if (!AGENT) throw new Error("set AGENT=<agent id>");

  console.log(`\nagent ${AGENT} — memory diagnosis\n`);
  console.log(`  AGENT_MEMORY enabled ......... ${ok(memoryEnabled())}  (${memoryEnabled() ? "on" : "OFF — nothing will ever be written"})`);
  console.log(`  0G Storage configured ........ ${storageConfigured() ? "yes (anchor REQUIRED for a write)" : "no (writes proceed unanchored)"}`);
  console.log(`  AGENT_MEMORY_MIN_GRADED ...... ${MIN_GRADED}`);
  console.log(`  AGENT_MEMORY_MIN_NEW_GRADED .. ${MIN_NEW_GRADED}`);

  // Gate 0: does the row the writer targets even accept the upsert? A missing composite
  // primary key makes `on conflict (agent_id, kind)` throw on EVERY write, forever, and the
  // error is caught upstream and logged as a one-line failure nobody reads.
  const pk = await query<{ cols: string }>(
    `select string_agg(a.attname, ',' order by k.ord) as cols
       from pg_constraint c
       join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.conrelid = 'agent_memory'::regclass and c.contype = 'p'
      group by c.oid`,
  );
  const pkCols = pk.rows[0]?.cols ?? "(none)";
  console.log(`  agent_memory primary key ..... ${pkCols}  ${pkCols === "agent_id,kind" ? "PASS" : "FAIL <- migrate.ts has not run; every upsert throws"}`);

  // What the arena actually knows about this agent, per kind.
  const counts = await query<{ kind: string; n: string }>(
    `select cm.kind, count(*)::text as n
       from contest_scores cs join contests_meta cm on cm.contest_id = cs.contest_id
      where cs.agent_id = $1 group by 1 order by 1`,
    [AGENT],
  );
  const graded = await query<{ n: string }>(
    `select count(*)::text as n from solve_runs where agent_id = $1 and verdict in ('correct','wrong')`,
    [AGENT],
  );
  console.log(`\n  contests scored, by kind: ${counts.rows.map((r) => `${r.kind}=${r.n}`).join("  ") || "(none)"}`);
  console.log(`  graded solve_runs (drives the "general" kind): ${graded.rows[0]?.n ?? 0}\n`);

  for (const kind of KINDS) {
    const k = kind as "general" | "poker" | "chess";
    // The same sample size the writer computes: graded answers for "general", contests played
    // for poker and chess (a move is never right or wrong, so those kinds cannot be graded).
    const sample =
      k === "general"
        ? Number(graded.rows[0]?.n ?? 0)
        : Number(counts.rows.find((r) => r.kind === k)?.n ?? 0);

    const prev = await getAgentMemory(AGENT, k);
    const before = prev?.tendencies ? Number(prev.tendencies.graded || prev.tendencies.plays || 0) : 0;
    const enough = sample >= MIN_GRADED;
    const fresh = !prev || sample - before >= MIN_NEW_GRADED;

    console.log(`  [${k}]`);
    console.log(`     sample size ............... ${sample}  (needs >= ${MIN_GRADED})  ${ok(enough)}`);
    console.log(`     has memory now ............ ${prev ? `yes, ${prev.contests} update(s)` : "no"}`);
    console.log(`     anything new to learn ..... ${ok(fresh)}`);
    if (!enough) {
      console.log(`     -> BLOCKED: too few contests. Lower AGENT_MEMORY_MIN_GRADED to see it sooner.\n`);
      continue;
    }
    if (!fresh) {
      console.log(`     -> BLOCKED: nothing new since the last memory. Working as intended.\n`);
      continue;
    }
    if (!WRITE) {
      console.log(`     -> would summarize on 0G now. Re-run with WRITE=1 to prove the 0G calls work.\n`);
      continue;
    }

    // The two paid steps, timed separately, so a failure names itself.
    const t0 = Date.now();
    try {
      const res = await callModel({
        systemPrompt: "Summarize in one sentence.",
        userPrompt: `Agent ${AGENT} played ${sample} ${k} contests.`,
        maxTokens: 60,
        temperature: 0.4,
      });
      console.log(`     0G summarize ............. PASS  ${Date.now() - t0}ms via ${res.model}`);
    } catch (err) {
      console.log(`     0G summarize ............. FAIL  ${Date.now() - t0}ms  ${(err as Error).message}`);
      console.log(`     -> this is why there is no memory.\n`);
      continue;
    }
    if (storageConfigured()) {
      const t1 = Date.now();
      try {
        const up = await uploadJson({ kind: "agent-memory-probe", agentId: AGENT, memoryKind: k });
        console.log(`     0G Storage anchor ........ PASS  ${Date.now() - t1}ms  ${up.rootHash.slice(0, 12)}…`);
      } catch (err) {
        console.log(`     0G Storage anchor ........ FAIL  ${Date.now() - t1}ms  ${(err as Error).message}`);
        console.log(`     -> the anchor is REQUIRED, so the memory is discarded. This is why there is none.\n`);
        continue;
      }
    }
    console.log(`     -> every gate passes. A settle for this kind will write a memory.\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("memoryCheck failed:", (e as Error).message);
    process.exit(1);
  });
