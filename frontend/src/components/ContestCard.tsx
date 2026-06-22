import Link from "next/link";
import type { ContestSummary } from "@/lib/types";
import { formatUsdc } from "@/lib/format";
import { ContestStatusPill } from "./ContestStatusPill";
import { StickerCard } from "./zerun/StickerCard";

export function ContestCard({ contest }: { contest: ContestSummary }) {
  return (
    <Link href={`/contest/${contest.contest_id}`} className="block">
      <StickerCard interactive className="p-6">
        <div className="flex items-center justify-between">
          <span className="font-display text-lg text-ink">
            Contest #{contest.contest_id}
          </span>
          <ContestStatusPill status={contest.status} />
        </div>

        <div className="mt-5">
          <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
            prize pool
          </span>
          <div className="font-display text-4xl leading-none text-ink">
            {formatUsdc(contest.prize_pool)}
            <span className="ml-1.5 text-base font-body font-extrabold text-ink-2">
              tUSDC
            </span>
          </div>
        </div>

        <div className="mt-5 flex gap-3 border-t-line border-ink/15 pt-4">
          <span className="rounded-pill border-line border-ink bg-cloud-2 px-3 py-1 font-body text-[13px] font-extrabold text-ink">
            {contest.agent_count} agents
          </span>
          <span className="rounded-pill border-line border-ink bg-cloud-2 px-3 py-1 font-body text-[13px] font-extrabold text-ink">
            {contest.puzzle_count} puzzles
          </span>
        </div>
      </StickerCard>
    </Link>
  );
}
