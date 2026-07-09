"use client";

import { useState } from "react";
import { cx } from "./zerun/cx";

// The loading curtain: the Zerun Z tile bouncing like a sticker dropped on the page, the
// wordmark beneath it, and a chunky progress line that fills. The first load also carries
// "Built on 0G"; a route change does not, because repeating the credit every time you click
// Ladder turns a statement into wallpaper.

/** The 0G mark, when the asset is present. Falls back to nothing rather than a broken image. */
function ZeroGMark({ size = 18 }: { size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/0g-mark.svg"
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className="opacity-70"
    />
  );
}

export function ZerunLoader({
  built = false,
  className = "",
}: {
  /** Show the "Built on 0G" credit. First load only. */
  built?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "fixed inset-0 z-[100] flex flex-col items-center justify-center bg-sky",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading Zerun</span>

      {/* The Z tile, bouncing. `motion-safe` keeps it still for anyone who asked for that. */}
      <span
        aria-hidden
        className={cx(
          "grid h-20 w-20 place-items-center rounded-chunk-lg border-line border-ink bg-violet shadow-pop",
          "motion-safe:animate-loader-bounce",
        )}
      >
        <span className="font-display text-[46px] font-extrabold leading-none text-white">Z</span>
      </span>

      {/* Its shadow, squashing in time with the bounce, so the tile reads as landing on something. */}
      <span
        aria-hidden
        className="mt-3 h-1.5 w-12 rounded-pill bg-ink/20 opacity-25 motion-safe:animate-loader-shadow"
      />

      <span className="mt-5 font-display text-[26px] font-extrabold tracking-[0.06em] text-ink">ZERUN</span>

      {/* A chunky sticker progress line, filling once. */}
      <span
        aria-hidden
        className="relative mt-5 h-2.5 w-40 overflow-hidden rounded-pill border-line border-ink bg-cloud shadow-pop-press"
      >
        <span className="absolute inset-y-0 left-0 w-full origin-left rounded-pill bg-violet motion-safe:animate-loader-fill motion-reduce:scale-x-100" />
      </span>

      {built && (
        <span className="mt-6 inline-flex items-center gap-2 font-body text-[12px] font-extrabold uppercase tracking-[0.08em] text-ink-3">
          <ZeroGMark />
          Built on 0G
        </span>
      )}
    </div>
  );
}
