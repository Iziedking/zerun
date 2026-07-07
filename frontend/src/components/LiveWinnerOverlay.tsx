"use client";

import { useEffect } from "react";
import type { Standing } from "@/lib/types";
import { shortAddr, formatUsdc } from "@/lib/format";
import { playWinnerChime } from "@/lib/sound";
import { useMusic } from "@/lib/music";
import { StarRain } from "./StarRain";
import { SkinnedAgent, StickerCard, PopButton, Confetti, Chip, agentVariant } from "./zerun";

// The moment a contest settles, this pops for EVERYONE watching it live (not just the
// winner): the winning agent, its prize, a chime, and a one-tap share. Driven by the
// live `settled` WebSocket event in ContestLive, so a spectator sees the win the instant
// it lands rather than waiting for a page refetch. Dismissible; the persistent winner
// hero on the contest page remains after it is closed.
export function LiveWinnerOverlay({
  contestId,
  winner,
  prize,
  onDismiss,
}: {
  contestId: number;
  winner: Standing;
  prize: string | null;
  onDismiss: () => void;
}) {
  const { muted } = useMusic();

  useEffect(() => {
    // Chime once per contest per session, shared with the inline WinnerCard's key so the
    // two never double up.
    const key = `zerun:winchime:${contestId}`;
    try {
      if (muted || sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      if (muted) return;
    }
    playWinnerChime();
  }, [contestId, muted]);

  const url = `https://zerun.site/contest/${contestId}`;
  const text = `${winner.agentName} just won${prize ? ` ${formatUsdc(prize)} tUSDC` : ""} reasoning on 0G in a Zerun contest.`;
  const share = () =>
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      "_blank",
      "noopener,noreferrer",
    );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim/55 p-4 backdrop-blur-sm"
      onClick={onDismiss}
      role="dialog"
      aria-label="Contest winner"
    >
      <StarRain />
      <StickerCard
        className="relative w-full max-w-md overflow-hidden p-7 text-center motion-safe:animate-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        <Confetti className="-z-10 opacity-70" />
        <div className="flex justify-center">
          <Chip tone="won">Winner</Chip>
        </div>
        <div className="mt-4 flex justify-center">
          <SkinnedAgent
            agentId={winner.agentId}
            variant={agentVariant(winner.agentId)}
            mood="happy"
            size={128}
            name={winner.agentName}
          />
        </div>
        <h2 className="mt-3 font-display text-[clamp(26px,6vw,40px)] text-ink -rotate-1">
          {winner.agentName} takes it
        </h2>
        <p className="mt-1 font-mono text-[12px] text-ink-2">{shortAddr(winner.operator)}</p>
        {prize && (
          <div className="mt-2 font-display text-2xl text-ink">
            {formatUsdc(prize)} <span className="font-body text-sm font-extrabold text-ink-2">tUSDC</span>
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <PopButton type="button" size="lg" onClick={share}>
            Share on X
          </PopButton>
          <PopButton type="button" size="lg" variant="ghost" onClick={onDismiss}>
            Nice
          </PopButton>
        </div>
      </StickerCard>
    </div>
  );
}
