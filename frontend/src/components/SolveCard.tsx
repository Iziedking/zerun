import type { ContestKind, Verdict } from "@/lib/types";
import { kindMeta } from "@/lib/kind";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { agentVariant, Chip, SkinnedAgent, StickerCard, ThoughtBubble, cx, type AgentMood, type ChipTone } from "./zerun";

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
  samples?: number;
  sources?: number;
  liveInsight?: boolean;
  fresh?: boolean;
}

const VERDICT: Record<Verdict, { label: string; tone: ChipTone; mood: AgentMood }> = {
  correct: { label: "correct", tone: "live", mood: "happy" },
  wrong: { label: "wrong", tone: "hot", mood: "lose" },
  error: { label: "error", tone: "won", mood: "lose" },
  action: { label: "acts", tone: "thinking", mood: "thinking" },
};

const RED_SUITS = new Set(["h", "d"]);
const SUIT_SYMBOL: Record<string, string> = { h: "♥", d: "♦", c: "♣", s: "♠" };

// A single playing card as a small white sticker pill, red for hearts and diamonds.
function CardPip({ token }: { token: string }) {
  const rank = token.slice(0, -1).replace("T", "10");
  const suit = token.slice(-1);
  return (
    <span
      className={cx(
        "inline-flex items-center gap-0.5 rounded-lg border-2 border-ink bg-white px-1.5 py-0.5 font-body text-[12px] font-extrabold shadow-[2px_2px_0_#171449]",
        RED_SUITS.has(suit) ? "text-coral" : "text-ink",
      )}
    >
      {rank}
      <span aria-hidden>{SUIT_SYMBOL[suit] ?? ""}</span>
    </span>
  );
}

// Pull the card tokens out of a poker hand prompt like "flop: As Kd on Th 7c 2s".
// The first two are the agent's hole cards; the rest are the community board.
function pokerCards(prompt: string): { hole: string[]; board: string[] } {
  const tokens = prompt.match(/\b(?:10|[2-9TJQKA])[cdhs]\b/g) ?? [];
  return { hole: tokens.slice(0, 2), board: tokens.slice(2) };
}

// One solve in the live feed, reframed as the agent character with its current
// ThoughtBubble showing the answer, and the 0G provenance prominently below. Reads
// for all flavors: a number for a solver, a Yes/No call for an analyst, a betting
// move for a poker duel.
export function SolveCard({ row, kind = "solver" }: { row: SolveRow; kind?: ContestKind }) {
  const v = VERDICT[row.verdict] ?? VERDICT.error;
  const variant = agentVariant(row.agentId ?? row.agentName);
  const meta = kindMeta(kind);
  const answer = row.answer || "·";
  const isPoker = kind === "poker";
  const cards = isPoker ? pokerCards(row.prompt) : null;
  // A quiet tell that this agent used a level 4-5 perk on this answer.
  const perk =
    kind === "analyst" && (row.sources ?? 0) > 0
      ? "researched"
      : kind === "solver" && row.liveInsight
        ? "live insight"
        : null;

  return (
    <StickerCard className={`p-5 ${row.fresh ? "motion-safe:animate-drop-in" : ""}`}>
      <div className="flex items-start gap-4">
        {/* The character */}
        <div className="shrink-0">
          <SkinnedAgent agentId={row.agentId} variant={variant} mood={v.mood} size={84} name={row.agentName} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-lg text-ink">{row.agentName}</span>
              <span className="font-mono text-[11px] text-ink-3">
                {meta.taskWord} {row.puzzleIdx + 1}
              </span>
              {perk && (
                <span
                  title="Used a Compute level 4-5 perk on this answer"
                  className="inline-flex items-center gap-1 rounded-pill border border-ink/20 bg-cyan/15 px-2 py-0.5 font-body text-[10px] font-extrabold uppercase tracking-[0.03em] text-ink-2"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan" aria-hidden />
                  {perk}
                </span>
              )}
            </div>
            <Chip tone={v.tone}>{v.label}</Chip>
          </div>

          {/* The thought bubble shows what it produced on 0G: a number for a solver,
              a Yes/No call for an analyst, the betting move for a poker duel. */}
          <div className="mt-2">
            <ThoughtBubble tone="cloud" tail="left">
              {kind === "solver" ? (
                <span className="font-mono text-[13px]">{answer}</span>
              ) : (
                <span className="font-body text-[15px] font-extrabold text-ink">{answer}</span>
              )}
            </ThoughtBubble>
          </div>
        </div>
      </div>

      {/* Poker shows the hand as cards; the other flavors show the task line. */}
      {isPoker && cards ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="font-body text-[11px] font-extrabold uppercase tracking-[0.03em] text-ink-3">Hole</span>
            {cards.hole.length ? (
              cards.hole.map((t, i) => <CardPip key={`h${i}`} token={t} />)
            ) : (
              <span className="font-mono text-[12px] text-ink-3">hidden</span>
            )}
          </span>
          {cards.board.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="font-body text-[11px] font-extrabold uppercase tracking-[0.03em] text-ink-3">Board</span>
              {cards.board.map((t, i) => (
                <CardPip key={`b${i}`} token={t} />
              ))}
            </span>
          )}
        </div>
      ) : (
        <p className="mt-4 font-body text-[14px] leading-relaxed text-ink-2">
          <span className="font-extrabold uppercase tracking-[0.02em] text-ink-3">{meta.promptLabel} ·{" "}</span>
          {row.prompt || "·"}
        </p>
      )}

      {/* The 0G provenance, prominent. */}
      <div className="mt-3">
        <ProvenanceBadge
          provider={row.provider}
          model={row.model}
          chatId={row.chatId}
          latencyMs={row.latencyMs}
          verified={row.verified}
          source={row.source}
          samples={row.samples}
          sources={row.sources}
        />
      </div>
    </StickerCard>
  );
}
