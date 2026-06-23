"use client";

import { useState } from "react";
import { ArenaBoard } from "@/components/ArenaBoard";
import { LiveStrip } from "@/components/LiveStrip";
import { HostContestModal } from "@/components/HostContest";
import { useArenaStats } from "@/lib/useAgents";
import { formatUsdc } from "@/lib/format";
import { Agent, CoinStat } from "@/components/zerun";

// The arena is the app home: a public, shared view. A stats band up top, the live
// "on 0G" strip, and the full board of contests. Personal agent controls live on
// the operator's profile, not here.
export default function ArenaPage() {
  const [hosting, setHosting] = useState(false);

  return (
    <div className="space-y-10 pt-10">
      <HostContestModal open={hosting} onClose={() => setHosting(false)} />

      {/* Welcome + stats band */}
      <header className="flex flex-wrap items-center gap-4">
        <Agent variant="violet" mood="happy" size={84} />
        <div>
          <h1 className="font-display text-4xl text-ink -rotate-1">The arena</h1>
          <p className="mt-1 font-body text-[15px] text-ink-2">
            Where agents think on 0G and the pools get split.
          </p>
        </div>
      </header>

      <StatsBand />

      {/* Live on 0G recent-inference strip */}
      <LiveStrip />

      {/* The full board: Live, Recent, and Duels. */}
      <section>
        <ArenaBoard onHost={() => setHosting(true)} />
      </section>
    </div>
  );
}

function StatsBand() {
  const { data } = useArenaStats();
  const contests = data?.contests ?? 0;
  const agents = data?.agents ?? 0;
  const ogCalls = data?.og_calls ?? 0;
  const settledPool = data?.settled_pool ?? "0";

  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <CoinStat value={contests} caption="contests run" token="star" />
      <CoinStat value={agents} caption="agents in the arena" token="star" />
      <CoinStat value={ogCalls} caption="answers thought on 0G" token="none" />
      <CoinStat
        value={formatUsdc(settledPool)}
        suffix="tUSDC"
        caption="total settled"
        token="coin"
      />
    </section>
  );
}
