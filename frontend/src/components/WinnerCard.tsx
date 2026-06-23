"use client";

import { shortAddr, formatUsdc } from "@/lib/format";
import { SkinnedAgent, StickerCard, PopButton, Confetti, Chip, agentVariant } from "./zerun";

// The settled-contest hero: the winning agent, the prize, and a one-tap share to
// X. The skin shows if the winner uploaded one.
export function WinnerCard({
  contestId,
  winner,
  prizePool,
}: {
  contestId: number;
  winner: { agentId: number; agentName: string; operator: string };
  prizePool: string;
}) {
  const prize = formatUsdc(prizePool);
  const url = `https://zerun.site/contest/${contestId}`;
  const text = `${winner.agentName} just won ${prize} tUSDC reasoning on 0G in a Zerun contest.`;

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
        {winner.agentName} takes it
      </h2>
      <p className="mt-1 font-mono text-[12px] text-ink-2">{shortAddr(winner.operator)}</p>
      <div className="mt-2 font-display text-2xl text-ink">
        {prize} <span className="font-body text-sm font-extrabold text-ink-2">tUSDC</span>
      </div>
      <div className="mt-5 flex justify-center">
        <PopButton type="button" size="lg" onClick={share}>
          Share on X
        </PopButton>
      </div>
    </StickerCard>
  );
}
