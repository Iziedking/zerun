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
    // null until the memory market is deployed.
    memoryEscrow?: Address | null;
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

// A contest flavor. Solver agents work numeric puzzles; analyst agents forecast
// prediction markets with a Yes/No call; poker is a heads-up or multi-way duel on
// 0G Compute; worldcup is a prediction mission on live World Cup events that settles
// later, once the real events resolve.
export type ContestKind = "solver" | "analyst" | "poker" | "worldcup" | "chess";

// The lifecycle phase the backend reports for a contest. We keep it a widened
// string for forward-compatibility but lean on this union for the known states.
// "awaiting_resolution" is a World Cup mission waiting on the real results.
export type ContestStatus =
  | "open"
  | "pending"
  | "running"
  | "awaiting_resolution"
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
  prize_pool: string; // USDC 6dp string (host-staked pool; '0' for a pure challenge)
  // Entry-fee challenge: the per-entrant fee and the collected pot so far, 6dp
  // strings. entry_fee '0' means a funded contest; > '0' means a challenge.
  entry_fee?: string;
  fee_pool?: string;
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
  // The value that decides the winner (poker chips, World Cup P&L, or correct answers)
  // and its label, so the standings show the deciding number, live.
  score?: number;
  metric?: string;
}

export interface ContestDetail {
  contest: ContestSummary;
  standings: Standing[];
}

// "action" is a poker betting move and "move" a chess move: no right/wrong, just a play.
export type Verdict = "correct" | "wrong" | "error" | "action" | "forecast" | "move";

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

// An agent's retrieved-context memory: a 0G-authored self-summary it carries across
// contests, its graded tendencies, and the 0G Storage anchor that proves it was produced
// on 0G. `enabled` reflects the backend AGENT_MEMORY flag.
export interface AgentMemoryTendencies {
  // "general" (solver + analyst): a graded correct/wrong record.
  graded: number;
  correct: number;
  wrong: number;
  accuracy: number | null;
  byKind: Record<string, { correct: number; wrong: number }>;
  recentForm: string; // "WWLWL", newest first
  // "poker" and "chess": a move is never right or wrong, so these kinds carry their own
  // outcomes instead of a graded record. `plays` is the sample size for both.
  plays?: number;
  wins?: number;
  rating?: number | null; // poker: conservative TrueSkill (mu - 3*sigma)
  avgPlace?: number | null; // chess: mean bracket finish, 1 is the championship
  best?: number | null; // chess: best finish so far
}

export interface AgentMemory {
  summary: string;
  tendencies: AgentMemoryTendencies;
  contests: number;
  model: string | null;
  chatId: string | null;
  storageRoot: string | null;
  updatedAt: string | null;
}

// Which memory: "general" is Solver + Analyst (free); poker and chess are paid.
export type MemoryKind = "general" | "poker" | "chess";

export interface AgentMemoryResponse {
  enabled: boolean;
  kind: MemoryKind;
  paid: boolean;
  memory: AgentMemory | null;
}

// An agent's address and its non-custodial memory balance. The address is identity, not
// custody: it never holds value, and the backend derives it from a public key it cannot
// sign with. The 0G lives in MemoryEscrow, where only the owner can withdraw.
export interface AgentWallet {
  agentId: number;
  address: string | null;
  escrow: string | null;
  market: boolean; // false when MemoryEscrow is not deployed yet
  pricePerCallWei: string;
  callsRemaining: number;
  balanceWei: string;
  allowanceWei: string;
  spentWei: string;
  unsettledWei: string;
}

// A verified X (Twitter) identity linked to an operator wallet, for the profile badge.
export interface XIdentity {
  handle: string;
  name: string | null;
  verifiedAt: string;
}

// One agent's row on the poker TrueSkill season ladder. `rating` is the conservative
// score (mu - 3*sigma) the ladder ranks by; a high rating needs both skill and games.
export interface PokerLadderRow {
  agentId: number;
  agentName: string;
  operator: string | null;
  isHouse: boolean;
  computeLevel: number;
  mu: number;
  sigma: number;
  rating: number;
  games: number;
  wins: number;
}

// One agent's row on the community chess competition ladder. `rating` is the conservative
// TrueSkill score (mu - 3*sigma). `kind` is 'upload' (a player's submitted agent) or 'engine'
// (a house benchmark that fills the board before uploads open); `tier` is set for engines only.
export interface ChessLadderRow {
  agentId: number;
  agentName: string;
  owner: string | null;
  kind: string;
  tier: number | null;
  modelDriven: boolean;
  mu: number;
  sigma: number;
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  qualified: boolean;
}

// The minimum an uploaded agent must reach to make the prize board: rated games played and a
// conservative rating floor. Uploading new code resets both, so the climb starts over.
export interface ChessQualify {
  minGames: number;
  minRating: number;
}

// One position from the entry check: the sandbox played the submitted agent on it and this is the
// move it chose. Shown back to the player as proof their agent really moved.
export interface ChessSmokeMove {
  position: string;
  uci: string | null;
  ms: number;
}

// The result of a successful submission. `resubmitted` means an existing entry was replaced;
// `storageRoot` is the 0G Storage anchor of the exact file, when storage is on.
export interface ChessSubmitResult {
  agentId: number;
  name: string;
  resubmitted: boolean;
  storageRoot: string | null;
  smoke: ChessSmokeMove[];
}

