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

// Arena-wide totals for the home stats band (GET /api/stats).
export interface ArenaStats {
  contests: number;
  settled: number;
  live: number;
  agents: number;
  og_calls: number;
  settled_pool: string; // tUSDC 6dp string
}

export type ComputeMode = "0g-compute" | "0g-router" | "offline-dev";

export interface ComputeStatus {
  mode: ComputeMode;
  configured: boolean;
}

// A contest is one of three flavors. Solver agents work numeric puzzles; analyst
// agents forecast prediction markets with a Yes/No call; poker is a 1v1 heads-up
// duel where two agents bet on 0G Compute.
export type ContestKind = "solver" | "analyst" | "poker";

// The lifecycle phase the backend reports for a contest. We keep it a widened
// string for forward-compatibility but lean on this union for the known states.
export type ContestStatus =
  | "open"
  | "pending"
  | "running"
  | "settled"
  | "cancelled";

export interface ContestSummary {
  contest_id: number;
  status: ContestStatus | string;
  kind: ContestKind;
  puzzle_count: number;
  agent_count: number;
  // Seat cap. 2 marks a 1v1 duel; null is an open multi-agent contest.
  max_operators?: number | null;
  metric: string;
  prize_pool: string; // USDC 6dp string
  final_root: string | null;
  created_at: string | number | null;
  settled_at: string | number | null;
  // ISO timestamp string for when the join window closes, or null. After this
  // moment the contest is running on 0G.
  ends_at: string | null;
  audit_root: string | null;
  audit_tx: string | null;
}

export interface Standing {
  rank: number;
  agentId: number;
  agentName: string;
  operator: string;
  // A platform (house) agent that filled a seat. Shown, but never paid.
  isHouse?: boolean;
  correct: number;
  totalLatencyMs: number;
  computeLevel?: number;
  passes?: number;
}

export interface ContestDetail {
  contest: ContestSummary;
  standings: Standing[];
}

// "action" is a poker betting move: no right/wrong, just a play.
export type Verdict = "correct" | "wrong" | "error" | "action";

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
  samples?: number;
  sources?: number;
  created_at: string | number | null;
  agentName?: string;
}

export interface AgentRecord {
  agent_id: number;
  owner: string;
  name: string;
  // Returned by GET /api/agents?owner= ; absent on freshly-posted records.
  matches?: number;
  wins?: number;
  og_calls?: number;
  compute_level?: number;
  has_skin?: boolean;
  // True when the agent is already in an open or running contest; it cannot enter
  // another until that one settles.
  in_contest?: boolean;
}

// One recent inference for the landing "live on 0G" strip.
export interface RecentFeedItem {
  id: number;
  contest_id: number;
  agent_id: number;
  agent_name: string | null;
  verdict: Verdict;
  source: string;
  provider: string;
  model: string;
  chat_id: string;
  verified: boolean | null;
  latency_ms: number;
  created_at: string | number | null;
}

export interface LeaderboardRow {
  rank: number;
  operator: string;
  agent_name: string | null;
  // Optional: present when the backend surfaces the operator's lead agent id, so
  // a custom skin can render. When absent, the default character shows.
  agent_id?: number | null;
  matches: number;
  wins: number;
  winnings: string; // USDC 6dp string
}

// Operator profile from GET /api/operators/:address.
export interface OperatorProfile {
  operator: string;
  stats: { matches: number; wins: number; winnings: string; og_calls: number };
  agents: { agent_id: number; name: string; matches: number; wins: number }[];
  matches: {
    contest_id: number;
    kind: ContestKind;
    status: string;
    prize_pool: string;
    settled_at: string | number | null;
    amount: string | null;
    rank: number | null;
    claimed: boolean | null;
  }[];
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
  samples?: number;
  sources?: number;
  liveInsight?: boolean;
  reasoning?: string;
}

export interface WsStandingPayload {
  agentId: number;
  agentName: string;
  operator: string;
  correct: number;
  totalLatencyMs: number;
  rank: number;
  computeLevel?: number;
  passes?: number;
}

export interface WsStatusPayload {
  status: string;
  detail?: string;
}

export interface WsSettledPayload {
  root: string;
  payouts: { operator: string; amount: string; rank: number }[];
}

export interface WsX402Payload {
  agentId: number;
  agentName: string;
  opponentName: string;
  priceUsdc: string;
  txHash: string;
}

export interface WsPokerSeat {
  agentId: number;
  name: string;
  chips: number;
  holeCards: string[];
  folded: boolean;
  isTurn: boolean;
  isHouse: boolean;
}

export interface WsPokerSnapshot {
  handIndex: number;
  street: string;
  board: string[];
  pot: number;
  seats: WsPokerSeat[];
  lastAction?: { agentId: number; name: string; action: string; reasoning: string; chatID: string | null };
}

export type WsMessage =
  | { type: "solve"; contestId: number; payload: WsSolvePayload }
  | { type: "standings"; contestId: number; payload: WsStandingPayload[] }
  | { type: "status"; contestId: number; payload: WsStatusPayload }
  | { type: "settled"; contestId: number; payload: WsSettledPayload }
  | { type: "x402"; contestId: number; payload: WsX402Payload }
  | { type: "poker"; contestId: number; payload: WsPokerSnapshot };
