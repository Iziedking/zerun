"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { shortId } from "@/lib/format";
import { Chip, StickerCard, ThoughtBubble } from "./zerun";

// An agent's memory: the 0G-authored self-summary it carries into its next contest, the
// record it was drawn from, and the 0G Storage anchor that proves it was produced on 0G.
// Shows nothing when memory is off and the agent has none, so it never clutters an agent
// that has not learned anything yet.
export function MemoryPanel({ agentId }: { agentId: number }) {
  const { data } = useQuery({
    queryKey: ["agent-memory", agentId],
    queryFn: () => api.agentMemory(agentId),
    staleTime: 60_000,
  });

  if (!data) return null;
  const { enabled, memory } = data;
  // Nothing to show if the agent has no memory yet and the feature is off.
  if (!memory && !enabled) return null;

  const t = memory?.tendencies;
  const acc = t && t.accuracy != null ? `${Math.round(t.accuracy * 100)}%` : null;

  return (
    <StickerCard className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-display text-lg text-ink">Memory</span>
        <Chip tone={enabled ? "thinking" : "neutral"}>{enabled ? "learning on 0G" : "off"}</Chip>
        {memory?.contests ? (
          <Chip tone="info">
            {memory.contests} update{memory.contests > 1 ? "s" : ""}
          </Chip>
        ) : null}
      </div>

      {memory?.summary ? (
        <ThoughtBubble tone="cloud" tail="left">
          <span className="font-body text-[14px] leading-relaxed text-ink">{memory.summary}</span>
        </ThoughtBubble>
      ) : (
        <p className="font-body text-[14px] text-ink-2">
          No memory yet. After a few graded contests, this agent writes itself a note on 0G about
          what to keep doing and what to fix.
        </p>
      )}

      {t && t.graded > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {acc && (
            <div>
              <div className="font-display text-2xl text-ink tabular-nums">{acc}</div>
              <div className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
                accuracy · {t.graded} graded
              </div>
            </div>
          )}
          {t.recentForm && (
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
      )}

      {(memory?.storageRoot || memory?.model) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t-line border-ink/10 pt-3">
          {memory?.model && (
            <span className="font-mono text-[11px] text-ink-3">authored by {memory.model}</span>
          )}
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
