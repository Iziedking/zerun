import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callModel } from "../../compute/client.js";
import { legalMoves, toFEN, moveToUci, type Position } from "./engine.js";
import type { Mover } from "./movers.js";

// Runs an uploaded chess agent for one move, inside a sandbox, and services its single 0G call.
//
// The trust model: the player's file is untrusted and runs behind the isolation wrapper named by
// CHESS_SANDBOX_CMD (bubblewrap + prlimit on the box: no network, rlimits, non-root, tmpfs — see
// deploy/sandbox-run.sh). The agent has NO network of its own; when it calls call_model, the
// harness relays the request out through stdio to THIS process, which makes the real 0G call and
// relays the answer back. So Zerun always owns the inference (metered, one call per move, a daily
// per-agent cap), and a hostile agent can burn only its own budget, never the box or the wallet.
//
// A fresh process per move on purpose: each choose_move gets clean isolation and no state can leak
// between moves. Agents are therefore stateless per move, exactly like the dev.fun model.

const HARNESS = fileURLToPath(new URL("./agentHarness.py", import.meta.url));

const SANDBOX_CMD = (process.env.CHESS_SANDBOX_CMD ?? "").trim();
const PYTHON = process.env.CHESS_SANDBOX_PYTHON ?? "python3";
const MOVE_BUDGET_MS = Number(process.env.CHESS_SANDBOX_MOVE_MS ?? "5000");
const KILL_GRACE_MS = Number(process.env.CHESS_SANDBOX_KILL_GRACE_MS ?? "1500");
// How long Zerun's own 0G call may take before the move is abandoned. This is OUR latency, not the
// agent's, so it is bounded separately from the player's thinking budget (see the clock below).
const MODEL_TIMEOUT_MS = Number(process.env.CHESS_SANDBOX_MODEL_MS ?? "25000");
const MAX_TOKENS = Number(process.env.CHESS_SANDBOX_MAX_TOKENS ?? "256");
const UPLOAD_TIER = Number(process.env.CHESS_UPLOAD_TIER ?? "4");
const DAILY_CALL_CAP = Number(process.env.CHESS_SANDBOX_DAILY_CALLS ?? "1000");

// A neutral framing; the agent controls the real content of the prompt it passes to call_model.
const AGENT_SYSTEM = "You are a chess assistant. Answer concisely and directly.";

let warnedNoIsolation = false;

// Per-agent daily 0G call budget (in-memory; resets on restart). One call per move is already
// enforced in the harness; this caps the day so a busy agent cannot run up an unbounded 0G bill.
const calls = new Map<number, { day: string; n: number }>();

function withinBudget(agentId: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const e = calls.get(agentId);
  if (!e || e.day !== day) {
    calls.set(agentId, { day, n: 0 });
    return true;
  }
  return e.n < DAILY_CALL_CAP;
}

function noteCall(agentId: number): void {
  const e = calls.get(agentId);
  if (e) e.n += 1;
}

async function serveCall(
  agentId: number,
  tier: number,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; msg: string }> {
  if (!withinBudget(agentId)) return { ok: false, msg: "daily model budget reached" };
  noteCall(agentId);
  try {
    const r = await callModel({
      systemPrompt: AGENT_SYSTEM,
      userPrompt: String(prompt).slice(0, 4000),
      maxTokens: MAX_TOKENS,
      temperature: 0.7,
      tier,
    });
    return { ok: true, text: r.text ?? "" };
  } catch (err) {
    return { ok: false, msg: (err as Error).message };
  }
}

export interface SandboxState {
  fen: string;
  legal: string[];
  side: "w" | "b";
  ply: number;
}

export interface SandboxResult {
  ok: boolean;
  uci?: string;
  error?: string;
}

interface ProtoMsg {
  t?: string;
  prompt?: unknown;
  uci?: unknown;
  msg?: unknown;
}

/** Run one move of an uploaded agent. Never throws: a crash, timeout, or bad output resolves to
 * `{ ok: false }`, and the referee turns that into a forfeit. */
