"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { kindMeta } from "@/lib/kind";
import { contestPhase, secondsUntilClose, formatCountdown } from "@/lib/phase";
import { ContestStatusPill } from "@/components/ContestStatusPill";
import { Chip } from "@/components/zerun";
import { ContestLive } from "@/components/ContestLive";
import { EnterContest } from "@/components/EnterContest";
import { ClaimPrize } from "@/components/ClaimPrize";
import { AuditTrail } from "@/components/AuditTrail";
import { WinnerCard } from "@/components/WinnerCard";
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
    staleTime: 2_000,
    refetchInterval: 5_000,
  });

  // A 1s clock for the join-window countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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

  const phase = contestPhase(contest, now);
  const winner = standings[0];

  return (
    <div className="space-y-8 pt-8">
      <Link
        href="/arena"
        className="inline-flex items-center gap-1 font-body text-[13px] font-extrabold uppercase tracking-[0.02em] text-ink-2 transition hover:text-ink"
      >
        ← arena
      </Link>

      {phase === "settled" && winner && (
        <WinnerCard contestId={id} winner={winner} prizePool={contest.prize_pool} />
      )}

      {/* Header */}
      <StickerCard className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-display text-lg text-ink">
                Contest #{contest.contest_id}
              </span>
              <Chip tone={meta.tone}>{meta.label}</Chip>
              <ContestStatusPill status={contest.status} />
            </div>
            <p className="mt-1 font-body text-[14px] text-ink-2">{meta.blurb}</p>
            <div className="mt-3 font-display text-[clamp(36px,9vw,48px)] leading-none text-ink">
              {formatUsdc(contest.prize_pool)}
              <span className="ml-2 font-body text-lg font-extrabold text-ink-2">
                tUSDC prize pool
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:gap-x-8">
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

        <div className="mt-5 space-y-4 border-t-line border-ink/15 pt-5">
          {phase === "joining" && (
            <>
              <span className="inline-flex items-center gap-2 rounded-pill border-line border-ink bg-mint/20 px-3.5 py-1.5">
                <span className="h-2 w-2 rounded-full bg-mint motion-safe:animate-pulse" aria-hidden />
                <span className="font-body text-[13px] font-extrabold text-ink">
                  Join window closes in{" "}
                  <span className="font-mono">
                    {formatCountdown(secondsUntilClose(contest.ends_at, now) ?? 0)}
                  </span>
                </span>
              </span>
              {address ? (
                <EnterContest contestId={id} contest={contest} standings={standings} />
              ) : (
                <p className="font-body text-[15px] text-ink-2">
                  Connect your wallet to enter this contest with an agent.
                </p>
              )}
            </>
          )}

          {phase === "running" && (
            <span className="inline-flex items-center gap-2 rounded-pill border-line border-ink bg-violet/15 px-3.5 py-1.5">
              <span className="h-2 w-2 rounded-full bg-violet motion-safe:animate-pulse" aria-hidden />
              <span className="font-body text-[13px] font-extrabold text-ink">
                {contest.agent_count > 0
                  ? "Running on 0G, agents are answering in the feed below"
                  : "No agents joined, this contest will be cancelled shortly"}
              </span>
            </span>
          )}

          {phase === "settled" && address && <ClaimPrize contestId={id} />}

          {phase === "cancelled" && (
            <p className="font-body text-[14px] text-ink-2">
              This contest was cancelled and the sponsor was refunded, no agents joined in time.
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
