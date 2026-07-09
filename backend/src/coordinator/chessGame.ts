import { query } from "../db/pool.js";
import { broadcast, type ChessMatchInfo } from "./ws.js";
import { recordScore, broadcastStandings } from "./standings.js";
import { computePlan } from "../runners/computeLevels.js";
import { callModel } from "../compute/client.js";
import { emptySession, type MemorySession } from "../runners/memoryMarket.js";
import {
  parseFEN,
  toFEN,
  applyMove,
  legalMoves,
  outcome,
  capturedValue,
  repetitionKey,
  sqToAlgebraic,
  START_FEN,
  type Color,
  type Position,
} from "../runners/chess/engine.js";
import { bestCandidates, adjudicate, engineForTier } from "../runners/chess/search.js";
import { CHESS_SYSTEM, buildChessPrompt, parseChessChoice } from "../runners/chess/decide.js";

// One chess game, played move by move on 0G. The engine hands the side to move a
// shortlist of strong candidate moves (search depth scales by tier) and the agent
// reasons on 0G Compute to pick one; on any 0G failure the engine's own best keeps the
// game progressing. A game ends at checkmate (or a draw), or at the per-game cap — in
// which case the side with the most captured material (by value) wins. This is the
// shared loop behind both the heads-up duel (runChessContest) and every bracket match
// (runChessTournament), so a duel and a tournament leg play by exactly the same rules.

// A ply costs one 0G call, and the compute layer paces calls 7s apart to stay under the
// provider's rate limit. So a 300-second match could only ever reach ~43 plies, about 21 moves
// each — and a checkmate typically needs 40+ moves. Every duel therefore ran out of clock and
// fell to the captured-material tiebreak, which is why they all ended the same way. Give a game
// enough clock to actually finish. The cost is wall-clock, not 0G: a decided game costs the
// same number of calls whenever it ends.
const MATCH_MS = Number(process.env.CHESS_MATCH_SECONDS ?? "600") * 1000;
const MAX_PLY = Number(process.env.CHESS_MAX_PLY ?? "300");
// How many candidate moves reach the prompt. Normally the TIER decides (a high tier is shown
// fewer, closer-to-equal options and so cannot pick a losing one); set this to override every
// tier at once, which only the bake-off and the perft harness want.
const CANDIDATES = Number(process.env.CHESS_CANDIDATES ?? "0");
const MIN_MOVE_MS = Number(process.env.CHESS_MIN_MOVE_MS ?? "300");

// Extra clock the premium tiers get to convert a won position. A deep search is slow and an
// endgame is long: a tier-5 agent that has ground its opponent down to king-and-pawns needs
// the moves to actually promote and mate, or the game is adjudicated and its work is thrown
// away as "material". Low tiers gain nothing from more clock — they have no technique to
// spend it on — so the cap follows the STRONGER seat. This is the drag: 4 and 5 can play long.
const DRAG_MS = Number(process.env.CHESS_DRAG_SECONDS ?? "240") * 1000;
const DRAG_MIN_TIER = Number(process.env.CHESS_DRAG_MIN_TIER ?? "4");
function matchMsFor(white: ChessPlayer, black: ChessPlayer): number {
  const top = Math.max(white.tier, black.tier);
  return MATCH_MS + (top >= DRAG_MIN_TIER ? DRAG_MS * (top - DRAG_MIN_TIER + 1) : 0);
}

// How much of an edge, in centipawns, the neutral adjudicator must see before it calls a
// winner. Below this the position really is level and the game falls through to the next key.
// A pawn is 100; 100cp is "clearly better", not "a rounding error".
const ADJ_MARGIN = Number(process.env.CHESS_ADJUDICATION_MARGIN ?? "100");

