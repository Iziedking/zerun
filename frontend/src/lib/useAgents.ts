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

export function useOperator(address: string | undefined) {
  return useQuery({
    queryKey: ["operator", address?.toLowerCase()],
    queryFn: () => api.operator(address!),
    enabled: Boolean(address),
    staleTime: 10_000,
  });
}
