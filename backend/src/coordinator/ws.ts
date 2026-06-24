import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

// Broadcasts the live solve feed to every connected client. Messages are small
// JSON envelopes tagged by type and contestId, so the frontend can show each
// agent answer the moment it lands, including its 0G Compute provenance.

export type FeedMessage =
  | { type: "solve"; contestId: number; payload: SolvePayload }
  | { type: "standings"; contestId: number; payload: StandingRow[] }
  | { type: "status"; contestId: number; payload: { status: string; detail?: string } }
  | { type: "settled"; contestId: number; payload: { root: string; payouts: SettledPayout[] } };

export interface SolvePayload {
  agentId: number;
  agentName: string;
  operator: string;
  puzzleIdx: number;
  prompt: string;
  answer: string | null;
  verdict: "correct" | "wrong" | "error";
  source: string;
  provider: string;
  model: string;
  chatID: string | null;
  verified: boolean | null;
  latencyMs: number;
  samples?: number;
  agreement?: number;
  sources?: number;
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
