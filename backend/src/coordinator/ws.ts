import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

// Broadcasts the live solve feed to every connected client. Messages are small
// JSON envelopes tagged by type and contestId, so the frontend can show each
// agent answer the moment it lands, including its 0G Compute provenance.

export type FeedMessage =
  | { type: "solve"; contestId: number; payload: SolvePayload }
  | { type: "standings"; contestId: number; payload: StandingRow[] }
  | { type: "status"; contestId: number; payload: { status: string; detail?: string } }
  | { type: "settled"; contestId: number; payload: { root: string; payouts: SettledPayout[] } }
  | { type: "x402"; contestId: number; payload: X402Payload }
  | { type: "poker"; contestId: number; payload: PokerSnapshot }
  | { type: "chess"; contestId: number; payload: ChessSnapshot }
  | { type: "bracket"; contestId: number; payload: BracketSnapshot };

// An agent paid for data over x402 (a poker opponent dossier, or World Cup intel).
// The tx hash verifies on chain.
export interface X402Payload {
  agentId: number;
  agentName: string;
  opponentName?: string; // poker: the scouted opponent
  label?: string; // generic: what the payment bought (e.g. "intel: Spain")
  priceUsdc: string;
  txHash: string;
}

export interface PokerSeat {
  agentId: number;
  name: string;
  chips: number;
  holeCards: string[]; // shown to spectators
  folded: boolean;
  isTurn: boolean;
  isHouse: boolean;
}

// A snapshot of the poker table after an action, so the UI can render a live table.
export interface PokerSnapshot {
  handIndex: number;
  street: string;
  board: string[];
  pot: number;
  seats: PokerSeat[];
  lastAction?: { agentId: number; name: string; action: string; reasoning: string; chatID: string | null };
}

// Which tournament match a chess move belongs to, so the live board can label itself
// ("Semifinal · Nova vs Echo") when the game is one leg of a bracket. Absent for a duel.
export interface ChessMatchInfo {
  round: number; // 0 = first round
  index: number; // match index within the round
  label: string; // human label, e.g. "Semifinal · Nova vs Echo"
  totalRounds: number;
}

// A snapshot of the chess board after a move, so the UI can render a live game with the
// mover's 0G reasoning and the running captured-material score.
export interface ChessSnapshot {
  fen: string;
  ply: number;
  lastMove: string; // UCI, e.g. e2e4
  lastFrom: string; // algebraic, e.g. e2
  lastTo: string;
  capture: boolean;
  mover: { agentId: number; agentName: string; operator: string; color: "w" | "b" };
  reason: string;
  provider: string;
  model: string;
  chatID: string | null;
  verified: boolean | null;
  latencyMs: number;
  source: string;
  captures: { w: number; b: number };
  turn: "w" | "b";
  // Present only when this game is a leg of a tournament bracket.
  match?: ChessMatchInfo | null;
}

// One seat in a chess tournament, with the metadata the bracket UI needs to render an
// agent character and its seed.
export interface BracketSeat {
  agentId: number;
  agentName: string;
  operator: string;
  isHouse: boolean;
  tier: number;
  seed: number; // 1-based seed (1 = strongest)
}

// One match node in the bracket, referring to seats by agentId.
export interface BracketMatchView {
  round: number;
  index: number;
  a: number | null; // agentId, or null until fed by a prior round
  b: number | null;
  winner: number | null;
  live: boolean; // currently being played
}

// The whole single-elimination bracket, broadcast as the tournament fills (lobby),
// plays out (playing), and completes. The UI renders the rounds, the live match, the
// champion, and the final placements from this.
export interface BracketSnapshot {
  contestId: number;
  status: "lobby" | "playing" | "complete";
  size: number; // padded to a power of two
  capacity: number; // target seats (e.g. 8)
  filled: number; // seats occupied so far (lobby)
  rounds: BracketMatchView[][];
  seats: BracketSeat[];
  currentMatch: { round: number; index: number; label: string } | null;
  champion: number | null;
  placements: { agentId: number; place: number }[];
}

export interface SolvePayload {
  agentId: number;
  agentName: string;
  operator: string;
  puzzleIdx: number;
  prompt: string;
  answer: string | null;
  // "action" is a poker betting move (no right/wrong answer, just a play).
  verdict: "correct" | "wrong" | "error" | "action" | "forecast";
  source: string;
  provider: string;
  model: string;
  chatID: string | null;
  verified: boolean | null;
  latencyMs: number;
  samples?: number;
  agreement?: number;
  sources?: number;
  liveInsight?: boolean;
  // A short snippet of the agent's 0G reasoning for this move (poker).
  reasoning?: string;
}

export interface StandingRow {
  agentId: number;
  agentName: string;
  operator: string;
  correct: number;
  totalLatencyMs: number;
  rank: number;
  computeLevel?: number;
  passes?: number;
  // The value the contest ranks on (chips / P&L / correct) and its label, so the
  // standings show the number that decides the winner. Optional for older callers.
  score?: number;
  metric?: string;
}

export interface SettledPayout {
  operator: string;
  amount: string;
  rank: number;
}

let wss: WebSocketServer | null = null;

export function attachWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "status", contestId: 0, payload: { status: "connected" } }));
  });
}

export function broadcast(message: FeedMessage): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}
