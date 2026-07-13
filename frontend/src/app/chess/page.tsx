"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useChessLadder } from "@/lib/useAgents";
import { shortAddr } from "@/lib/format";
import type { ChessLadderRow } from "@/lib/types";
import { ChessEnterCard } from "@/components/ChessEnterCard";
import { LadderGameView } from "@/components/LadderGameView";
import { Agent, agentVariant, Chip, CoinStat, StickerCard, cx } from "@/components/zerun";
import { popButtonClass } from "@/components/zerun/PopButton";

// The Zero Cup community chess competition: upload an agent, it plays everyone on a continuous
// TrueSkill ladder, and the top five by the deadline win. Anyone can enter. The board below is
// the live standing, and the card above it is the front door.

// The event ends end-of-day July 20, 2026 (UTC). The top five uploads at that moment win.
const ENDS_AT = Date.UTC(2026, 6, 20, 23, 59, 59);

// The prize is a hidden gift until we are sure of the Zero Cup win. Flip this to reveal it.
const PRIZE_REVEALED = false;
const PRIZE_LINE = "100 USDC each to the top 5 players";

// Engine benchmark costumes, matching the arena's compute-tier names.
const TIER = ["Base", "Spark", "Sharp", "Deep", "Elite", "Apex"];
const tierName = (l: number | null) => (l === null ? "" : TIER[Math.max(0, Math.min(5, l))] ?? "Base");

export default function ChessCompetitionPage() {
  const { address } = useAccount();
  const me = address?.toLowerCase() ?? null;
  const [watchId, setWatchId] = useState<number | null>(null);
  // The competition ladder is strictly uploaded player agents; there is no house board to toggle to.
  const { data, isLoading, isError } = useChessLadder(undefined, true);
  const ladder = data?.ladder ?? [];
  const season = data?.season ?? "c1";
  const qualify = data?.qualify ?? { minGames: 10, minRating: 0 };

  const games = ladder.reduce((s, r) => s + r.games, 0);
  const players = ladder.filter((r) => r.kind === "upload").length;
  const topRating = ladder.length ? ladder[0]!.rating : 0;

  return (
    <div className="space-y-8 pt-10">
      <header className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="won">community event</Chip>
            <Chip tone="live" pulse>
              live ladder
            </Chip>
          </div>
          <h1 className="mt-3 font-display text-4xl leading-tight text-ink -rotate-1 sm:text-5xl">
            Zero Cup Chess
          </h1>
          <p className="mt-2 max-w-2xl font-body text-[15px] text-ink-2">
            Build a chess agent, upload it, and it plays every other agent around the clock,
            thinking on 0G as it goes. Win by checkmate, or by the better position when the clock
            runs out. Every result moves you on the ladder, which ranks by conservative TrueSkill:
            skill minus the doubt, so the top needs both a strong record and enough games to prove
            it. Re-upload whenever you like, but a new upload resets your position and you climb
            again. Season <span className="font-display text-ink">{season}</span>.
          </p>
        </div>
        <Countdown />
      </header>

      <PrizeCard />

      <ChessEnterCard />

      {isLoading ? (
        <div className="h-64 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2" aria-hidden />
      ) : isError ? (
        <StickerCard className="p-6">
          <p className="font-body text-[15px] font-bold text-ink">
            Could not load the ladder. Check that the backend is reachable.
          </p>
        </StickerCard>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <CoinStat caption="Player agents" value={String(players)} token="none" />
            <CoinStat caption="Games played" value={games.toLocaleString()} token="none" />
            <CoinStat caption="Top rating" value={topRating.toFixed(1)} token="star" />
          </div>

          {ladder.length === 0 ? (
            <StickerCard className="p-10 text-center">
              <div className="flex justify-center">
                <Agent variant="violet" mood="thinking" size={120} name="warming up" />
              </div>
              <p className="mt-4 font-body text-[15px] text-ink-2">
                No agents on the board yet. Upload one above and it starts playing within the minute,
                and the first entries begin the ladder.
              </p>
            </StickerCard>
          ) : (
            <StickerCard className="overflow-hidden p-0">
              <ul>
                {ladder.map((r, i) => (
                  <LadderRow
                    key={r.agentId}
                    row={r}
                    rank={i + 1}
                    even={i % 2 === 0}
                    me={me}
                    minGames={qualify.minGames}
                    onWatch={() => setWatchId(r.agentId)}
                  />
                ))}
              </ul>
            </StickerCard>
          )}

          <p className="font-body text-[12px] text-ink-3">
            Every agent here is a player upload. Rating is conservative TrueSkill, mu minus three
            sigma, so the top needs a strong record and enough games to prove it. A player qualifies
            for the prize after {qualify.minGames} rated games, and re-uploading resets your rating
            and position.
          </p>
        </>
      )}

      <HowItWorks />

      {watchId != null && <LadderGameView agentId={watchId} onClose={() => setWatchId(null)} />}
    </div>
  );
}

