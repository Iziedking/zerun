import { API_URL } from "./config";
import type {
  AgentRecord,
  ArenaStats,
  ClaimInfo,
  ComputeStatus,
  ContestDetail,
  ContestKind,
  ContestSummary,
  Deployment,
  FeedItem,
  LeaderboardRow,
  OperatorProfile,
  RecentFeedItem,
  Standing,
} from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

export const api = {
  deployment: () => req<Deployment>("/api/deployment"),
  computeStatus: () => req<ComputeStatus>("/api/compute/status"),
  stats: () => req<ArenaStats>("/api/stats"),
  contests: () => req<{ contests: ContestSummary[] }>("/api/contests"),
  contest: (id: number | string) => req<ContestDetail>(`/api/contests/${id}`),
  feed: (id: number | string, since = 0) =>
    req<{ feed: FeedItem[] }>(`/api/contests/${id}/feed?since=${since}`),
  standings: (id: number | string) =>
    req<{ standings: Standing[] }>(`/api/contests/${id}/standings`),

  recentFeed: (limit = 12) =>
    req<{ feed: RecentFeedItem[] }>(`/api/feed/recent?limit=${limit}`),
  leaderboard: () => req<{ leaderboard: LeaderboardRow[] }>("/api/leaderboard"),
  operator: (address: string) =>
    req<OperatorProfile>(`/api/operators/${address}`),

  agents: (owner: string) =>
    req<{ agents: AgentRecord[] }>(`/api/agents?owner=${owner}`),
  registerAgent: (body: { agentId: number; owner: string; name: string }) =>
    req<unknown>("/api/agents", { method: "POST", body: JSON.stringify(body) }),

  // An operator hosted a contest from their own wallet; mirror it in the arena.
  hostContest: (body: {
    contestId: number;
    kind: ContestKind;
    puzzleCount: number;
    maxOperators?: number;
  }) =>
    req<{ ok: boolean; contestId: number; kind: ContestKind }>("/api/contests/host", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Upload a custom skin for an agent (base64 with the data: prefix stripped).
  uploadSkin: (
    id: number | string,
    body: { owner: string; mime: string; dataB64: string },
  ) =>
    req<{ ok: boolean; skinRoot: string | null }>(`/api/agents/${id}/skin`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  enter: (id: number | string, body: { agentId: number; operator: string }) =>
    req<unknown>(`/api/contests/${id}/enter`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // How much of the weekly tUSDC faucet the operator has left.
  faucetStatus: (owner: string) =>
    req<{ claimedWei?: string; remainingWei: string; capped: boolean }>(
      `/api/faucet/usdc?owner=${owner}`,
    ),
  // Claim tUSDC from the capped faucet (100 per operator per 7 days).
  faucetUsdc: (body: { owner: string }) =>
    req<{ ok: boolean; minted: string; txHash: string }>("/api/faucet/usdc", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Where training 0G goes, and the 0G cost ladder per compute level.
  computeInfo: () =>
    req<{ coordinator: string; costsOg: number[]; maxLevel: number }>("/api/compute/info"),
  // Credit a compute level after the owner paid 0G to the coordinator.
  trainAgent: (id: number | string, body: { owner: string; txHash: string }) =>
    req<{ ok: boolean; computeLevel: number }>(`/api/agents/${id}/train`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  claim: (id: number | string, operator: string) =>
    req<ClaimInfo>(`/api/contests/${id}/claim?operator=${operator}`),
  claimed: (id: number | string, body: { operator: string }) =>
    req<unknown>(`/api/contests/${id}/claimed`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  adminOpen: (body: {
    prizePoolUsdc: string;
    durationSecs: number;
    topN: number;
    puzzleCount: number;
  }) =>
    req<{ contestId: number }>("/api/admin/contests/open", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  adminRun: (id: number | string) =>
    req<unknown>(`/api/admin/contests/${id}/run`, { method: "POST" }),

  // Support tools, gated by the admin token (sent as a header).
  adminCheck: (token: string) =>
    req<{ ok: boolean }>("/api/admin/check", { headers: { "x-admin-token": token } }),
  adminAgent: (id: number, token: string) =>
    req<{
      agent: {
        agent_id: number;
        owner: string;
        name: string;
        compute_level: number;
        is_house: boolean;
      };
      trainings: { tx_hash: string; amount_wei: string; level_after: number; created_at: string }[];
    }>(`/api/admin/agent/${id}`, { headers: { "x-admin-token": token } }),
  adminCreditTraining: (body: { agentId: number; txHash: string }, token: string) =>
    req<{ ok: boolean; computeLevel: number; owner: string }>("/api/admin/credit-training", {
      method: "POST",
      headers: { "x-admin-token": token },
      body: JSON.stringify(body),
    }),
  adminSetCompute: (body: { agentId: number; level: number }, token: string) =>
    req<{ ok: boolean; computeLevel: number }>("/api/admin/set-compute", {
      method: "POST",
      headers: { "x-admin-token": token },
      body: JSON.stringify(body),
    }),
  adminOperator: (address: string, token: string) =>
    req<{
      owner: string;
      usdcWei: string;
      usdcClaimedThisWeekWei: string;
      agents: { agent_id: number; name: string; compute_level: number; is_house: boolean }[];
      contests: { contest_id: number; status: string; kind: string }[];
    }>(`/api/admin/operator/${address}`, { headers: { "x-admin-token": token } }),
  adminGrantUsdc: (body: { owner: string; amount: number }, token: string) =>
    req<{ ok: boolean; mintedWei: string; txHash: string }>("/api/admin/grant-usdc", {
      method: "POST",
      headers: { "x-admin-token": token },
      body: JSON.stringify(body),
    }),
  adminContest: (id: number, token: string) =>
    req<{
      contest: { contest_id: number; status: string; kind: string; prize_pool: string };
      dbEntries: number;
      onchainEntries: number;
    }>(`/api/admin/contest/${id}`, { headers: { "x-admin-token": token } }),
  adminResettle: (id: number, token: string) =>
    req<{ ok: boolean }>(`/api/admin/contest/${id}/resettle`, {
      method: "POST",
      headers: { "x-admin-token": token },
    }),
  adminCancelContest: (id: number, token: string) =>
    req<{ ok: boolean }>(`/api/admin/contest/${id}/cancel`, {
      method: "POST",
      headers: { "x-admin-token": token },
    }),
  adminRepairClaims: (id: number, credit: boolean, token: string) =>
    req<{
      ok: boolean;
      note?: string;
      dryRun?: boolean;
      chainRoot?: string;
      dbRoot?: string;
      results?: { operator: string; amountWei: string; action: string; tx?: string }[];
    }>(`/api/admin/contest/${id}/repair-claims${credit ? "?credit=true" : ""}`, {
      method: "POST",
      headers: { "x-admin-token": token },
    }),
};
