import type { Verdict } from "@/lib/types";
import { ProvenanceBadge } from "./ProvenanceBadge";

export interface SolveRow {
  key: string;
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

const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  correct: { label: "correct", cls: "border-signal/50 bg-signal/10 text-signal" },
  wrong: { label: "wrong", cls: "border-ember/45 bg-ember/10 text-ember" },
  error: { label: "error", cls: "border-amber/45 bg-amber/10 text-amber" },
};

// One solve in the live feed. The provenance block is the dominant element.
export function SolveCard({ row }: { row: SolveRow }) {
  const v = VERDICT[row.verdict] ?? VERDICT.error;

  return (
    <article
      className={`panel p-4 ${row.fresh ? "animate-feed-in" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-600 text-bone">{row.agentName}</span>
            <span className="font-mono text-[11px] text-haze">puzzle {row.puzzleIdx + 1}</span>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-600 uppercase tracking-[0.1em] ${v.cls}`}
        >
          {v.label}
        </span>
      </div>

      <div className="mt-3 grid gap-2">
        <Line label="puzzle" text={row.prompt} />
        <Line label="answer" text={row.answer} mono accent={row.verdict === "correct"} />
      </div>

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
    </article>
  );
}

function Line({
  label,
  text,
  mono = false,
  accent = false,
}: {
  label: string;
  text: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="grid grid-cols-[64px_1fr] items-start gap-3">
      <span className="pt-0.5 text-[10px] uppercase tracking-[0.16em] text-haze">{label}</span>
      <p
        className={`text-sm leading-relaxed ${
          mono ? "font-mono text-[13px]" : ""
        } ${accent ? "text-signal" : "text-chalk"}`}
      >
        {text || "—"}
      </p>
    </div>
  );
}
