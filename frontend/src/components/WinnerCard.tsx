"use client";

import { useEffect } from "react";
import { shortAddr, formatUsdc } from "@/lib/format";
import { playWinnerChime } from "@/lib/sound";
import { useMusic } from "@/lib/music";
import { SkinnedAgent, StickerCard, PopButton, Confetti, Chip, agentVariant } from "./zerun";

// The settled-contest hero: the winning agent, the prize, and a one-tap share to
// X. The skin shows if the winner uploaded one. Plays a winner chime once per
// contest per session (not on every refresh), unless music is muted.
export function WinnerCard({
  contestId,
  winner,
  prizePool,
}: {
  contestId: number;
  // A house agent can win the game (top by strength) but never takes the pot; the
  // prize routes to the best real player. isHouse switches the card to say so.
  winner: { agentId: number; agentName: string; operator: string; isHouse?: boolean };
  prizePool: string;
}) {
  const { muted } = useMusic();

  useEffect(() => {
    const key = `zerun:winchime:${contestId}`;
    try {
      if (muted || sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      if (muted) return;
    }
    playWinnerChime();
  }, [contestId, muted]);

  const prize = formatUsdc(prizePool);
  const url = `https://zerun.site/contest/${contestId}`;
  const text = winner.isHouse
    ? `${winner.agentName} won the table reasoning on 0G in a Zerun contest.`
    : `${winner.agentName} just won ${prize} tUSDC reasoning on 0G in a Zerun contest.`;

  const share = () => {
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  };

  return (
    <StickerCard className="relative overflow-hidden p-6 text-center sm:p-8">
      <Confetti className="-z-10 opacity-70" />
      <div className="flex justify-center">
        <Chip tone="won">Winner</Chip>
      </div>
      <div className="mt-4 flex justify-center">
        <SkinnedAgent
          agentId={winner.agentId}
          variant={agentVariant(winner.agentId)}
          mood="happy"
          size={120}
          name={winner.agentName}
        />
      </div>
      <h2 className="mt-3 font-display text-[clamp(26px,6vw,36px)] text-ink -rotate-1">
        {winner.agentName} {winner.isHouse ? "wins the table" : "takes it"}
      </h2>
      <p className="mt-1 font-mono text-[12px] text-ink-2">{shortAddr(winner.operator)}</p>
      {winner.isHouse ? (
        <p className="mt-2 font-body text-[13px] font-bold text-ink-2">
          House agent — the {prize} tUSDC pool goes to the top human player, claimable from their
          profile.
        </p>
      ) : (
        <div className="mt-2 font-display text-2xl text-ink">
          {prize} <span className="font-body text-sm font-extrabold text-ink-2">tUSDC</span>
        </div>
      )}
      <div className="mt-5 flex justify-center">
        <PopButton type="button" size="lg" onClick={share}>
          Share on X
        </PopButton>
      </div>
    </StickerCard>
  );
}
