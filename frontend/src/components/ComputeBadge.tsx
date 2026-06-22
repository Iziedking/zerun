"use client";

import { useComputeStatus } from "@/lib/useDeployment";
import { StatusDot } from "./ui";

const LABELS: Record<string, string> = {
  "0g-compute": "0G Compute: live",
  "0g-router": "0G Router: live",
  "offline-dev": "Compute: offline-dev",
};

// Small live indicator sourced from /api/compute/status.
export function ComputeBadge({ className = "" }: { className?: string }) {
  const { data, isLoading, isError } = useComputeStatus();

  const live = data?.mode === "0g-compute" || data?.mode === "0g-router";
  const label = isError
    ? "Compute: unreachable"
    : isLoading
      ? "Compute: …"
      : LABELS[data?.mode ?? ""] ?? "Compute: unknown";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border border-edge/70 bg-ink-700/70 px-3 py-1 text-[11px] font-500 ${
        live ? "text-signal" : "text-haze"
      } ${className}`}
    >
      <StatusDot live={live} />
      {label}
    </span>
  );
}
