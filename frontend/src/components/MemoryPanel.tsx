"use client";

import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { shortId } from "@/lib/format";
import type { AgentMemoryResponse, MemoryKind } from "@/lib/types";
import { Chip, StickerCard, ThoughtBubble } from "./zerun";

// An agent's memory: the 0G-authored self-summary it carries into its next contest, the
// record it was drawn from, and the 0G Storage anchor that proves it was produced on 0G.
//
// Memory is stored PER KIND, because what an agent learns about puzzles has nothing to say
// about how it plays a hand. This panel used to request only the "general" kind (the default
// argument on api.agentMemory), so a chess or poker memory could be written, anchored on 0G,
// and paid for, and the profile would still report "No memory yet". Ask for all three.

const KINDS: MemoryKind[] = ["general", "poker", "chess"];
const KIND_LABEL: Record<MemoryKind, string> = {
  general: "Puzzles & predictions",
  poker: "Poker",
  chess: "Chess",
};

export function MemoryPanel({ agentId }: { agentId: number }) {
  const results = useQueries({
    queries: KINDS.map((kind) => ({
      queryKey: ["agent-memory", agentId, kind],
      queryFn: () => api.agentMemory(agentId, kind),
      staleTime: 60_000,
    })),
  });

  const loaded = results.filter((r) => r.data).map((r) => r.data as AgentMemoryResponse);
  if (!loaded.length) return null;

  const enabled = loaded.some((d) => d.enabled);
  const withMemory = loaded.filter((d) => d.memory);

  // Nothing learned anywhere, and the feature is off: stay out of the way entirely.
  if (!withMemory.length && !enabled) return null;

  // Nothing learned yet, but memory is on. One card, not three empty ones.
  if (!withMemory.length) {
    return (
      <StickerCard className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-display text-lg text-ink">Memory</span>
          <Chip tone="thinking">learning on 0G</Chip>
        </div>
        <p className="font-body text-[14px] text-ink-2">
          No memory yet. After a few contests, this agent writes itself a note on 0G about what to
          keep doing and what to fix — one for puzzles, one for poker, one for chess.
        </p>
      </StickerCard>
    );
  }

  // One card per kind the agent has actually learned something about.
  return (
    <>
      {withMemory.map((d) => (
        <MemoryCard key={d.kind} data={d} />
      ))}
    </>
  );
}

function MemoryCard({ data }: { data: AgentMemoryResponse }) {
  const { enabled, kind, paid, memory } = data;
  const t = memory?.tendencies;
  const acc = t && t.accuracy != null ? `${Math.round(t.accuracy * 100)}%` : null;

  return (
    <StickerCard className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-display text-lg text-ink">Memory</span>
        <Chip tone="neutral">{KIND_LABEL[kind]}</Chip>
        <Chip tone={enabled ? "thinking" : "neutral"}>{enabled ? "learning on 0G" : "off"}</Chip>
        {paid && <Chip tone="won">paid intel</Chip>}
        {memory?.contests ? (
          <Chip tone="info">
            {memory.contests} update{memory.contests > 1 ? "s" : ""}
          </Chip>
        ) : null}
      </div>

      {memory?.summary && (
        <ThoughtBubble tone="cloud" tail="left">
          <span className="font-body text-[14px] leading-relaxed text-ink">{memory.summary}</span>
        </ThoughtBubble>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {t && t.graded > 0 && acc && (
          <div>
            <div className="font-display text-2xl text-ink tabular-nums">{acc}</div>
            <div className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
              accuracy · {t.graded} graded
            </div>
          </div>
        )}
        {/* Poker and chess are never "graded": a move is not right or wrong. Their sample size is
            the number of contests played, which is the honest thing to show instead. */}
        {t && t.graded === 0 && (t.plays ?? 0) > 0 && (
          <div>
            <div className="font-display text-2xl text-ink tabular-nums">{t.plays}</div>
            <div className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
              contests played
            </div>
          </div>
        )}
        {t?.recentForm && (
          <div>
            <div className="flex gap-1">
              {t.recentForm.split("").map((r, i) => (
                <span
                  key={i}
                  className={`grid h-5 w-5 place-items-center rounded-full border-2 border-ink font-body text-[11px] font-extrabold ${
                    r === "W" ? "bg-mint text-candyink" : "bg-coral text-white"
                  }`}
                >
                  {r}
                </span>
              ))}
            </div>
            <div className="mt-1 font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
              recent form
            </div>
          </div>
        )}
      </div>

      {(memory?.storageRoot || memory?.model) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t-line border-ink/10 pt-3">
          {memory?.model && <span className="font-mono text-[11px] text-ink-3">authored by {memory.model}</span>}
          {memory?.storageRoot && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
              <Chip tone="won">0G Storage</Chip>
              {shortId(memory.storageRoot, 7, 5)}
            </span>
          )}
        </div>
      )}
    </StickerCard>
  );
}
