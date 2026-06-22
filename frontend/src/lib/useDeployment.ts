"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Deployment } from "./types";

// Contract addresses are fetched at runtime, never hardcoded.
export function useDeployment() {
  return useQuery<Deployment>({
    queryKey: ["deployment"],
    queryFn: () => api.deployment(),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useComputeStatus() {
  return useQuery({
    queryKey: ["compute-status"],
    queryFn: () => api.computeStatus(),
    staleTime: 30_000,
    retry: 1,
  });
}
