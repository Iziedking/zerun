"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

// A small, unobtrusive link shown on an agent card when it has verifiable inference receipts. It links
// to the newest batch's proof page, where anyone can inspect the receipts and check the Merkle root
// against the on-chain anchor. Renders nothing when the agent has no anchored batches yet.
export function ReceiptsLink({
  agentId,
  kind,
  className = "",
}: {
  agentId: number;
  kind: "arena" | "chess";
  className?: string;
}) {
  const { data } = useQuery({
    queryKey: ["receipts", kind, agentId],
    queryFn: () => api.agentReceipts(agentId, kind),
    staleTime: 60_000,
  });
  const batches = data?.batches ?? [];
  if (batches.length === 0) return null;
  const latest = batches[0]!;
  const total = batches.reduce((n, b) => n + b.leafCount, 0);

  return (
    <Link
      href={`/receipts/${latest.merkleRoot}`}
      title="Verify this agent's inference receipts on 0G"
      className={`inline-flex items-center gap-1 font-mono text-[11px] text-ink-3 underline decoration-ink-3/40 underline-offset-2 transition-colors hover:text-violet ${className}`}
    >
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-mint" />
      {total} inference proof{total === 1 ? "" : "s"} on 0G
    </Link>
  );
}