// When the engine's best move leads the second-best by this many centipawns, the choice is
// forced in all but name. Spending a paced, paid 0G call to rubber-stamp it starves the game
// of the clock it needs to reach a real ending. Measured over self-play: a 50cp bar skips
// about 23% of plies, so a match reaches roughly a quarter more of them.
//
// The agent still thinks on 0G wherever the choice is actually a choice, which is the only
// place thinking was ever worth paying for. Set to 0 to consult 0G on every single ply.
const FORCED_MARGIN = Number(process.env.CHESS_FORCED_MARGIN ?? "50");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A player in a chess game: identity, house flag, and its on-chain Compute tier (which
// sets its search depth and 0G model). Seats are white then black.
export interface ChessPlayer {
  agentId: number;
  operator: string;
  agentName: string;
  isHouse: boolean;
  tier: number;
}

export interface PlayChessGameOptions {
  contestId: number;
  white: ChessPlayer;
  black: ChessPlayer;
  // Offset added to each move's ply for the solve_runs.puzzle_idx key, so games that
  // share a contestId (every leg of a tournament) never collide on that unique key.
  // A duel passes 0 (or omits it) and behaves exactly as before.
  moveIndexBase?: number;
  // Tournament context, attached to every board broadcast so the live view can label
  // itself. Omit for a duel.
  match?: ChessMatchInfo | null;
  // Write the running captured-material score to contest_scores after each move (the
  // duel's live standings). A tournament ranks by placement instead, so it passes false.
  recordCaptureStandings?: boolean;
  // Optional external log to append each move to (for an audit/replay upload).
  moveLog?: unknown[];
  // Each seat's memory budget for this contest. A move that can pay reasons with the
  // agent's positional note; one that cannot plays exactly as it did before memory
  // existed. A tournament opens these once and shares them across every match, so the
  // budget spans the whole bracket rather than resetting each round.
  memory?: { white: MemorySession; black: MemorySession };
}

// The outcome of one game: which seat won on the board and why, the final captured
// material, and how long the game ran. Payout eligibility (house exclusion) is the
// caller's decision — this only decides the board winner.
export interface ChessGameResult {
  winnerSeat: 0 | 1; // 0 = white, 1 = black
  winner: ChessPlayer;
  loser: ChessPlayer;
  how: string;
  caps: { w: number; b: number };
  plies: number;
  finalFen: string;
  result: string | null; // checkmate / stalemate / draw kind, or null at the time cap
}

// One move: engine candidates, then the agent's 0G pick (falling back to the engine's
// best on any failure). Returns the chosen move plus a feed line and its provenance.
async function decideMove(
  pos: Position,
  tier: number,
  memory: MemorySession,
): Promise<{ uci: string; reason: string; source: string; provider: string; model: string; chatID: string | null; verified: boolean | null; latencyMs: number; memoryUsed: boolean }> {
  const candidates = bestCandidates(pos, tier, CANDIDATES > 0 ? CANDIDATES : undefined);
  const youAre: "white" | "black" = pos.turn === "w" ? "white" : "black";
  const models = computePlan(tier).models;

  // A move that is clearly best is not a decision. Play it instantly and keep the clock (and
  // the 0G budget) for the positions where the agent's judgment can change the game.
  const lead = candidates.length > 1 ? candidates[0]!.score - candidates[1]!.score : Infinity;
  if (FORCED_MARGIN > 0 && lead >= FORCED_MARGIN) {
    const best = candidates[0]!;
    return {
      uci: best.uci,
      reason: candidates.length > 1 ? `forced, ${Math.round(lead / 100)} pawns clear` : "only move",
      source: "engine",
      provider: "deterministic",
      model: `tier-${Math.max(0, Math.min(5, Math.floor(tier)))}-search-d${engineForTier(tier).depth}`,
      chatID: null,
      verified: null,
      latencyMs: 0,
      memoryUsed: false,
    };
  }
  // Spend for this move. `take()` returns "" the moment the agent's escrow budget runs
  // dry, so it plays on without its note instead of stalling the game.
  const note = memory.take();
  try {
    const res = await callModel({
      systemPrompt: CHESS_SYSTEM + note,
      userPrompt: buildChessPrompt(pos, candidates, youAre),
      // A UCI move plus a twelve-word reason. 48 was sized for the move alone, and a reason
      // truncated mid-phrase reads worse than none. Output tokens are the cheap half of a
      // chess call anyway: the board and candidate list dominate the input.
      maxTokens: 64,
      temperature: 0.3,
      models,
      tier, // only the premium tiers reason on mainnet
    });
    const { pick, matched } = parseChessChoice(res.text, candidates);
    const reason = matched ? (res.text.split("\n").slice(1).join(" ").trim() || `plays ${pick.uci}`) : `plays ${pick.uci}`;
    return {
      uci: pick.uci,
      reason: reason.slice(0, 120),
      source: res.source,
      provider: res.provider,
      model: res.model,
      chatID: res.chatID,
      verified: res.verified,
      latencyMs: res.latencyMs,
      memoryUsed: note !== "",
    };
  } catch {
    // 0G unavailable this move: play the engine's best so the game always progresses. The
    // agent paid for a memory-assisted call it never received, so give the charge back.
    memory.refund();
    const best = candidates[0]!;
    return {
      uci: best.uci,
      reason: `engine plays ${best.uci}`,
      source: "engine",
      provider: "deterministic",
      model: `tier-${Math.max(0, Math.min(5, Math.floor(tier)))}-search-d${engineForTier(tier).depth}`,
      chatID: null,
      verified: null,
      latencyMs: 0,
      memoryUsed: false,
    };
  }
}

function moveByUci(pos: Position, uci: string) {
  const from = (uci.charCodeAt(0) - 97) + (Number(uci[1]) - 1) * 8;
  const to = (uci.charCodeAt(2) - 97) + (Number(uci[3]) - 1) * 8;
  const promo = uci.length > 4 ? (uci[4] as "q" | "r" | "b" | "n") : undefined;
  return legalMoves(pos).find((m) => m.from === from && m.to === to && (m.promo ?? "") === (promo ?? ""));
}

// Play a full game between white and black, broadcasting the live board and persisting
// each move to the audit feed. Returns the board winner; the caller decides the payout.
export async function playChessGame(opts: PlayChessGameOptions): Promise<ChessGameResult> {
  const { contestId, white, black } = opts;
  const players: [ChessPlayer, ChessPlayer] = [white, black];
  const base = opts.moveIndexBase ?? 0;
  // No budget passed (a plain duel, or an unfunded seat) means no memory: the game plays
  // exactly as it did before memory existed.
  const memWhite = opts.memory?.white ?? emptySession;
  const memBlack = opts.memory?.black ?? emptySession;
  const match = opts.match ?? null;

  let pos = parseFEN(START_FEN);
  const seen = new Map<string, number>();
  let ply = 0;
  const matchMs = matchMsFor(white, black);
  const deadline = Date.now() + matchMs;
  console.log(
    `chess ${contestId}: game start, ${white.agentName} (white) vs ${black.agentName} (black)` +
      `${match ? ` [${match.label}]` : ""}, cap ${matchMs / 1000}s / ${MAX_PLY} ply`,
  );

  try {
    while (ply < MAX_PLY && Date.now() < deadline) {
      const key = repetitionKey(pos);
      const repeats = (seen.get(key) ?? 0) + 1;
      seen.set(key, repeats);
      if (outcome(pos, repeats).over) break;

      const color: Color = pos.turn;
      const seat = color === "w" ? 0 : 1;
      const mover = players[seat];

      const decided = await decideMove(pos, mover.tier, seat === 0 ? memWhite : memBlack);
      const move = moveByUci(pos, decided.uci) ?? legalMoves(pos)[0]!;
      const captured = pos.board[move.to] !== "";
      pos = applyMove(pos, move);
      ply += 1;

      const caps = capturedValue(pos);
      // Best-effort feed + audit; never throw out of the game loop.
      try {
        broadcast({
          type: "chess",
          contestId,
          payload: {
            fen: toFEN(pos),
            ply,
            lastMove: decided.uci,
            lastFrom: sqToAlgebraic(move.from),
            lastTo: sqToAlgebraic(move.to),
            capture: captured,
            mover: { agentId: mover.agentId, agentName: mover.agentName, operator: mover.operator, color },
            reason: decided.reason,
            provider: decided.provider,
            model: decided.model,
            chatID: decided.chatID,
            verified: decided.verified,
            latencyMs: decided.latencyMs,
            source: decided.source,
            captures: caps,
            turn: pos.turn,
            match,
          },
        });
        await query(
          `insert into solve_runs
             (contest_id, agent_id, operator, puzzle_idx, prompt, expected, answer, verdict, source, provider, model, chat_id, verified, latency_ms, samples, sources, memory_used)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           on conflict (contest_id, agent_id, puzzle_idx) do update set answer = excluded.answer`,
          [contestId, mover.agentId, mover.operator, base + ply, "chess move", null, decided.uci, "move", decided.source, decided.provider, decided.model, decided.chatID, decided.verified, decided.latencyMs, 1, 0, decided.memoryUsed],
        );
        if (opts.recordCaptureStandings) {
          // Live captured-material standings each move (the duel view).
          await recordScore(contestId, players[0].agentId, caps.w, "captures");
          await recordScore(contestId, players[1].agentId, caps.b, "captures");
          await broadcastStandings(contestId).catch(() => {});
        }
      } catch (err) {
        console.error(`chess ${contestId}: record/broadcast move failed:`, (err as Error).message);
      }
      opts.moveLog?.push({ ply: base + ply, uci: decided.uci, source: decided.source, match: match?.label ?? null });
      if (MIN_MOVE_MS > 0) await sleep(MIN_MOVE_MS);
    }
  } catch (err) {
    console.error(`chess ${contestId}: game loop error, deciding on state so far:`, (err as Error).message);
  }

  // ---------------------------------------------------------------------------
  // Deciding the game. A contest must name a winner, and most of ours do not end in
  // checkmate, so the tiebreak is not a footnote — it IS the result for the majority of
  // games. It runs as a ladder, each rung answering a narrower question:
  //
  //   1. checkmate            the board already answered.
  //   2. position             who was WINNING when the clock stopped? A neutral engine, the
  //                           same depth and eval for both seats regardless of tier, reads
  //                           the final position. This is the honest read of an unfinished
  //                           game, and it is what "material" was always a crude proxy for:
  //                           material counts a queen you won and ignores the mate you are
  //                           about to be handed. Only applied to a game that ran out of
  //                           clock; a game the board itself drew was not unfinished.
  //   3. material             captured value. A real draw (stalemate, threefold, fifty-move)
  //                           means neither side could make progress, so the record of the
  //                           game played is fairer than a verdict on the final still frame.
  //   4. tier                 the taboo, made explicit: when nothing on the board separates
  //                           them, the agent that invested more 0G takes it.
  //   5. lower agent id       deterministic last resort, so a game never fails to resolve.
  const key = repetitionKey(pos);
  const finalOutcome = outcome(pos, seen.get(key) ?? 1);
  const caps = capturedValue(pos);
  const drawnOnBoard = finalOutcome.over && finalOutcome.result !== "checkmate";
  let winnerSeat: 0 | 1;
  let how: string;

  // The neutral verdict on the final position, white's point of view, in centipawns. Costs
  // one search at the very end of a game, not per move.
  let edge = 0;
  try {
    edge = drawnOnBoard ? 0 : adjudicate(pos);
  } catch (err) {
    console.error(`chess ${contestId}: adjudication failed, falling back to material:`, (err as Error).message);
  }

  if (finalOutcome.over && finalOutcome.result === "checkmate" && finalOutcome.winner) {
    winnerSeat = finalOutcome.winner === "w" ? 0 : 1;
    how = "checkmate";
  } else if (Math.abs(edge) >= ADJ_MARGIN) {
    winnerSeat = edge > 0 ? 0 : 1;
    how = `adjudicated, +${(Math.abs(edge) / 100).toFixed(1)}`;
  } else if (caps.w !== caps.b) {
    winnerSeat = caps.w > caps.b ? 0 : 1;
    how = drawnOnBoard ? "material (draw)" : "material (time)";
  } else {
    const t0 = players[0].tier;
    const t1 = players[1].tier;
    winnerSeat = t0 > t1 ? 0 : t1 > t0 ? 1 : players[0].agentId <= players[1].agentId ? 0 : 1;
    how = t0 === t1 ? "even, decided by seniority" : "even, decided by tier";
  }

  return {
    winnerSeat,
    winner: players[winnerSeat],
    loser: players[winnerSeat === 0 ? 1 : 0],
    how,
    caps,
    plies: ply,
    finalFen: toFEN(pos),
    result: finalOutcome.over ? finalOutcome.result : null,
  };
}
