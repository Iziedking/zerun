import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { query } from "../../db/pool.js";
import { runAgentMove } from "./sandbox.js";
import { codeSha } from "../../auth/chessSubmitSig.js";
import { parseFEN, legalMoves, moveToUci, START_FEN } from "./engine.js";
import { storageConfigured, uploadBytes } from "../../storage/zgStorage.js";
import { currentChessSeason } from "./ratings.js";
import { defaultRating } from "../trueskill.js";

// Public submissions for the community chess competition: a player uploads one Python file, we
// prove it actually plays chess, and it joins the ladder.
//
// Nothing here trusts the file. It is smoke-tested inside the same sandbox that will run it in real
// games (no network, rlimits, wall-clock kill), on real positions, and it only becomes an active
// agent if it returns a LEGAL move in every one of them. So a submission that crashes, hangs, or
// hallucinates moves is rejected at the door instead of forfeiting games for a confused player.
//
// One entry per wallet. Resubmitting replaces the code and resets sigma (the uncertainty) without
// wiping mu, so a fixed agent must re-prove itself but is not sent back to zero — the same rule
// dev.fun's ladder uses, and the reason the board can be trusted late in a season.

const UPLOADS_ON = (process.env.CHESS_UPLOADS ?? "on").toLowerCase() === "on";
// The door does not open unless the isolation wrapper is configured. Accepting a stranger's Python
// and running it unsandboxed is the one failure this whole feature exists to prevent, so it must not
// be one forgotten .env line away — an unconfigured box reports "closed" instead of quietly running
// uploads bare. Set CHESS_SANDBOX_CMD (see deploy/README) to open it.
const SANDBOXED = Boolean((process.env.CHESS_SANDBOX_CMD ?? "").trim());
const AGENT_DIR = process.env.CHESS_UPLOAD_DIR ?? "./data/chess-agents";
const MAX_BYTES = Number(process.env.CHESS_UPLOAD_MAX_BYTES ?? "65536"); // 64 KB is a lot of chess
const SMOKE_MOVE_MS = Number(process.env.CHESS_SUBMIT_MOVE_MS ?? "6000");
const COOLDOWN_MS = Number(process.env.CHESS_SUBMIT_COOLDOWN_MS ?? "180000"); // 3 min between entries
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,23}$/;

export class SubmitError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 429 | 503 = 400,
  ) {
    super(message);
  }
}

// The positions every entry must handle: the opening (many quiet moves), a live middlegame with
// captures and a hanging piece, and a bare endgame (few legal moves, easy to get wrong). Passing
// all three means the agent reads `state`, respects the legal list, and answers within the clock.
const SMOKE: { label: string; fen: string }[] = [
  { label: "the opening position", fen: START_FEN },
  { label: "a middlegame position", fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3" },
  { label: "an endgame position", fen: "8/5k2/8/8/3K4/8/5R2/8 w - - 0 1" },
];

// Validations run one at a time. Each one spawns a sandbox and burns real CPU, so letting a burst
// of submissions run concurrently would starve the ladder games on a small box.
let gate: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = gate.then(fn, fn);
  gate = next.catch(() => undefined);
  return next;
}

export interface SmokeReport {
  ok: boolean;
  error?: string;
  moves: { position: string; uci: string | null; ms: number }[];
}

/** Play one move from each smoke position inside the sandbox. The agent must return a legal move
 * every time; anything else (crash, timeout, illegal, empty) fails the submission with the reason. */
export async function smokeTest(code: string, agentId = 0): Promise<SmokeReport> {
  const moves: SmokeReport["moves"] = [];
  for (const s of SMOKE) {
    const pos = parseFEN(s.fen);
    const legal = legalMoves(pos).map(moveToUci);
    const t0 = Date.now();
    const r = await runAgentMove(
      agentId,
      code,
      { fen: s.fen, legal, side: pos.turn, ply: 0 },
      { budgetMs: SMOKE_MOVE_MS },
    );
    const ms = Date.now() - t0;
    const uci = r.ok && r.uci ? r.uci : null;
    moves.push({ position: s.label, uci, ms });

    if (!r.ok) {
      const why =
        r.error === "timeout"
          ? `it ran out of time on ${s.label} (${SMOKE_MOVE_MS} ms per move)`
          : `it failed on ${s.label}: ${r.error ?? "no move"}`;
      return { ok: false, error: why, moves };
    }
    if (!uci || !legal.includes(uci)) {
      return {
        ok: false,
        error: `it returned "${uci ?? ""}" on ${s.label}, which is not a legal move. Return one of the strings in state["legal"].`,
        moves,
      };
    }
  }
  return { ok: true, moves };
}

export interface SubmitResult {
  agentId: number;
  name: string;
  resubmitted: boolean;
  storageRoot: string | null;
  smoke: SmokeReport["moves"];
}