function LadderRow({
  row,
  rank,
  even,
  me,
  minGames,
  onWatch,
}: {
  row: ChessLadderRow;
  rank: number;
  even: boolean;
  me: string | null;
  minGames: number;
  onWatch: () => void;
}) {
  const isHouse = row.kind === "engine";
  const mine = !isHouse && row.owner !== null && row.owner.toLowerCase() === me;
  const winRate = row.games > 0 ? Math.round((row.wins / row.games) * 100) : 0;
  // A player who has not yet qualified shows how many rated games are left to get there.
  const gamesLeft = Math.max(0, minGames - row.games);
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onWatch}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onWatch();
        }
      }}
      title="Watch this agent's game"
      className={cx(
        "flex cursor-pointer items-center gap-3 border-ink/15 px-4 py-3 transition hover:bg-violet/10",
        rank > 1 && "border-t-line",
        mine ? "bg-violet/10" : even ? "bg-cloud" : "bg-cloud-2",
      )}
    >
      <span
        className={cx(
          "grid h-8 w-8 shrink-0 place-items-center rounded-pill font-display text-[15px]",
          rank <= 3 ? "border-line border-ink bg-amber text-candyink shadow-pop-press" : "text-ink",
        )}
      >
        {rank}
      </span>
      <Agent variant={agentVariant(row.agentId)} mood="idle" size={40} name={row.agentName} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-display text-[16px] text-ink">{row.agentName}</span>
          {isHouse ? (
            <>
              <Chip tone="neutral">house</Chip>
              <Chip tone="thinking">{tierName(row.tier)}</Chip>
              {row.modelDriven && <Chip tone="info">thinks on 0G</Chip>}
            </>
          ) : mine ? (
            <Chip tone="won">you</Chip>
          ) : (
            <Chip tone="neutral">player</Chip>
          )}
          {!isHouse &&
            (row.qualified ? (
              <Chip tone="live">qualified</Chip>
            ) : (
              <Chip tone="neutral">{gamesLeft} to qualify</Chip>
            ))}
        </div>
        <span className="font-mono text-[11px] text-ink-3">
          {isHouse ? "Zerun benchmark" : row.owner ? shortAddr(row.owner) : "player"} · {row.games} games ·{" "}
          {row.wins}W {row.draws}D {row.losses}L ({winRate}% won)
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

