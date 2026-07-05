import type { Standing } from "@/lib/types";
import { shortAddr, formatLatency } from "@/lib/format";
import { agentVariant, Chip, SkinnedAgent, StickerCard } from "./zerun";

// Compute tier names, matching the workshop.
const TIER = ["Base", "Spark", "Sharp", "Deep", "Elite", "Apex"];
const tierName = (l?: number) => TIER[Math.max(0, Math.min(5, l ?? 0))] ?? "Base";

// The big number is whatever decides the winner for this contest kind: chips for a
// poker duel, prediction P&L for World Cup, or correct answers otherwise.
function formatScore(s: Standing): string {
  const metric = s.metric ?? "correct";
  const v = s.score ?? s.correct;
  if (metric === "chips") return Math.round(v).toLocaleString();
  if (metric === "P&L") return `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
  return String(s.correct);
}

// The caption under the score names the metric, so it is obvious what the number is.
// Correct-answer kinds keep the richer 0G signal (passes solved, else total latency).
function scoreLabel(s: Standing): string {
  const metric = s.metric ?? "correct";
  if (metric === "chips") return "chips";
  if (metric === "P&L") return "P&L";
  if (s.passes != null && s.passes > 0) return `${s.passes} passes`;
  return formatLatency(s.totalLatencyMs);
}

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
          const lvl = s.computeLevel ?? 0;
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
                  {s.isHouse && <Chip tone="neutral">house</Chip>}
                  {lvl >= 1 && !s.isHouse && <Chip tone="thinking">{tierName(lvl)}</Chip>}
                </div>
                <span className="font-mono text-[11px] text-ink-3">
                  {shortAddr(s.operator)}
                </span>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-display text-lg text-ink">{formatScore(s)}</div>
                <div className="font-mono text-[11px] text-ink-3">
                  {scoreLabel(s)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </StickerCard>
  );
}
