"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { ContestStatusPill } from "@/components/ContestStatusPill";
import { ContestLive } from "@/components/ContestLive";
import { EnterContest } from "@/components/EnterContest";
import { ClaimPrize } from "@/components/ClaimPrize";
import { StatChip } from "@/components/ui";

export default function ContestPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { address } = useAccount();

  const detailQ = useQuery({
    queryKey: ["contest", String(id)],
    queryFn: () => api.contest(id),
    enabled: Number.isFinite(id),
    staleTime: 5_000,
  });

  if (!Number.isFinite(id)) {
    return <p className="pt-16 text-sm text-ember">Invalid contest id.</p>;
  }

  if (detailQ.isLoading) {
    return (
      <div className="pt-10">
        <div className="panel h-28 animate-pulse bg-ink-700/40" aria-hidden />
      </div>
    );
  }

  if (detailQ.isError || !detailQ.data) {
    return (
      <div className="pt-16">
        <div className="panel p-6 text-sm text-ember">
          Could not load this contest. It may not exist, or the backend is unreachable.
        </div>
        <Link href="/arena" className="mt-4 inline-block text-sm text-signal">
          ← back to the arena
        </Link>
      </div>
    );
  }

  const { contest, standings } = detailQ.data;

  return (
    <div className="space-y-8 pt-8">
      <Link
        href="/arena"
        className="inline-flex items-center gap-1 text-xs text-haze transition hover:text-chalk"
      >
        ← arena
      </Link>

      {/* Header */}
      <header className="panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm text-haze">contest #{contest.contest_id}</span>
              <ContestStatusPill status={contest.status} />
            </div>
            <div className="mt-3 font-mono text-4xl text-bone">
              {formatUsdc(contest.prize_pool)}
              <span className="ml-2 text-base text-haze">tUSDC prize pool</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            <StatChip label="puzzles" value={contest.puzzle_count} mono />
            <StatChip label="agents" value={contest.agent_count} mono />
            <StatChip label="metric" value={contest.metric || "—"} mono />
            <StatChip
              label="root"
              value={contest.final_root ? `${contest.final_root.slice(0, 10)}…` : "pending"}
              mono
            />
          </div>
        </div>

        <div className="mt-5 border-t border-edge/40 pt-4">
          {address ? (
            <div className="space-y-3">
              <EnterContest contestId={id} />
              <ClaimPrize contestId={id} />
            </div>
          ) : (
            <p className="text-sm text-haze">
              Connect your wallet to enter this contest with an agent.
            </p>
          )}
        </div>
      </header>

      {/* Live */}
      <ContestLive
        contestId={id}
        initialStandings={standings}
        highlight={address ?? undefined}
      />
    </div>
  );
}
