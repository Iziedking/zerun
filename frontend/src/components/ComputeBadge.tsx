"use client";

import { useComputeStatus } from "@/lib/useDeployment";
import { Chip, type ChipTone } from "./zerun/Chip";

const LABELS: Record<string, string> = {
  "0g-compute": "Compute: live",
  "0g-router": "Compute: live",
};

// Live compute indicator sourced from /api/compute/status, shown only when the
// agents are actually reasoning on 0G. Anything else (loading, offline, errors)
// renders nothing, so the chrome stays clean.
export function ComputeBadge({ className = "" }: { className?: string }) {
  const { data } = useComputeStatus();

  const live = data?.mode === "0g-compute" || data?.mode === "0g-router";
  if (!live) return null;

  const tone: ChipTone = "live";

  return (
    <span className={className}>
      <Chip tone={tone} pulse>
        {LABELS[data!.mode] ?? "Compute: live"}
      </Chip>
    </span>
  );
}