// A wallet's own competition entry, with its live standing.
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

// `open` is whether submissions are being accepted at all; `agent` is null until the wallet enters.
export interface MyChessAgentResponse {
  open: boolean;
  agent: MyChessAgent | null;
}

// One move in a watchable ladder game: the position AFTER the move, so the board can be drawn
// straight from `fen` at any point.
export interface ChessLiveMove {
  ply: number;
  uci: string;
  fen: string;
  mover: "w" | "b";
}

// A watchable ladder game, live or finished. `status` is "playing" while in progress; when "done",
// `winner` is the winning agent's name or null for a draw, and `how` is checkmate/adjudicated/etc.
export interface ChessLiveGame {
  whiteId: number;
  blackId: number;
  white: string;
  black: string;
  whiteKind: string; // 'upload' | 'showcase' | 'house'
  blackKind: string;
  startedAt: number;
  moves: ChessLiveMove[];
  status: "playing" | "done";
  winner: string | null;
  how: string | null;
  fen: string;
}

// One 0G Compute model's aggregated performance, for the model studies page.
// `accuracy` is over graded answers only (Solver/Analyst); null when a model has
// answered but never on a graded contest.
export interface ModelStat {
  model: string;
  answers: number;
  gradedAnswers: number;
  correct: number;
  wrong: number;
  errors: number;
  accuracy: number | null;
  verified: number;
  verifiedRate: number;
  contests: number;
  agents: number;
  avgLatencyMs: number;
  // Contest wins where the rank-1 agent used this model, and the win rate over the
  // settled contests the model competed in (null when it has none settled yet).
  wins: number;
  settledContests: number;
  winRate: number | null;
  // Accuracy split by contest flavor (only graded kinds: solver, analyst).
  byKind: { kind: string; correct: number; wrong: number; accuracy: number | null }[];
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
  // Cancelled challenges this operator entered: candidates for an entry-fee refund.
  refunds?: number[];
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
  score?: number;
  metric?: string;
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
  opponentName?: string; // poker: the scouted opponent
  label?: string; // generic: what the payment bought (e.g. "intel: Spain")
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
  /** Chips this seat has in front of it on the CURRENT street. Rendered on the felt. */
  bet: number;
  /** Chips this seat has put in across the whole hand. */
  committed: number;
  /** Chips still owed to call. 0 when the action is square. */
  toCall: number;
  /** "BTN" | "SB" | "BB" | "UTG" | "HJ" | "CO". */
  position: string;
}

export interface WsPokerSnapshot {
  handIndex: number;
  street: string;
  board: string[];
  pot: number;
  seats: WsPokerSeat[];
  lastAction?: { agentId: number; name: string; action: string; reasoning: string; chatID: string | null };
}

// Which tournament match a chess move belongs to (absent for a heads-up duel).
export interface WsChessMatchInfo {
  round: number;
  index: number;
  label: string;
  totalRounds: number;
}

export interface WsChessSnapshot {
  fen: string;
  ply: number;
  lastMove: string;
  lastFrom: string;
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
  match?: WsChessMatchInfo | null;
}

// One seat in a chess tournament bracket.
export interface WsBracketSeat {
  agentId: number;
  agentName: string;
  operator: string;
  isHouse: boolean;
  tier: number;
  seed: number;
}

// One match node in the bracket (seats referred to by agentId).
export interface WsBracketMatch {
  round: number;
  index: number;
  a: number | null;
  b: number | null;
  winner: number | null;
  live: boolean;
}

// The whole single-elimination bracket, from lobby through completion.
export interface WsBracketSnapshot {
  contestId: number;
  status: "lobby" | "playing" | "complete";
  size: number;
  capacity: number;
  filled: number;
  rounds: WsBracketMatch[][];
  seats: WsBracketSeat[];
  currentMatch: { round: number; index: number; label: string } | null;
  champion: number | null;
  placements: { agentId: number; place: number }[];
}

export type WsMessage =
  | { type: "solve"; contestId: number; payload: WsSolvePayload }
  | { type: "standings"; contestId: number; payload: WsStandingPayload[] }
  | { type: "status"; contestId: number; payload: WsStatusPayload }
  | { type: "settled"; contestId: number; payload: WsSettledPayload }
  | { type: "x402"; contestId: number; payload: WsX402Payload }
  | { type: "poker"; contestId: number; payload: WsPokerSnapshot }
  | { type: "chess"; contestId: number; payload: WsChessSnapshot }
  | { type: "bracket"; contestId: number; payload: WsBracketSnapshot };

// A verified X handle resolved to the wallet it is bound to. The binding is one-to-one, so
// this is an address you can send to rather than a guess.
export interface XResolved {
  wallet: string;
  handle: string;
  name: string | null;
  avatar: string | null;
}

// The Zero Cup vote-gas faucet: a whisper of real mainnet 0G so a voter can boost, once.
export interface VoteGasStatus {
  enabled: boolean;
  amountOg: string;
  claimed: boolean;
  txHash: string | null;
  remainingClaims: number;
  /** This wallet has already voted and can never vote again. */
  alreadyVoted: boolean;
  /** This wallet already holds enough mainnet gas to boost, so it needs no credit. */
  hasEnoughGas: boolean;
  /** The wallet's mainnet 0G balance. "0" when unknown. */
  balanceOg: string;
}
