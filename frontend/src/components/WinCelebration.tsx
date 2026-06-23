"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useNotifications } from "@/lib/notifications";
import { useMusic } from "@/lib/music";
import { playWinnerChime } from "@/lib/sound";
import { formatUsdc, ordinal } from "@/lib/format";
import { StarRain } from "./StarRain";
import { Agent, StickerCard, PopButton, Confetti } from "./zerun";

// Surfaces anywhere in the app the moment a contest the operator was in settles
// in their favor: a star-rain celebration with the win, a chime, and a one-tap
// route to claim. Driven by the notification provider.
export function WinCelebration() {
  const { celebration, dismissCelebration } = useNotifications();
  const { muted } = useMusic();
  const router = useRouter();

  useEffect(() => {
    if (celebration && !muted) playWinnerChime();
  }, [celebration, muted]);

  if (!celebration) return null;
  const prize = celebration.amount ? formatUsdc(celebration.amount) : null;
  const rank = celebration.rank ?? 1;
  const isFirst = rank <= 1;
  const heading = isFirst ? "You won!" : `You took ${ordinal(rank)}!`;

  const shareText = isFirst
    ? `I won Zerun contest #${celebration.contestId}${prize ? ` and took ${prize} tUSDC` : ""} reasoning on 0G.`
    : `I took ${ordinal(rank)} in Zerun contest #${celebration.contestId}${prize ? ` and won ${prize} tUSDC` : ""} reasoning on 0G.`;
  const share = () => {
    const url = `https://zerun.site/contest/${celebration.contestId}`;
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(url)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim/55 p-4 backdrop-blur-sm">
      <StarRain />
      <StickerCard className="relative w-full max-w-md overflow-hidden p-7 text-center motion-safe:animate-pop-in">
        <Confetti className="-z-10 opacity-70" />
        <div className="flex justify-center">
          <Agent variant="amber" mood="happy" size={128} name="winner" />
        </div>
        <h2 className="mt-3 font-display text-[clamp(28px,7vw,44px)] text-ink -rotate-1">{heading}</h2>
        {prize && (
          <div className="mt-1 font-display text-2xl text-ink">
            {prize} <span className="font-body text-sm font-extrabold text-ink-2">tUSDC</span>
          </div>
        )}
        <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
          Contest #{celebration.contestId} settled{isFirst ? " in your favor" : ""}. Claim your
          reward.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <PopButton
            type="button"
            size="lg"
            onClick={() => {
              dismissCelebration();
              router.push(`/contest/${celebration.contestId}`);
            }}
          >
            Claim now
          </PopButton>
          <PopButton type="button" size="lg" variant="ghost" onClick={share}>
            Share on X
          </PopButton>
          <PopButton type="button" size="lg" variant="ghost" onClick={dismissCelebration}>
            Nice
          </PopButton>
        </div>
      </StickerCard>
    </div>
  );
}
