"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { AgentRecord } from "@/lib/types";
import { useContests } from "@/lib/useAgents";
import { useSolverTier } from "@/lib/useChainData";
import { Agent, agentVariant, Chip, PopButton, StickerCard } from "./zerun";

// Costume label for a solver-ladder tier. Tier 0 is a fresh rookie; higher tiers
// read as "decked out".
const TIER_NAME = ["Rookie", "Scout", "Adept", "Ace", "Champ"];

// One agent on the shelf: the character in its costume color, its name, its tier,
// a small win/loss record, and a one-tap way to send it in.
export function DashboardAgentCard({ agent }: { agent: AgentRecord }) {
  const { tier } = useSolverTier(agent.agent_id);
  const { data } = useContests();

  const wins = agent.wins ?? 0;
  const matches = agent.matches ?? 0;
  const losses = Math.max(0, matches - wins);

  // Easiest open contest to send into: smallest open solver pool first.
  const target = useMemo(() => {
    const open = (data?.contests ?? []).filter((c) => {
      const s = (c.status || "").toLowerCase();
      return s === "open" || s === "pending" || s === "running" || s === "active";
    });
    return [...open].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "solver" ? -1 : 1))[0];
  }, [data]);

  const tierLabel =
    tier === null ? "Rookie" : TIER_NAME[Math.min(tier, TIER_NAME.length - 1)] ?? `Tier ${tier}`;

  return (
    <StickerCard className="flex h-full flex-col p-6 text-center">
      <div className="flex justify-center">
        <Agent
          variant={agentVariant(agent.agent_id)}
          mood="idle"
          size={110}
          name={agent.name}
        />
      </div>
      <div className="mt-3 font-display text-xl text-ink">{agent.name}</div>
      <div className="mt-1 flex items-center justify-center gap-2">
        <Chip tone="won">{tierLabel}</Chip>
        <span className="font-mono text-[11px] text-ink-3">#{agent.agent_id}</span>
      </div>

      {/* Win/loss record */}
      <div className="mt-4 flex items-center justify-center gap-3">
        <Record label="wins" value={wins} />
        <span aria-hidden className="font-display text-lg text-ink-3">
          ·
        </span>
        <Record label="losses" value={losses} />
        <span aria-hidden className="font-display text-lg text-ink-3">
          ·
        </span>
        <Record label="on 0G" value={agent.og_calls ?? 0} />
      </div>

      <div className="mt-auto pt-5">
        {target ? (
          <Link href={`/contest/${target.contest_id}`} className="block">
            <PopButton type="button" className="w-full" tabIndex={-1}>
              Send to compete
            </PopButton>
          </Link>
        ) : (
          <PopButton type="button" className="w-full" disabled>
            No open contest
          </PopButton>
        )}
      </div>
    </StickerCard>
  );
}

function Record({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-display text-2xl leading-none text-ink">{value}</div>
      <div className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
        {label}
      </div>
    </div>
  );
}