async function writeAgentFile(agentId: number, code: string): Promise<string> {
  const dir = resolve(AGENT_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${agentId}.py`);
  await writeFile(path, code, "utf8");
  return path;
}

// Anchor the exact submitted bytes on 0G Storage. Provenance, not plumbing: the runner reads the
// local file, so a storage hiccup must never block a player from entering.
async function anchor(code: string): Promise<string | null> {
  if (!storageConfigured()) return null;
  try {
    const { rootHash } = await uploadBytes(Buffer.from(code, "utf8"));
    return rootHash;
  } catch (err) {
    console.warn("chess submit: 0G Storage anchor failed:", (err as Error).message);
    return null;
  }
}

/** Accept a player's agent: validate, sandbox-smoke-test, store, and put it on the ladder. */
export async function submitChessAgent(owner: string, rawName: string, code: string): Promise<SubmitResult> {
  if (!SANDBOXED) {
    console.error("chess submit: refused — CHESS_SANDBOX_CMD is unset, so uploads would run without isolation.");
  }
  if (!uploadsOpen()) throw new SubmitError("Submissions are closed right now.", 503);

  const name = rawName.trim();
  if (!NAME_RE.test(name)) {
    throw new SubmitError("Pick a name of 2-24 letters, numbers, spaces, dots, dashes or underscores.");
  }
  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes === 0) throw new SubmitError("The file is empty.");
  if (bytes > MAX_BYTES) {
    throw new SubmitError(`The file is ${(bytes / 1024).toFixed(1)} KB. The limit is ${MAX_BYTES / 1024} KB.`);
  }
  if (!/\bdef\s+choose_move\s*\(/.test(code)) {
    throw new SubmitError('The file must define choose_move(state) — that is the function we call for every move.');
  }

  // Someone else's name is confusing on a public board, and so is a duplicate.
  const { rows: taken } = await query<{ id: string }>(
    "select id from chess_agents where lower(name) = lower($1) and (owner is null or owner <> $2)",
    [name, owner],
  );
  if (taken.length) throw new SubmitError(`The name "${name}" is taken. Pick another.`, 409);

  const { rows: existing } = await query<{ id: string; updated_at: string }>(
    "select id, updated_at from chess_agents where kind = 'upload' and owner = $1 order by id asc limit 1",
    [owner],
  );
  const prev = existing[0];
  if (prev) {
    const age = Date.now() - new Date(prev.updated_at).getTime();
    if (age < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - age) / 1000);
      throw new SubmitError(`You just submitted. Try again in ${wait}s.`, 429);
    }
  }

  const report = await serialize(() => smokeTest(code, prev ? Number(prev.id) : 0));
  if (!report.ok) throw new SubmitError(`Your agent did not pass the check: ${report.error}`);

  const sha = codeSha(code);
  const storageRoot = await anchor(code);

  if (prev) {
    const agentId = Number(prev.id);
    const path = await writeAgentFile(agentId, code);
    await query(
      `update chess_agents
          set name = $2, code_root = $3, code_sha = $4, storage_root = $5, status = 'active', updated_at = now()
        where id = $1`,
      [agentId, name, path, sha, storageRoot],
    );
    // Reset the uncertainty, keep the skill: a new file has to re-prove itself on the board.
    await query("update chess_ratings set sigma = $3, updated_at = now() where season = $1 and agent_id = $2", [
      currentChessSeason(),
      agentId,
      defaultRating().sigma,
    ]);
    return { agentId, name, resubmitted: true, storageRoot, smoke: report.moves };
  }

  const { rows } = await query<{ id: string }>(
    `insert into chess_agents (owner, name, kind, status, code_sha, storage_root)
       values ($1, $2, 'upload', 'active', $3, $4)
     returning id`,
    [owner, name, sha, storageRoot],
  );
  const agentId = Number(rows[0]!.id);
  const path = await writeAgentFile(agentId, code);
  await query("update chess_agents set code_root = $2 where id = $1", [agentId, path]);
  return { agentId, name, resubmitted: false, storageRoot, smoke: report.moves };
}

export interface MyChessAgent {
  agentId: number;
  name: string;
  status: string;
  storageRoot: string | null;
  codeSha: string | null;
  submittedAt: string;
  mu: number;
  sigma: number;
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

/** A wallet's entry, if it has one: what it submitted and how it is doing. */
export async function myChessAgent(owner: string, season = currentChessSeason()): Promise<MyChessAgent | null> {
  const { rows } = await query<{
    id: string;
    name: string;
    status: string;
    storage_root: string | null;
    code_sha: string | null;
    updated_at: string;
    mu: number;
    sigma: number;
    games: number;
    wins: number;
    draws: number;
    losses: number;
  }>(
    `select a.id, a.name, a.status, a.storage_root, a.code_sha, a.updated_at,
            coalesce(r.mu, 25.0) as mu, coalesce(r.sigma, 8.3333333) as sigma,
            coalesce(r.games, 0) as games, coalesce(r.wins, 0) as wins,
            coalesce(r.draws, 0) as draws, coalesce(r.losses, 0) as losses
       from chess_agents a
       left join chess_ratings r on r.agent_id = a.id and r.season = $2
      where a.kind = 'upload' and a.owner = $1
      order by a.id asc
      limit 1`,
    [owner.toLowerCase(), season],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    agentId: Number(r.id),
    name: r.name,
    status: r.status,
    storageRoot: r.storage_root,
    codeSha: r.code_sha,
    submittedAt: new Date(r.updated_at).toISOString(),
    mu: Number(r.mu),
    sigma: Number(r.sigma),
    rating: Number(r.mu) - 3 * Number(r.sigma),
    games: Number(r.games),
    wins: Number(r.wins),
    draws: Number(r.draws),
    losses: Number(r.losses),
  };
}

export function uploadsOpen(): boolean {
  return UPLOADS_ON && SANDBOXED;
}
