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
