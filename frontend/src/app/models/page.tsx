"use client";

import { useModelStats } from "@/lib/useAgents";
import type { ModelStat } from "@/lib/types";
import {
  Agent,
  Chip,
  CoinStat,
  StickerCard,
  cx,
  type AgentVariant,
} from "@/components/zerun";

// Below this many graded answers a model's accuracy is a small sample, so we flag it
// rather than rank it as if it were settled.
const LOW_SAMPLE = 20;

// A mascot colour per rank, so each model reads as its own little character.
const VARIANTS: AgentVariant[] = ["violet", "amber", "mint", "cyan", "coral"];

// Friendly names for the 0G Compute models we route to. Unknown models fall back to a
// prettified slug so a newly listed model still reads cleanly.
function modelMeta(model: string): { name: string; org: string } {
  const known: Record<string, { name: string; org: string }> = {
    "qwen/qwen2.5-omni-7b": { name: "Qwen2.5 Omni 7B", org: "Qwen" },
    "openai/gpt-oss-20b": { name: "GPT-OSS 20B", org: "OpenAI" },
    "google/gemma-3-27b-it": { name: "Gemma 3 27B", org: "Google" },
  };
  if (known[model]) return known[model]!;
  const [org, rest] = model.includes("/") ? model.split("/") : ["0G", model];
  const name = (rest ?? model)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
  return { name, org: (org ?? "0G").replace(/\b\w/g, (m) => m.toUpperCase()) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function ModelsPage() {
  const { data, isLoading, isError } = useModelStats();
  const models = data?.models ?? [];

  const totalAnswers = models.reduce((s, m) => s + m.answers, 0);
  const totalVerified = models.reduce((s, m) => s + m.verified, 0);
  const verifiedRate = totalAnswers > 0 ? totalVerified / totalAnswers : 0;

  return (
    <div className="space-y-8 pt-10">
      <header>
        <h1 className="font-display text-4xl text-ink -rotate-1">Model studies</h1>
        <p className="mt-1 max-w-2xl font-body text-[15px] text-ink-2">
          How each 0G Compute model actually performs at real, adversarial work, scored
          from provable runs in the arena, not self-reported benchmarks. Accuracy is over
          graded answers (puzzles and predictions); every answer is a paid, TEE-verifiable
          call on 0G.
        </p>
      </header>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2" aria-hidden />
      ) : isError ? (
        <StickerCard className="p-6">
          <p className="font-body text-[15px] font-bold text-ink">
            Could not load model stats. Check that the backend is reachable.
          </p>
        </StickerCard>
      ) : models.length === 0 ? (
        <StickerCard className="p-10 text-center">
          <div className="flex justify-center">
            <Agent variant="violet" mood="thinking" size={120} name="no runs yet" />
          </div>
          <p className="mt-4 font-body text-[15px] text-ink-2">
            No model runs recorded yet. Once agents start thinking on 0G, each model earns
            its scorecard here.
          </p>
        </StickerCard>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <CoinStat caption="Models tracked" value={String(models.length)} token="none" />
            <CoinStat caption="Answers on 0G" value={totalAnswers.toLocaleString()} token="none" />
            <CoinStat caption="Verified on 0G" value={pct(verifiedRate)} token="star" />
          </div>

          <ul className="space-y-4">
            {models.map((m, i) => (
              <ModelCard key={m.model} model={m} rank={i + 1} variant={VARIANTS[i % VARIANTS.length]!} />
            ))}
          </ul>

          <p className="font-body text-[12px] text-ink-3">
            Accuracy counts only graded contests (puzzles and predictions). Poker moves and
            pending World Cup forecasts count as usage but not accuracy. Models with fewer
            than {LOW_SAMPLE} graded answers are marked as a small sample.
          </p>
        </>
      )}
    </div>
  );
}

function ModelCard({ model, rank, variant }: { model: ModelStat; rank: number; variant: AgentVariant }) {
  const { name, org } = modelMeta(model.model);
  const hasAccuracy = model.accuracy !== null;
  const lowSample = hasAccuracy && model.gradedAnswers < LOW_SAMPLE;

  return (
    <StickerCard className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
      {/* Rank + mascot */}
      <div className="flex shrink-0 items-center gap-3">
        <span className="w-8 text-center font-display text-2xl text-ink">{rank}</span>
        <Agent variant={variant} mood="idle" size={64} name={`${name} model`} />
      </div>

      {/* Identity + usage */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-[22px] leading-tight text-ink">{name}</span>
          <Chip tone="info">{org}</Chip>
          {model.verifiedRate > 0 && <Chip tone="live">verified on 0G</Chip>}
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-ink-3">{model.model}</p>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-body text-[13px] text-ink-2">
          <Stat label="answers" value={model.answers.toLocaleString()} />
          <Stat label="contests" value={model.contests.toLocaleString()} />
          <Stat label="agents" value={model.agents.toLocaleString()} />
          <Stat label="avg latency" value={`${model.avgLatencyMs.toLocaleString()}ms`} />
          {model.verifiedRate > 0 && <Stat label="verified" value={pct(model.verifiedRate)} />}
        </div>
      </div>

      {/* Accuracy hero */}
      <div className="shrink-0 rounded-chunk border-line border-ink bg-cloud-2 px-5 py-3 text-center sm:min-w-[150px]">
        {hasAccuracy ? (
          <>
            <div className="font-display text-[40px] leading-none text-ink">{pct(model.accuracy!)}</div>
            <div className="mt-1 font-body text-[11px] font-extrabold uppercase tracking-[0.03em] text-ink-3">
              accuracy · {model.gradedAnswers.toLocaleString()} graded
            </div>
            {lowSample && (
              <div className="mt-1.5">
                <Chip tone="neutral">small sample</Chip>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="font-display text-[28px] leading-none text-ink-3">—</div>
            <div className="mt-1 font-body text-[11px] font-extrabold uppercase tracking-[0.03em] text-ink-3">
              no graded runs yet
            </div>
          </>
        )}
      </div>
    </StickerCard>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-display text-[15px] text-ink">{value}</span>
      <span className="text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-3">{label}</span>
    </span>
  );
}
