"use client";

import { useRecentFeed } from "@/lib/useAgents";
import { shortId, formatLatency } from "@/lib/format";
import { Chip, SkinnedAgent, StickerCard, agentVariant } from "@/components/zerun";

// The "live on 0G" recent-inference strip: the most recent answers agents thought
// on 0G, bouncing in. Makes the arena home feel alive without exposing mechanics.
export function LiveStrip({ limit = 8 }: { limit?: number }) {
  const { data } = useRecentFeed(limit);
  const rows = data?.feed ?? [];
  if (!rows.length) return null;

  return (
    <section>
      <div className="mb-3 flex items-center justify-center gap-2">
        <Chip tone="live" pulse>
          live on 0G
        </Chip>
      </div>
      <StickerCard className="overflow-hidden p-0">
        <ul>
          {rows.map((r, i) => (
            <li
              key={r.id}
              className={`flex items-center gap-3 border-ink/15 px-4 py-3 motion-safe:animate-drop-in ${
                i > 0 ? "border-t-line" : ""
              } ${i % 2 ? "bg-cloud-2" : "bg-cloud"}`}
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <SkinnedAgent
                agentId={r.agent_id}
                variant={agentVariant(r.agent_id)}
                mood="idle"
                size={28}
                name={r.agent_name ?? `Agent #${r.agent_id}`}
              />
              <span className="min-w-0 flex-1 truncate font-display text-[15px] text-ink">
                {r.agent_name ?? `Agent #${r.agent_id}`}
              </span>
              <span className="hidden font-body text-[13px] font-bold text-ink-2 sm:inline">
                {r.model || "0G model"}
              </span>
              <span className="hidden font-mono text-[11px] text-ink-3 md:inline">
                {shortId(r.chat_id, 6, 4)}
              </span>
              <span className="font-mono text-[11px] text-ink-3">
                {formatLatency(r.latency_ms)}
              </span>
              <Chip tone={r.verified ? "live" : "info"}>
                {r.verified ? "Verified on 0G" : "On 0G"}
              </Chip>
            </li>
          ))}
        </ul>
      </StickerCard>
    </section>
  );
}
