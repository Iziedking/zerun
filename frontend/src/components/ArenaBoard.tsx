"use client";

import { useMemo, useState } from "react";
import { useContests } from "@/lib/useAgents";
import type { ContestSummary } from "@/lib/types";
import { ContestCard } from "./ContestCard";
import { Agent, Chip, LoadMore, PopButton, StickerCard, cx } from "./zerun";

type Tab = "live" | "recent" | "duels";

// How many settled contests to show before "load more".
const RECENT_PAGE = 6;

// "Live" covers anything still in play; "Recent" is settled.
function isLive(c: ContestSummary): boolean {
  const s = (c.status || "").toLowerCase();
  return s === "open" || s === "pending" || s === "running" || s === "active";
}
function isSettled(c: ContestSummary): boolean {
  const s = (c.status || "").toLowerCase();
  return s === "settled" || Boolean(c.settled_at);
}
// A duel is a 1v1 contest (a two-seat cap): poker duels and prediction duels.
function isDuel(c: ContestSummary): boolean {
  return c.max_operators === 2;
}

// The arena board: every contest grouped into Live and Recent, plus a friendly
// Duels coming-soon. Shared by the landing and the dashboard.
export function ArenaBoard({ onHost }: { onHost?: () => void }) {
  const { data, isLoading } = useContests();
  // Null until the visitor picks a tab, so the board can open on Live or fall
  // back to Recent on its own depending on what the arena currently holds.
  const [picked, setPicked] = useState<Tab | null>(null);
  const [recentShown, setRecentShown] = useState(RECENT_PAGE);

  const contests = data?.contests ?? [];
  const live = useMemo(() => contests.filter(isLive), [contests]);
  const recent = useMemo(
    () =>
      contests
        .filter(isSettled)
        .sort((a, b) => Number(b.contest_id) - Number(a.contest_id)),
    [contests],
  );
  const recentVisible = recent.slice(0, recentShown);
  // Every 1v1 duel, live or settled, newest first. Poker and prediction duels.
  const duels = useMemo(
    () => contests.filter(isDuel).sort((a, b) => Number(b.contest_id) - Number(a.contest_id)),
    [contests],
  );

  // Open on Live, but show Recent results when nothing is live so the arena
  // never greets a visitor with an empty board between contests.
  const tab: Tab = picked ?? (live.length === 0 && recent.length > 0 ? "recent" : "live");
  const setTab = setPicked;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-3xl text-ink -rotate-1">The arena</h2>
        <div className="flex items-center gap-2">
          {onHost && (
            <PopButton type="button" variant="secondary" onClick={onHost}>
              Host a contest
            </PopButton>
          )}
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <BoardTab active={tab === "live"} onClick={() => setTab("live")}>
          Live · {live.length}
        </BoardTab>
        <BoardTab active={tab === "recent"} onClick={() => setTab("recent")}>
          Recent · {recent.length}
        </BoardTab>
        <BoardTab active={tab === "duels"} onClick={() => setTab("duels")}>
          Duels · {duels.length}
        </BoardTab>
      </div>

      {tab === "duels" ? (
        duels.length ? (
          <Grid>
            {duels.map((c) => (
              <ContestCard key={c.contest_id} contest={c} />
            ))}
          </Grid>
        ) : (
          <DuelsEmpty />
        )
      ) : isLoading ? (
        <Grid>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-56 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2"
              aria-hidden
            />
          ))}
        </Grid>
      ) : tab === "live" ? (
        live.length ? (
          <Grid>
            {live.map((c) => (
              <ContestCard key={c.contest_id} contest={c} />
            ))}
          </Grid>
        ) : (
          <Empty
            text="No contests live right now. Host one, or check back as the arena fills."
            onHost={onHost}
          />
        )
      ) : recent.length ? (
        <>
          <Grid>
            {recentVisible.map((c) => (
              <ContestCard key={c.contest_id} contest={c} />
            ))}
          </Grid>
          <LoadMore
            className="mt-6"
            remaining={recent.length - recentVisible.length}
            onMore={() => setRecentShown((n) => n + RECENT_PAGE)}
          />
        </>
      ) : (
        <Empty text="No settled contests yet. The first winners will show up here." />
      )}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function Empty({ text, onHost }: { text: string; onHost?: () => void }) {
  return (
    <StickerCard className="p-10 text-center">
      <div className="flex justify-center">
        <Agent variant="cyan" mood="idle" size={110} name="quiet arena" />
      </div>
      <p className="mx-auto mt-4 max-w-sm font-body text-[15px] text-ink-2">{text}</p>
      {onHost && (
        <div className="mt-6 flex justify-center">
          <PopButton type="button" onClick={onHost}>
            Host a contest
          </PopButton>
        </div>
      )}
    </StickerCard>
  );
}

function DuelsEmpty() {
  return (
    <StickerCard className="p-10 text-center">
      <div className="flex justify-center">
        <Agent variant="coral" mood="idle" size={120} name="duel buddy" />
      </div>
      <p className="mx-auto mt-5 max-w-sm font-body text-[15px] text-ink-2">
        No duels running right now. A duel puts one agent head to head with another,
        winner takes the pool. Check back as the arena fills.
      </p>
    </StickerCard>
  );
}

function BoardTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded-pill border-line border-ink px-4 py-1.5 font-body text-[13px] font-extrabold uppercase tracking-[0.02em] shadow-pop-press transition",
        active ? "bg-violet text-white" : "bg-cloud text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
