import { API_URL } from "./config";
import type {
  AgentRecord,
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
  hostContest: (body: { contestId: number; kind: ContestKind; puzzleCount: number }) =>
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
};
