"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { kindMeta } from "@/lib/kind";
import { ContestStatusPill } from "@/components/ContestStatusPill";
import { Chip } from "@/components/zerun";
import { ContestLive } from "@/components/ContestLive";
import { EnterContest } from "@/components/EnterContest";
import { ClaimPrize } from "@/components/ClaimPrize";
import { AuditTrail } from "@/components/AuditTrail";
import { StatChip } from "@/components/ui";
import { StickerCard } from "@/components/zerun";

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
    return <p className="pt-16 font-body text-[15px] font-bold text-coral">Invalid contest id.</p>;
  }

  if (detailQ.isLoading) {
    return (
      <div className="pt-10">
        <div
          className="h-32 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2"
          aria-hidden
        />
      </div>
    );
  }

  if (detailQ.isError || !detailQ.data) {
    return (
      <div className="pt-16">
        <StickerCard className="p-6">
          <p className="font-body text-[15px] font-bold text-ink">
            Could not load this contest. It may not exist, or the backend is unreachable.
          </p>
        </StickerCard>
        <Link href="/arena" className="mt-4 inline-block font-body text-[14px] font-extrabold text-violet">
          ← back to the arena
        </Link>
      </div>
    );
  }

  const { contest, standings } = detailQ.data;
  const meta = kindMeta(contest.kind);

  return (
    <div className="space-y-8 pt-8">
      <Link
        href="/arena"
        className="inline-flex items-center gap-1 font-body text-[13px] font-extrabold uppercase tracking-[0.02em] text-ink-2 transition hover:text-ink"
      >
        ← arena
      </Link>

      {/* Header */}
      <StickerCard className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-display text-lg text-ink">
                Contest #{contest.contest_id}
              </span>
              <Chip tone={meta.tone}>{meta.label}</Chip>
              <ContestStatusPill status={contest.status} />
            </div>
            <p className="mt-1 font-body text-[14px] text-ink-2">{meta.blurb}</p>
            <div className="mt-3 font-display text-5xl leading-none text-ink">
              {formatUsdc(contest.prize_pool)}
              <span className="ml-2 font-body text-lg font-extrabold text-ink-2">
                tUSDC prize pool
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            <StatChip label={meta.taskWords} value={contest.puzzle_count} mono />
            <StatChip label="agents" value={contest.agent_count} mono />
            <StatChip label="metric" value={contest.metric || "·"} mono />
            <StatChip
              label="root"
              value={contest.final_root ? `${contest.final_root.slice(0, 10)}…` : "pending"}
              mono
            />
          </div>
        </div>

        <div className="mt-5 border-t-line border-ink/15 pt-5">
          {address ? (
            <div className="space-y-4">
              <EnterContest contestId={id} />
              <ClaimPrize contestId={id} />
            </div>
          ) : (
            <p className="font-body text-[15px] text-ink-2">
              Connect your wallet to enter this contest with an agent.
            </p>
          )}
        </div>
      </StickerCard>

      {/* Live */}
      <ContestLive
        contestId={id}
        initialStandings={standings}
        highlight={address ?? undefined}
        kind={contest.kind}
      />

      {contest.audit_root && <AuditTrail root={contest.audit_root} tx={contest.audit_tx} />}
    </div>
  );
}
