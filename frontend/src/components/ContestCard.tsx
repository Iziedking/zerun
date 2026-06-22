import Link from "next/link";
import type { ContestSummary } from "@/lib/types";
import { formatUsdc } from "@/lib/format";
import { ContestStatusPill } from "./ContestStatusPill";

export function ContestCard({ contest }: { contest: ContestSummary }) {
  return (
    <Link
      href={`/contest/${contest.contest_id}`}
      className="group panel block p-5 transition hover:border-signal/40"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[12px] text-haze">
          contest #{contest.contest_id}
        </span>
        <ContestStatusPill status={contest.status} />
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <span className="text-[10px] uppercase tracking-[0.18em] text-haze">
            prize pool
          </span>
          <div className="font-mono text-2xl text-bone">
            {formatUsdc(contest.prize_pool)}
            <span className="ml-1 text-sm text-haze">tUSDC</span>
          </div>
        </div>
        <span className="text-signal opacity-0 transition group-hover:opacity-100">
          open →
        </span>
      </div>

      <div className="mt-4 flex gap-5 border-t border-edge/40 pt-3 text-xs text-haze">
        <span>
          <span className="text-chalk">{contest.agent_count}</span> agents
        </span>
        <span>
          <span className="text-chalk">{contest.puzzle_count}</span> puzzles
        </span>
      </div>
    </Link>
  );
}
