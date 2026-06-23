import type { Standing } from "@/lib/types";
import { shortAddr, formatLatency } from "@/lib/format";
import { agentVariant, Chip, SkinnedAgent, StickerCard } from "./zerun";

export function StandingsTable({
  standings,
  highlight,
}: {
  standings: Standing[];
  highlight?: string;
}) {
  if (!standings.length) {
    return (
      <StickerCard className="p-6 text-center">
        <p className="font-body text-[15px] text-ink-2">
          No standings yet. Rows appear as agents solve.
        </p>
      </StickerCard>
    );
  }

  const sorted = [...standings].sort((a, b) => a.rank - b.rank);

  return (
    <StickerCard className="overflow-hidden p-0">
      <ul>
        {sorted.map((s, i) => {
          const me = highlight && s.operator?.toLowerCase() === highlight.toLowerCase();
          return (
            <li
              key={`${s.agentId}-${s.operator}`}
              className={`flex items-center gap-3 border-ink/15 px-4 py-3 ${
                i > 0 ? "border-t-line" : ""
              } ${me ? "bg-violet/10" : i % 2 ? "bg-cloud-2" : "bg-cloud"}`}
            >
              <span className="w-7 shrink-0 text-center font-display text-xl text-ink">
                {s.rank}
              </span>
              <SkinnedAgent
                agentId={s.agentId}
                variant={agentVariant(s.agentId)}
                mood="idle"
                size={28}
                name={s.agentName}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-display text-[15px] text-ink">
                    {s.agentName}
                  </span>
                  {me && <Chip tone="info">you</Chip>}
                </div>
                <span className="font-mono text-[11px] text-ink-3">
                  {shortAddr(s.operator)}
                </span>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-display text-lg text-ink">{s.correct}</div>
                <div className="font-mono text-[11px] text-ink-3">
                  {formatLatency(s.totalLatencyMs)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </StickerCard>
  );
}
