"use client";

import { useComputeStatus } from "@/lib/useDeployment";
import { Chip, type ChipTone } from "./zerun/Chip";

const LABELS: Record<string, string> = {
  "0g-compute": "0G Compute: live",
  "0g-router": "0G Router: live",
  "offline-dev": "0G Compute: offline-dev",
};

// Live compute indicator sourced from /api/compute/status, shown as a Chip:
// mint and pulsing when 0G Compute is live, neutral otherwise.
export function ComputeBadge({ className = "" }: { className?: string }) {
  const { data, isLoading, isError } = useComputeStatus();

  const live = data?.mode === "0g-compute" || data?.mode === "0g-router";
  const label = isError
    ? "0G Compute: unreachable"
    : isLoading
      ? "0G Compute: …"
      : LABELS[data?.mode ?? ""] ?? "0G Compute: unknown";

  const tone: ChipTone = live ? "live" : "neutral";

  return (
    <span className={className}>
      <Chip tone={tone} pulse={live}>
        {label}
      </Chip>
    </span>
  );
}
