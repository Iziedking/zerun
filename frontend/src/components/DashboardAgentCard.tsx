"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { AgentRecord } from "@/lib/types";
import { useContests } from "@/lib/useAgents";
import { SkinUpload } from "./SkinUpload";
import { TrainAgent } from "./TrainAgent";
import { agentVariant, Chip, PopButton, SkinnedAgent, StickerCard } from "./zerun";

// Compute level names, the single 0G-funded skill dial. Every agent starts at Base.
const COMPUTE_NAME = ["Base", "Spark", "Sharp", "Deep", "Elite", "Apex"];

// One agent on the shelf: the character in its costume color, its name, its tier,
// a small win/loss record, and a one-tap way to send it in.
export function DashboardAgentCard({
  agent,
  owner,
}: {
  agent: AgentRecord;
  owner?: string;
}) {
  const level = agent.compute_level ?? 0;
  const isOwner = Boolean(owner && agent.owner?.toLowerCase() === owner.toLowerCase());
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

  return (
    <StickerCard className="flex h-full flex-col p-6 text-center">
      <div className="flex justify-center">
        <SkinnedAgent
          agentId={agent.agent_id}
          variant={agentVariant(agent.agent_id)}
          mood="idle"
          size={110}
          name={agent.name}
        />
      </div>
      <div className="mt-3 font-display text-xl text-ink">{agent.name}</div>
      <div className="mt-1 flex items-center justify-center gap-2">
        <Chip tone="won">
          L{level} {COMPUTE_NAME[Math.min(level, COMPUTE_NAME.length - 1)]}
        </Chip>
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
        <Record label="0G calls" value={agent.og_calls ?? 0} />
      </div>

      {isOwner && owner && (
        <div className="mt-4 space-y-3">
          <div className="flex justify-center">
            <SkinUpload agentId={agent.agent_id} owner={owner} compact />
          </div>
          <TrainAgent agentId={agent.agent_id} level={level} owner={owner} />
        </div>
      )}

      <div className="mt-auto pt-5">
        {agent.in_contest ? (
          <PopButton type="button" variant="ghost" className="w-full" disabled>
            In a contest
          </PopButton>
        ) : target ? (
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
