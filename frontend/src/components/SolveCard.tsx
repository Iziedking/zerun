import type { Verdict } from "@/lib/types";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { Agent, agentVariant, Chip, StickerCard, ThoughtBubble, type AgentMood } from "./zerun";

export interface SolveRow {
  key: string;
  agentId?: number;
  agentName: string;
  puzzleIdx: number;
  prompt: string;
  answer: string;
  verdict: Verdict;
  provider: string;
  model: string;
  chatId: string;
  latencyMs: number;
  verified: boolean | null;
  source: string;
  fresh?: boolean;
}

const VERDICT: Record<Verdict, { label: string; tone: "live" | "hot" | "won"; mood: AgentMood }> = {
  correct: { label: "correct", tone: "live", mood: "happy" },
  wrong: { label: "wrong", tone: "hot", mood: "lose" },
  error: { label: "error", tone: "won", mood: "lose" },
};

// One solve in the live feed, reframed as the agent character with its current
// ThoughtBubble showing the answer, and the 0G provenance prominently below.
export function SolveCard({ row }: { row: SolveRow }) {
  const v = VERDICT[row.verdict] ?? VERDICT.error;
  const variant = agentVariant(row.agentId ?? row.agentName);

  return (
    <StickerCard
      className={`p-5 ${row.fresh ? "motion-safe:animate-drop-in" : ""}`}
    >
      <div className="flex items-start gap-4">
        {/* The character */}
        <div className="shrink-0">
          <Agent variant={variant} mood={v.mood} size={84} name={row.agentName} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-display text-lg text-ink">{row.agentName}</span>
              <span className="font-mono text-[11px] text-ink-3">
                puzzle {row.puzzleIdx + 1}
              </span>
            </div>
            <Chip tone={v.tone}>{v.label}</Chip>
          </div>

          {/* The thought bubble shows the answer it produced on 0G. */}
          <div className="mt-2">
            <ThoughtBubble tone="cloud" tail="left">
              <span className="font-mono text-[13px]">{row.answer || "·"}</span>
            </ThoughtBubble>
          </div>
        </div>
      </div>

      {/* Puzzle line */}
      <p className="mt-4 font-body text-[14px] leading-relaxed text-ink-2">
        <span className="font-extrabold uppercase tracking-[0.02em] text-ink-3">
          puzzle ·{" "}
        </span>
        {row.prompt || "·"}
      </p>

      {/* The 0G provenance, prominent. */}
      <div className="mt-3">
        <ProvenanceBadge
          provider={row.provider}
          model={row.model}
          chatId={row.chatId}
          latencyMs={row.latencyMs}
          verified={row.verified}
          source={row.source}
        />
      </div>
    </StickerCard>
  );
}
