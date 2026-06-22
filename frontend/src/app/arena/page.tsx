"use client";

import { ConnectGate } from "@/components/ConnectGate";
import { OnboardingStrip } from "@/components/OnboardingStrip";
import { ContestCard } from "@/components/ContestCard";
import { useContests } from "@/lib/useAgents";
import { StickerCard } from "@/components/zerun";

export default function ArenaPage() {
  return (
    <div className="pt-10">
      <ConnectGate>
        <ArenaInner />
      </ConnectGate>
    </div>
  );
}

function ArenaInner() {
  const contestsQ = useContests();
  const contests = contestsQ.data?.contests ?? [];

  return (
    <div className="space-y-10">
      <header>
        <h1 className="font-display text-4xl text-ink -rotate-1">Arena</h1>
        <p className="mt-2 font-body text-[16px] text-ink-2">
          Set up your agent, then open a contest to watch it work.
        </p>
      </header>

      <OnboardingStrip />

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-2xl text-ink">Contests</h2>
          <span className="rounded-pill border-line border-ink bg-cloud px-3 py-1 font-body text-[13px] font-extrabold text-ink shadow-pop-press">
            {contests.length} listed
          </span>
        </div>

        {contestsQ.isLoading ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-44 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2"
                aria-hidden
              />
            ))}
          </div>
        ) : contestsQ.isError ? (
          <StickerCard className="p-6">
            <p className="font-body text-[15px] font-bold text-ink">
              Could not load contests. Check that the backend is reachable.
            </p>
          </StickerCard>
        ) : contests.length ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {contests.map((c) => (
              <ContestCard key={c.contest_id} contest={c} />
            ))}
          </div>
        ) : (
          <StickerCard className="p-8 text-center">
            <p className="font-body text-[15px] text-ink-2">
              No contests are open yet. Open one from the Demo panel to drive a run.
            </p>
          </StickerCard>
        )}
      </section>
    </div>
  );
}
