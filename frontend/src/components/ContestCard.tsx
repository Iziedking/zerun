import Link from "next/link";
import type { ContestSummary } from "@/lib/types";
import { formatUsdc } from "@/lib/format";
import { kindMeta } from "@/lib/kind";
import { ContestStatusPill } from "./ContestStatusPill";
import { Chip, PopButton, StickerCard } from "./zerun";

// A contest at a glance: which flavor it is, the amber prize pool, its status, and
// a one-tap way in. The whole card links to the contest; the Enter button is a
// visual affordance inside that link.
export function ContestCard({ contest }: { contest: ContestSummary }) {
  const meta = kindMeta(contest.kind);
  const s = (contest.status || "").toLowerCase();
  const live = s === "running" || s === "active";

  return (
    <Link href={`/contest/${contest.contest_id}`} className="block">
      <StickerCard interactive className="flex h-full flex-col p-6">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-lg text-ink">
            Contest #{contest.contest_id}
          </span>
          <ContestStatusPill status={contest.status} />
        </div>

        <div className="mt-3">
          <Chip tone={meta.tone}>{meta.label}</Chip>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <span
            aria-hidden
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-line border-ink bg-amber shadow-pop-press"
          >
            <svg width="20" height="20" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="5.5" stroke="#171449" strokeWidth="2.2" />
              <path
                d="M9 5.5v7M6.6 7.2h3.2a1.4 1.4 0 0 1 0 2.8H7"
                stroke="#171449"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="font-display text-4xl leading-none text-ink">
              {formatUsdc(contest.prize_pool)}
              <span className="ml-1.5 text-base font-body font-extrabold text-ink-2">
                tUSDC
              </span>
            </div>
            <div className="mt-0.5 font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
              prize pool, split among the top finishers
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t-line border-ink/15 pt-4">
          <span className="rounded-pill border-line border-ink bg-cloud-2 px-3 py-1 font-body text-[13px] font-extrabold text-ink">
            {contest.agent_count} agents
          </span>
          <span className="rounded-pill border-line border-ink bg-cloud-2 px-3 py-1 font-body text-[13px] font-extrabold text-ink">
            {contest.puzzle_count} {meta.taskWords}
          </span>
        </div>

        <div className="mt-5 pt-1">
          <PopButton type="button" className="w-full" tabIndex={-1}>
            {live ? "Watch live" : "Enter"}
          </PopButton>
        </div>
      </StickerCard>
    </Link>
  );
}
