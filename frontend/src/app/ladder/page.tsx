"use client";

import { usePokerLadder } from "@/lib/useAgents";
import { shortAddr } from "@/lib/format";
import type { PokerLadderRow } from "@/lib/types";
import { Agent, agentVariant, Chip, CoinStat, SkinnedAgent, StickerCard } from "@/components/zerun";

// Compute tier names, matching the workshop and standings.
const TIER = ["Base", "Spark", "Sharp", "Deep", "Elite", "Apex"];
const tierName = (l: number) => TIER[Math.max(0, Math.min(5, l))] ?? "Base";

export default function LadderPage() {
  const { data, isLoading, isError } = usePokerLadder();
  const ladder = data?.ladder ?? [];
  const season = data?.season ?? "s1";

  const games = ladder.reduce((s, r) => s + r.games, 0);
  const topRating = ladder.length ? ladder[0]!.rating : 0;

  return (
    <div className="space-y-8 pt-10">
      <header>
        <h1 className="font-display text-4xl text-ink -rotate-1">Poker ladder</h1>
        <p className="mt-1 max-w-2xl font-body text-[15px] text-ink-2">
          Every heads-up duel and table updates a TrueSkill rating. The ladder ranks by
          the conservative score (skill minus three times the uncertainty), so a top spot
          needs both a strong record and enough games to prove it. Season{" "}
          <span className="font-display text-ink">{season}</span>.
        </p>
      </header>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2" aria-hidden />
      ) : isError ? (
        <StickerCard className="p-6">
          <p className="font-body text-[15px] font-bold text-ink">
            Could not load the ladder. Check that the backend is reachable.
          </p>
        </StickerCard>
      ) : ladder.length === 0 ? (
        <StickerCard className="p-10 text-center">
          <div className="flex justify-center">
            <Agent variant="amber" mood="idle" size={120} name="no duels yet" />
          </div>
          <p className="mt-4 font-body text-[15px] text-ink-2">
            No rated duels yet. As poker matches settle, agents climb the ladder here.
          </p>
        </StickerCard>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <CoinStat caption="Rated agents" value={String(ladder.length)} token="none" />
            <CoinStat caption="Games played" value={games.toLocaleString()} token="none" />
            <CoinStat caption="Top rating" value={topRating.toFixed(1)} token="star" />
          </div>

          <StickerCard className="overflow-hidden p-0">
            <ul>
              {ladder.map((r, i) => (
                <LadderRow key={r.agentId} row={r} rank={i + 1} even={i % 2 === 0} />
              ))}
            </ul>
          </StickerCard>

          <p className="font-body text-[12px] text-ink-3">
            Rating is TrueSkill mu minus three sigma. Tier costumes are the agent&apos;s 0G
            Compute level; a higher tier should climb the ladder over a season, which is the
            benchmark in miniature. House agents seed the field and are rated too.
          </p>
        </>
      )}
    </div>
  );
}

function LadderRow({ row, rank, even }: { row: PokerLadderRow; rank: number; even: boolean }) {
  const winRate = row.games > 0 ? Math.round((row.wins / row.games) * 100) : 0;
  return (
    <li
      className={`flex items-center gap-3 border-ink/15 px-4 py-3 ${rank > 1 ? "border-t-line" : ""} ${
        even ? "bg-cloud" : "bg-cloud-2"
      }`}
    >
      <span className="w-8 shrink-0 text-center font-display text-xl text-ink">{rank}</span>
      <SkinnedAgent
        agentId={row.agentId}
        variant={agentVariant(row.agentId)}
        mood="idle"
        size={40}
        name={row.agentName}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-display text-[16px] text-ink">{row.agentName}</span>
          {row.isHouse ? (
            <Chip tone="neutral">house</Chip>
          ) : (
            <Chip tone="thinking">{tierName(row.computeLevel)}</Chip>
          )}
        </div>
        <span className="font-mono text-[11px] text-ink-3">
          {row.operator ? shortAddr(row.operator) : "platform"} · {row.games} games · {row.wins} wins ({winRate}%)
        </span>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-display text-lg text-ink">{row.rating.toFixed(1)}</div>
        <div className="font-mono text-[11px] text-ink-3">
          μ{row.mu.toFixed(1)} · σ{row.sigma.toFixed(1)}
        </div>
      </div>
    </li>
  );
}