export async function runAgentMove(
  agentId: number,
  code: string,
  state: SandboxState,
  opts: { tier?: number; budgetMs?: number } = {},
): Promise<SandboxResult> {
  const tier = opts.tier ?? UPLOAD_TIER;
  const budgetMs = opts.budgetMs ?? MOVE_BUDGET_MS;

  const dir = mkdtempSync(join(tmpdir(), "zchess-"));
  const agentFile = join(dir, "agent.py");
  writeFileSync(agentFile, code, "utf8");

  let argv: string[];
  if (SANDBOX_CMD) {
    argv = [...SANDBOX_CMD.split(/\s+/), HARNESS, agentFile];
  } else {
    if (!warnedNoIsolation) {
      console.warn(
        "chess sandbox: CHESS_SANDBOX_CMD is unset — running agents WITHOUT isolation. Dev only, never in prod.",
      );
      warnedNoIsolation = true;
    }
    argv = [PYTHON, "-I", HARNESS, agentFile];
  }

  return await new Promise<SandboxResult>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let stderr = "";

    // The agent's clock measures the AGENT's thinking, and only that. When it calls call_model we
    // stop the clock, make the 0G call on its behalf, and restart it when the answer goes back:
    // Zerun's inference latency is not the player's time. Charging it to them would forfeit the
    // games of every agent that uses the very inference this competition hands them — a 0G call can
    // easily outlast a five-second move budget on its own.
    //
    // The pause is safe. It relaxes only the WALL clock: the agent is blocked on stdin waiting for
    // the answer, the harness allows one call per move, the model call has its own timeout, and the
    // sandbox's CPU rlimit still kills anything that tries to think while it waits.
    let remaining = budgetMs + KILL_GRACE_MS;
    let armedAt = Date.now();
    let clock: ReturnType<typeof setTimeout> | null = null;
    let modelClock: ReturnType<typeof setTimeout> | null = null;

    const stopClock = () => {
      if (!clock) return;
      clearTimeout(clock);
      clock = null;
      remaining -= Date.now() - armedAt;
    };
    const startClock = () => {
      armedAt = Date.now();
      clock = setTimeout(() => done({ ok: false, error: "timeout" }), Math.max(1, remaining));
    };

    const done = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      if (clock) clearTimeout(clock);
      if (modelClock) clearTimeout(modelClock);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    const send = (obj: unknown) => {
      try {
        child.stdin?.write(JSON.stringify(obj) + "\n");
      } catch {
        /* pipe closed */
      }
    };

    child.on("error", (e) => done({ ok: false, error: "spawn failed: " + e.message }));
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("exit", (codeNum) => {
      if (!settled) {
        done({ ok: false, error: `agent exited (${codeNum})${stderr ? ": " + stderr.slice(0, 200) : ""}` });
      }
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      let msg: ProtoMsg;
      try {
        msg = JSON.parse(line) as ProtoMsg;
      } catch {
        return; // ignore non-JSON the agent may have printed
      }
      if (msg.t === "call") {
        stopClock();
        modelClock = setTimeout(() => done({ ok: false, error: "model timeout" }), MODEL_TIMEOUT_MS);
        void serveCall(agentId, tier, String(msg.prompt ?? "")).then((res) => {
          if (modelClock) {
            clearTimeout(modelClock);
            modelClock = null;
          }
          if (settled) return;
          if (res.ok) send({ t: "model", text: res.text });
          else send({ t: "model_err", msg: res.msg });
          startClock();
        });
      } else if (msg.t === "move") {
        done({ ok: true, uci: String(msg.uci ?? "").trim() });
      } else if (msg.t === "error") {
        done({ ok: false, error: String(msg.msg ?? "agent error") });
      }
    });

    // Kick it off with the position as the first line, and start the agent's clock.
    startClock();
    send({ t: "state", fen: state.fen, legal: state.legal, side: state.side, ply: state.ply, budget_ms: budgetMs });
  });
}

export interface UploadAgent {
  id: number;
  code: string;
  tier?: number;
}

/** The Mover for an uploaded agent: hands the referee's position to the sandbox and returns the
 * move it chose. A forfeit comes back as an empty string, which the referee rules illegal. */
export function sandboxMover(agent: UploadAgent): Mover {
  return async (pos: Position, ctx) => {
    const legal = legalMoves(pos).map(moveToUci);
    const r = await runAgentMove(
      agent.id,
      agent.code,
      { fen: toFEN(pos), legal, side: pos.turn, ply: ctx.ply },
      { tier: agent.tier, budgetMs: ctx.deadlineMs },
    );
    return r.ok && r.uci ? r.uci : "";
  };
}
