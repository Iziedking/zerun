"use client";

import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { shortId } from "@/lib/format";
import type { AgentMemoryResponse, MemoryKind } from "@/lib/types";
import { Chip, StickerCard, ThoughtBubble, cx } from "./zerun";

// An agent's memory: the 0G-authored self-summary it carries into its next contest, the
// record it was drawn from, and the 0G Storage anchor that proves it was produced on 0G.
//
// Memory is stored PER KIND, because what an agent learns about puzzles has nothing to say
// about how it plays a hand. Stacking one card per kind pushed the rest of the profile off
// the screen and gave no hint that a second memory even existed. So they live in one deck
// the reader pages through, with the kind on the card and the position under it.

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
  const withMemory = loaded.filter((d) => d.memory);
  const [page, setPage] = useState(0);

  // An agent that learns a new kind must not leave the reader stranded on a page that no
  // longer exists.
  useEffect(() => {
    if (page >= withMemory.length && withMemory.length > 0) setPage(0);
  }, [page, withMemory.length]);

  if (!loaded.length) return null;
  const enabled = loaded.some((d) => d.enabled);

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
          keep doing and what to fix: one for puzzles, one for poker, one for chess.
        </p>
      </StickerCard>
    );
  }

  const current = withMemory[Math.min(page, withMemory.length - 1)]!;
  const many = withMemory.length > 1;
  const go = (delta: number) => setPage((p) => (p + delta + withMemory.length) % withMemory.length);

  return (
    <StickerCard className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-lg text-ink">Memory</span>
          <Chip tone="neutral">{KIND_LABEL[current.kind]}</Chip>
          <Chip tone={current.enabled ? "thinking" : "neutral"}>
            {current.enabled ? "learning on 0G" : "off"}
          </Chip>
          {current.paid && <Chip tone="won">paid intel</Chip>}
          {current.memory?.contests ? (
            <Chip tone="info">
              {current.memory.contests} update{current.memory.contests > 1 ? "s" : ""}
            </Chip>
          ) : null}
        </div>
        {many && <Pager page={page} total={withMemory.length} onGo={go} />}
      </div>

      <MemoryBody data={current} />

      {/* The dots repeat the position at the bottom of a tall card, where the arrows have
          scrolled out of reach. They are a control too: tapping one jumps straight there. */}
      {many && (
        <div className="mt-4 flex items-center justify-center gap-2">
          {withMemory.map((d, i) => (
            <button
              key={d.kind}
              type="button"
              onClick={() => setPage(i)}
              aria-label={`Show ${KIND_LABEL[d.kind]} memory`}
              aria-current={i === page}
              className={cx(
                "h-3 rounded-pill border-2 border-ink transition-all duration-200",
                i === page ? "w-7 bg-violet" : "w-3 bg-cloud hover:bg-cloud-2",
              )}
            />
          ))}
        </div>
      )}
    </StickerCard>
  );
}

/** Back and forward, and where you are. Chunky, outlined, and it squishes when pressed. */
function Pager({ page, total, onGo }: { page: number; total: number; onGo: (d: number) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <ArrowButton dir="back" onClick={() => onGo(-1)} />
      <span className="font-display text-[13px] tabular-nums text-ink-2">
        {page + 1} / {total}
      </span>
      <ArrowButton dir="forward" onClick={() => onGo(1)} />
    </div>
  );
}

function ArrowButton({ dir, onClick }: { dir: "back" | "forward"; onClick: () => void }) {
  const back = dir === "back";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={back ? "Previous memory" : "Next memory"}
      className={cx(
        "grid h-9 w-9 place-items-center rounded-chunk border-line border-ink bg-cloud text-ink",
        // Same squish as PopButton: it pushes into the page, shadow and all.
        "shadow-pop transition-[transform,box-shadow] duration-150 ease-spring",
        "hover:-translate-x-px hover:-translate-y-px hover:shadow-pop-lg",
        "active:translate-x-[2px] active:translate-y-[2px] active:shadow-pop-press",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
      )}
    >
      {/* A fat, round-capped chevron: the same ink stroke as everything else on the page. */}
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={back ? "" : "rotate-180"}>
        <path
          d="M10.5 2.5 L4.5 8 l6 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function MemoryBody({ data }: { data: AgentMemoryResponse }) {
  const { memory } = data;
  const t = memory?.tendencies;
  const acc = t && t.accuracy != null ? `${Math.round(t.accuracy * 100)}%` : null;

  return (
    <>
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
    </>
  );
}