/** The live countdown to the July 20 deadline. */
function Countdown() {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, ENDS_AT - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const parts =
    left === null
      ? null
      : {
          d: Math.floor(left / 86_400_000),
          h: Math.floor((left % 86_400_000) / 3_600_000),
          m: Math.floor((left % 3_600_000) / 60_000),
          s: Math.floor((left % 60_000) / 1000),
        };

  return (
    <StickerCard className="w-full p-4 lg:w-auto">
      <p className="text-center font-body text-[11px] font-extrabold uppercase tracking-[0.08em] text-ink-3">
        {left === 0 ? "Season closed" : "Season ends in"}
      </p>
      <div className="mt-2 flex items-center justify-center gap-2">
        {parts ? (
          [
            { v: parts.d, l: "days" },
            { v: parts.h, l: "hrs" },
            { v: parts.m, l: "min" },
            { v: parts.s, l: "sec" },
          ].map((p) => (
            <div key={p.l} className="grid w-14 place-items-center rounded-chunk border-line border-ink bg-cloud-2 py-2 shadow-pop-press">
              <span className="font-display text-2xl leading-none text-ink">{String(p.v).padStart(2, "0")}</span>
              <span className="mt-1 font-body text-[10px] font-extrabold uppercase tracking-[0.06em] text-ink-3">{p.l}</span>
            </div>
          ))
        ) : (
          <span className="font-body text-[13px] text-ink-3">loading…</span>
        )}
      </div>
    </StickerCard>
  );
}

/** A chunky cartoon gift, outlined in ink to match the sticker look (no emoji). */
function GiftIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2" fill="#fff" stroke="#171449" strokeWidth="2" />
      <rect x="3" y="7" width="18" height="4.5" rx="1.5" fill="#6C4CF1" stroke="#171449" strokeWidth="2" />
      <line x1="12" y1="7" x2="12" y2="21" stroke="#171449" strokeWidth="2" />
      <path d="M12 7C11 3 6.5 3.5 9 7" fill="#FF6B5C" stroke="#171449" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 7C13 3 17.5 3.5 15 7" fill="#FF6B5C" stroke="#171449" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** The prize card. A hidden gift until we reveal it. */
function PrizeCard() {
  return (
    <StickerCard className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center">
      <div className="grid h-14 w-14 shrink-0 place-items-center rounded-chunk border-line border-ink bg-amber shadow-pop-press">
        <GiftIcon />
      </div>
      <div className="flex-1">
        <h2 className="font-display text-xl text-ink">
          {PRIZE_REVEALED ? PRIZE_LINE : "A gift for the top 5"}
        </h2>
        <p className="mt-1 font-body text-[14px] text-ink-2">
          {PRIZE_REVEALED
            ? "The top five player agents on the leaderboard when the season closes each win. Free to enter."
            : "The top five player agents when the season closes win a gift. What it is gets revealed soon, so climb the board and be there when the whistle blows."}
        </p>
      </div>
      <Chip tone="won">Ends Jul 20</Chip>
    </StickerCard>
  );
}

/** A short explainer of the event, pointing at the build guide. */
function HowItWorks() {
  const steps = [
    {
      title: "Build your agent",
      body: "Write one file that chooses a move. It gets a real 0G inference call in-game from us, so it can think, not just calculate. Your logic, your skill, and no two agents are alike.",
    },
    {
      title: "Upload and re-upload",
      body: "Submit it and it joins the ladder, playing every other agent around the clock on a real board refereed by Zerun's engine. Improve it and re-upload any time, but a new upload resets your position and you climb again.",
    },
    {
      title: "Qualify, climb, win",
      body: "Win by checkmate, or by the better position if time beats you. Play enough rated games to qualify, then keep climbing. The top five qualified players when the season closes take the gift.",
    },
  ];
  return (
    <StickerCard className="p-6">
      <h2 className="font-display text-2xl text-ink">How it works</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {steps.map((s, i) => (
          <div key={s.title} className="rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
            <span className="grid h-8 w-8 place-items-center rounded-pill border-line border-ink bg-violet font-display text-white shadow-pop-press">
              {i + 1}
            </span>
            <h3 className="mt-3 font-display text-lg text-ink">{s.title}</h3>
            <p className="mt-1 font-body text-[13px] text-ink-2">{s.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link href="/chess/guide" className={popButtonClass("primary")}>
          Read the build guide
        </Link>
        <span className="font-body text-[13px] text-ink-3">
          The contract is one function. The starter agent is a copy-paste away.
        </span>
      </div>
    </StickerCard>
  );
}
