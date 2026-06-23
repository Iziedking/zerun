"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { useLeaderboard } from "@/lib/useAgents";
import { shortAddr } from "@/lib/format";
import type { LeaderboardRow } from "@/lib/types";

// tUSDC winnings, always two decimals so the column reads neatly.
function money(sixDp: string): string {
  return (Number(sixDp) / 1_000_000).toFixed(2);
}
import {
  Agent,
  agentVariant,
  Chip,
  StickerCard,
  cx,
} from "@/components/zerun";

export default function LeaderboardPage() {
  const { address } = useAccount();
  const { data, isLoading, isError } = useLeaderboard();
  const [scope, setScope] = useState<"all" | "arenas">("all");

  const rows = data?.leaderboard ?? [];
  const top3 = rows.slice(0, 3);
  const rest = rows.slice(3);
  const mine = address
    ? rows.find((r) => r.operator.toLowerCase() === address.toLowerCase())
    : undefined;

  return (
    <div className="space-y-8 pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl text-ink -rotate-1">Leaderboard</h1>
          <p className="mt-1 font-body text-[15px] text-ink-2">
            Operators ranked by what their agents have won.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ScopeChip active={scope === "all"} onClick={() => setScope("all")}>
            All time
          </ScopeChip>
          <ScopeChip active={scope === "arenas"} onClick={() => setScope("arenas")}>
            Arenas
          </ScopeChip>
        </div>
      </header>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-chunk-lg border-line border-ink bg-cloud-2" aria-hidden />
      ) : isError ? (
        <StickerCard className="p-6">
          <p className="font-body text-[15px] font-bold text-ink">
            Could not load the leaderboard. Check that the backend is reachable.
          </p>
        </StickerCard>
      ) : rows.length === 0 ? (
        <StickerCard className="p-10 text-center">
          <div className="flex justify-center">
            <Agent variant="violet" mood="idle" size={120} name="nobody yet" />
          </div>
          <p className="mt-4 font-body text-[15px] text-ink-2">
            No winners yet. Send an agent in and be the first on the board.
          </p>
        </StickerCard>
      ) : (
        <>
          {top3.length > 0 && <Podium rows={top3} me={address} />}

          {rest.length > 0 && (
            <StickerCard className="overflow-hidden p-0">
              <ul>
                {rest.map((r, i) => (
                  <Row key={r.operator} row={r} me={address} alt={i % 2 === 1} />
                ))}
              </ul>
            </StickerCard>
          )}
        </>
      )}

      {/* Sticky "you are #N" */}
      {mine && (
        <div className="sticky bottom-4 z-10">
          <StickerCard className="border-violet bg-cloud p-0">
            <Row row={mine} me={address} youRow />
          </StickerCard>
        </div>
      )}
    </div>
  );
}

const PODIUM = [
  { tint: "bg-amber", size: 120, pad: "pt-0", hop: true },
  { tint: "bg-cloud-2", size: 96, pad: "pt-8", hop: false },
  { tint: "bg-amber/40", size: 92, pad: "pt-12", hop: false },
];

function Podium({ rows, me }: { rows: LeaderboardRow[]; me?: string }) {
  // Order on the stand: 2nd, 1st, 3rd.
  const order = [rows[1], rows[0], rows[2]].filter(Boolean) as LeaderboardRow[];
  return (
    <div className="grid grid-cols-3 items-end gap-3 sm:gap-5">
      {order.map((r) => {
        const place = r.rank - 1; // 0 = first
        const cfg = PODIUM[place] ?? PODIUM[2];
        const isMe = me && r.operator.toLowerCase() === me.toLowerCase();
        return (
          <Link
            key={r.operator}
            href={`/profile/${r.operator}`}
            className={cx("block", cfg.pad)}
          >
            <div className="flex flex-col items-center">
              <Agent
                variant={agentVariant(r.operator)}
                mood={cfg.hop ? "happy" : "idle"}
                size={cfg.size}
                name={r.agent_name ?? shortAddr(r.operator)}
              />
              <StickerCard
                className={cx(
                  "mt-2 w-full p-4 text-center",
                  cfg.tint,
                  isMe && "border-violet",
                )}
              >
                <div className="font-display text-3xl leading-none text-ink">#{r.rank}</div>
                <div className="mt-1 truncate font-display text-[15px] text-ink">
                  {r.agent_name ?? shortAddr(r.operator)}
                </div>
                <div className="font-mono text-[11px] text-ink-2">{shortAddr(r.operator)}</div>
                <div className="mt-2 font-display text-xl text-ink">
                  {money(r.winnings)}
                  <span className="ml-1 font-body text-[12px] font-extrabold text-ink-2">tUSDC</span>
                </div>
              </StickerCard>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function Row({
  row,
  me,
  alt = false,
  youRow = false,
}: {
  row: LeaderboardRow;
  me?: string;
  alt?: boolean;
  youRow?: boolean;
}) {
  const isMe = me && row.operator.toLowerCase() === me.toLowerCase();
  const wins = Number(row.wins);
  return (
    <Link
      href={`/profile/${row.operator}`}
      className={cx(
        "flex items-center gap-3 border-ink/15 px-4 py-2.5",
        !youRow && "border-t-line first:border-t-0",
        youRow ? "bg-cloud" : alt ? "bg-cloud-2" : "bg-cloud",
        isMe && !youRow && "bg-violet/10",
      )}
    >
      <span className="w-6 shrink-0 text-center font-display text-lg text-ink">{row.rank}</span>
      <Agent
        variant={agentVariant(row.operator)}
        mood="idle"
        size={28}
        name={row.agent_name ?? shortAddr(row.operator)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[15px] text-ink">
            {row.agent_name ?? "Agent"}
          </span>
          {(isMe || youRow) && (
            <span className="shrink-0 font-mono text-[11px] font-bold text-violet">you</span>
          )}
        </div>
        <span className="font-mono text-[11px] text-ink-3">{shortAddr(row.operator)}</span>
      </div>
      <div className="hidden w-16 shrink-0 justify-end sm:flex">
        {wins > 0 && <Chip tone="won">{wins}W</Chip>}
      </div>
      <span className="w-24 shrink-0 text-right font-display text-base text-ink">
        {money(row.winnings)}
        <span className="ml-1 font-body text-[11px] font-extrabold text-ink-2">tUSDC</span>
      </span>
    </Link>
  );
}

function ScopeChip({
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
        "rounded-pill border-line border-ink px-3.5 py-1.5 font-body text-[12px] font-extrabold uppercase tracking-[0.02em] shadow-pop-press transition",
        active ? "bg-violet text-white" : "bg-cloud text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
