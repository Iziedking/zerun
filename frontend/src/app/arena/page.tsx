"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { ConnectGate } from "@/components/ConnectGate";
import { ArenaBoard } from "@/components/ArenaBoard";
import { DashboardAgentCard } from "@/components/DashboardAgentCard";
import { HostContestModal } from "@/components/HostContest";
import { useAgents } from "@/lib/useAgents";
import { useUsdcBalance } from "@/lib/useChainData";
import { shortAddr } from "@/lib/format";
import {
  Agent,
  CoinStat,
  PopButton,
  StickerCard,
} from "@/components/zerun";

// At most two agents per operator (the contract caps it there).
const MAX_AGENTS = 2;

export default function ArenaPage() {
  return (
    <div className="pt-10">
      <ConnectGate>
        <Dashboard />
      </ConnectGate>
    </div>
  );
}

function Dashboard() {
  const { address } = useAccount();
  const agentsQ = useAgents(address);
  const balance = useUsdcBalance(address);
  const [hosting, setHosting] = useState(false);

  const agents = agentsQ.data?.agents ?? [];
  const atCap = agents.length >= MAX_AGENTS;

  return (
    <div className="space-y-10">
      <HostContestModal open={hosting} onClose={() => setHosting(false)} />

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
        <div className="flex flex-wrap items-center gap-3">
          <CoinStat value={balance.formatted} suffix="tUSDC" caption="your balance" />
          <PopButton type="button" variant="secondary" onClick={() => setHosting(true)}>
            Host a contest
          </PopButton>
        </div>
      </header>

      {/* Agents shelf */}
      <section>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-display text-2xl text-ink">Your agents</h2>
          {atCap ? (
            <Link href="/arena">
              <PopButton type="button" variant="ghost" disabled>
                You have your two agents
              </PopButton>
            </Link>
          ) : (
            <Link href="/onboarding">
              <PopButton type="button" variant="secondary">
                Raise a new agent
              </PopButton>
            </Link>
          )}
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
              <DashboardAgentCard key={a.agent_id} agent={a} owner={address} />
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

      {/* The full arena board: Live, Recent, and Duels. */}
      <section>
        <ArenaBoard onHost={() => setHosting(true)} />
      </section>
    </div>
  );
}
