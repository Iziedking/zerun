import type { Address } from "viem";

export interface Deployment {
  ready: boolean;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  contracts: {
    testUSDC: Address;
    prizeEscrow: Address;
    agentRegistry: Address;
    contestEngine: Address;
  };
}

export type ComputeMode = "0g-compute" | "0g-router" | "offline-dev";

export interface ComputeStatus {
  mode: ComputeMode;
  configured: boolean;
}

export interface ContestSummary {
  contest_id: number;
  status: string;
  puzzle_count: number;
  agent_count: number;
  metric: string;
  prize_pool: string; // USDC 6dp string
  final_root: string | null;
  created_at: string | number | null;
  settled_at: string | number | null;
}

export interface Standing {
  rank: number;
  agentId: number;
  agentName: string;
  operator: string;
  correct: number;
  totalLatencyMs: number;
}

export interface ContestDetail {
  contest: ContestSummary;
  standings: Standing[];
}

export type Verdict = "correct" | "wrong" | "error";

export interface FeedItem {
  id: number;
  agent_id: number;
  operator: string;
  puzzle_idx: number;
  prompt: string;
  answer: string;
  verdict: Verdict;
  source: string;
  provider: string;
  model: string;
  chat_id: string;
  verified: boolean | null;
  latency_ms: number;
  created_at: string | number | null;
  agentName?: string;
}

export interface AgentRecord {
  agent_id: number;
  owner: string;
  name: string;
}

export interface ClaimInfo {
  eligible: boolean;
  amount: string;
  leaf_index: number;
  proof: string[];
  rank: number;
  claimed: boolean;
}

// WebSocket message envelopes.
export interface WsSolvePayload {
  agentId: number;
  agentName: string;
  operator: string;
  puzzleIdx: number;
  prompt: string;
  answer: string;
  verdict: Verdict;
  source: string;
  provider: string;
  model: string;
  chatID: string;
  verified: boolean | null;
  latencyMs: number;
}

export interface WsStandingPayload {
  agentId: number;
  agentName: string;
  operator: string;
  correct: number;
  totalLatencyMs: number;
  rank: number;
}

export interface WsStatusPayload {
  status: string;
  detail?: string;
}

export interface WsSettledPayload {
  root: string;
  payouts: { operator: string; amount: string; rank: number }[];
}

export type WsMessage =
  | { type: "solve"; contestId: number; payload: WsSolvePayload }
  | { type: "standings"; contestId: number; payload: WsStandingPayload[] }
  | { type: "status"; contestId: number; payload: WsStatusPayload }
  | { type: "settled"; contestId: number; payload: WsSettledPayload };
