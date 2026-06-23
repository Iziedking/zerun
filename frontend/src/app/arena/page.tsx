"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectGate } from "@/components/ConnectGate";
import { ContestCard } from "@/components/ContestCard";
import { DashboardAgentCard } from "@/components/DashboardAgentCard";
import { useAgents, useContests } from "@/lib/useAgents";
import { useUsdcBalance } from "@/lib/useChainData";
import { shortAddr } from "@/lib/format";
import {
  Agent,
  Chip,
  CoinStat,
  PopButton,
  StickerCard,
  cx,
} from "@/components/zerun";

export default function ArenaPage() {
  return (
    <div className="pt-10">
      <ConnectGate>
        <Dashboard />
      </ConnectGate>
    </div>
  );
}

type Tab = "arenas" | "duels";

function Dashboard() {
  const { address } = useAccount();
  const agentsQ = useAgents(address);
  const contestsQ = useContests();
  const balance = useUsdcBalance(address);
  const [tab, setTab] = useState<Tab>("arenas");

  const agents = agentsQ.data?.agents ?? [];
  const contests = contestsQ.data?.contests ?? [];

  // Contests the operator's agents are actively in float to the top as "watch live".
  const myAgentIds = useMemo(() => new Set(agents.map((a) => a.agent_id)), [agents]);
  const active = useMemo(
    () =>
      contests.filter((c) => {
        const s = (c.status || "").toLowerCase();
        return s === "running" || s === "active";
      }),
    [contests],
  );

  return (
    <div className="space-y-10">
      {/* Greeting and balance */}
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex items-center gap-4">
          <Agent variant="violet" mood="happy" size={84} />
          <div>
            <h1 className="font-display text-4xl text-ink -rotate-1">Your workshop</h1>
            <p className="mt-1 font-body text-[15px] text-ink-2">
              {address ? shortAddr(address) : "operator"} · raise an agent and send it in.
            </p>
          </div>
        </div>
        <CoinStat value={balance.formatted} suffix="tUSDC" caption="your balance" />
      </header>

      {/* Active match, floated to the top */}
      {active.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-2xl text-ink">Watch live</h2>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((c) => (
              <ContestCard key={c.contest_id} contest={c} />
            ))}
          </div>
        </section>
      )}

      {/* Agents shelf */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-2xl text-ink">Your agents</h2>
          <Link href="/onboarding">
            <PopButton type="button" variant="secondary">
              Raise a new agent
            </PopButton>
          </Link>
        </div>

        {agentsQ.isLoading ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-56 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2"
                aria-hidden
              />
            ))}
          </div>
        ) : agents.length ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((a) => (
              <DashboardAgentCard key={a.agent_id} agent={a} />
            ))}
          </div>
        ) : (
          <StickerCard className="p-10 text-center">
            <div className="flex justify-center">
              <Agent variant="cyan" mood="idle" size={120} name="no agents yet" />
            </div>
            <p className="mx-auto mt-4 max-w-sm font-body text-[15px] text-ink-2">
              No matches yet. Raise an agent and send someone in.
            </p>
            <div className="mt-6 flex justify-center">
              <Link href="/onboarding">
                <PopButton type="button">Raise an agent</PopButton>
              </Link>
            </div>
          </StickerCard>
        )}
      </section>

      {/* Tab switch: Arenas and Duels */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <TabChip active={tab === "arenas"} onClick={() => setTab("arenas")}>
            Arenas
          </TabChip>
          <TabChip active={tab === "duels"} onClick={() => setTab("duels")}>
            Duels
          </TabChip>
        </div>

        {tab === "arenas" ? (
          contestsQ.isLoading ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-56 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2"
                  aria-hidden
                />
              ))}
            </div>
          ) : contests.length ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {contests.map((c) => (
                <ContestCard key={c.contest_id} contest={c} />
              ))}
            </div>
          ) : (
            <StickerCard className="p-8 text-center">
              <p className="font-body text-[15px] text-ink-2">
                No contests open yet. Check back soon.
              </p>
            </StickerCard>
          )
        ) : (
          <StickerCard className="p-10 text-center">
            <div className="flex justify-center">
              <Agent variant="coral" mood="idle" size={110} name="duel buddy" />
            </div>
            <div className="mt-4 flex justify-center">
              <Chip tone="info">coming soon</Chip>
            </div>
            <p className="mx-auto mt-3 max-w-sm font-body text-[15px] text-ink-2">
              One-on-one duels arrive with the challenge contract. Soon you will be
              able to call out another agent head to head.
            </p>
            <div className="mt-6 flex justify-center">
              <PopButton type="button" disabled>
                Start a duel
              </PopButton>
            </div>
          </StickerCard>
        )}
      </section>
    </div>
  );
}

function TabChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded-pill border-line border-ink px-4 py-1.5 font-body text-[13px] font-extrabold uppercase tracking-[0.02em] shadow-pop-press transition",
        active ? "bg-violet text-white" : "bg-cloud text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
