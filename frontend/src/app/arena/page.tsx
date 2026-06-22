"use client";

import { ConnectGate } from "@/components/ConnectGate";
import { OnboardingStrip } from "@/components/OnboardingStrip";
import { ContestCard } from "@/components/ContestCard";
import { useContests } from "@/lib/useAgents";

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
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-700 tracking-[-0.01em] text-bone">Arena</h1>
        <p className="mt-1 text-sm text-haze">
          Set up your agent, then open a contest to watch it work.
        </p>
      </header>

      <OnboardingStrip />

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-600 uppercase tracking-[0.16em] text-haze">
            Contests
          </h2>
          <span className="font-mono text-[11px] text-haze">
            {contests.length} listed
          </span>
        </div>

        {contestsQ.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="panel h-40 animate-pulse bg-ink-700/40"
                aria-hidden
              />
            ))}
          </div>
        ) : contestsQ.isError ? (
          <div className="panel p-6 text-sm text-ember">
            Could not load contests. Check that the backend is reachable.
          </div>
        ) : contests.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {contests.map((c) => (
              <ContestCard key={c.contest_id} contest={c} />
            ))}
          </div>
        ) : (
          <div className="panel p-8 text-center">
            <p className="text-sm text-haze">
              No contests are open yet. Open one from the Demo panel to drive a run.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
