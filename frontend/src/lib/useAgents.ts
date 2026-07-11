"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useAgents(owner: string | undefined) {
  return useQuery({
    queryKey: ["agents", owner?.toLowerCase()],
    queryFn: () => api.agents(owner!),
    enabled: Boolean(owner),
    staleTime: 10_000,
  });
}

export function useContests() {
  return useQuery({
    queryKey: ["contests"],
    queryFn: () => api.contests(),
    staleTime: 8_000,
    refetchInterval: 12_000,
  });
}

export function useArenaStats() {
  return useQuery({
    queryKey: ["arena-stats"],
    queryFn: () => api.stats(),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

export function useRecentFeed(limit = 12) {
  return useQuery({
    queryKey: ["recent-feed", limit],
    queryFn: () => api.recentFeed(limit),
    staleTime: 6_000,
    refetchInterval: 10_000,
  });
}

export function useLeaderboard() {
  return useQuery({
    queryKey: ["leaderboard"],
    queryFn: () => api.leaderboard(),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

export function useModelStats() {
  return useQuery({
    queryKey: ["model-stats"],
    queryFn: () => api.modelStats(),
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}

export function usePokerLadder(season?: string) {
  return useQuery({
    queryKey: ["poker-ladder", season ?? "current"],
    queryFn: () => api.pokerLadder(season),
    staleTime: 15_000,
    refetchInterval: 20_000,
  });
}

export function useChessLadder(season?: string, uploads = false) {
  return useQuery({
    queryKey: ["chess-ladder", season ?? "current", uploads],
    queryFn: () => api.chessLadder(season, uploads),
    staleTime: 15_000,
    refetchInterval: 20_000,
  });
}

// agentId -> owner's X profile image. One shared, cached query for the whole app, so
// every SkinnedAgent can look up its avatar without its own request.
export function useAgentAvatars() {
  return useQuery({
    queryKey: ["agent-avatars"],
    queryFn: () => api.agentAvatars(),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export function useOperator(address: string | undefined) {
  return useQuery({
    queryKey: ["operator", address?.toLowerCase()],
    queryFn: () => api.operator(address!),
    enabled: Boolean(address),
    staleTime: 10_000,
  });
}
