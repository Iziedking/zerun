"use client";

import Link from "next/link";
import { Chip, StickerCard, cx } from "./zerun";

// The Zero Cup banner on the arena. Small on purpose: it sits above the board, so it has to
// earn its height in one glance. Trophy, what it is, when it closes, and one way in.
//
// It links to /vote rather than straight to 0G, because a voter who lands on the ballot with an
// empty wallet hits a gas error and leaves. /vote funds them first.

// Where the sparkles sit, relative to the card, and how long each waits before it swells.
// Scattered by hand rather than evenly: a ring of equally spaced stars reads as a loading
// spinner. Three hide on small screens, where the card is nearly full width and they would
// crowd the text.
const STARS = [
  { top: "-18px", left: "1%", size: 26, delay: "0s", tone: "text-amber" },
  { top: "-26px", left: "27%", size: 18, delay: "0.7s", tone: "text-cyan", hideSm: true },
  { top: "-13px", left: "63%", size: 21, delay: "1.4s", tone: "text-violet", hideSm: true },
  { top: "-21px", right: "4%", size: 24, delay: "0.35s", tone: "text-amber" },
  { bottom: "-18px", left: "8%", size: 21, delay: "1.1s", tone: "text-mint" },
  { bottom: "-24px", left: "47%", size: 17, delay: "1.9s", tone: "text-amber", hideSm: true },
  { bottom: "-16px", right: "16%", size: 23, delay: "0.5s", tone: "text-cyan" },
] as const;

export function ZeroCupCard() {
  return (
    <div className="relative">
      {/* Purely decorative. Reduced-motion readers get them stationary rather than absent, so
          nothing shifts, and they never intercept a click meant for the card. */}
      {STARS.map((s, i) => (
        <Star key={i} {...s} />
      ))}

      <Link
        href="/vote"
        className="group block focus:outline-none"
        aria-label="Vote for Zerun in the 2026 0G Zero Cup"
      >
        <StickerCard className="p-4 transition-transform duration-150 ease-spring group-hover:-translate-y-0.5 group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-violet sm:p-5">
          <div className="flex items-center gap-4">
            <Trophy />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-xl leading-tight text-ink sm:text-2xl">Zero Cup 2026</h3>
                <Chip tone="live" pulse>
                  live
                </Chip>
              </div>
              <p className="mt-0.5 font-body text-[13px] font-bold text-ink-2">
                Zerun is in the quarter-finals. We cover the gas, you cast the vote.
              </p>
              <p className="mt-1 font-mono text-[11px] text-ink-3">Jun 15 – Jul 20, 2026</p>
            </div>

            <span className="flex shrink-0 items-center gap-1.5 font-body text-[12px] font-extrabold uppercase tracking-[0.06em] text-violet">
              <span className="hidden sm:inline">Vote</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                aria-hidden
                className="transition-transform duration-150 ease-spring group-hover:translate-x-0.5"
              >
                <path
                  d="M5.5 2.5 L11.5 8 l-6 5.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </div>
        </StickerCard>
      </Link>
    </div>
  );
}

/** A four-point sparkle, outlined in ink so it survives the pale sky behind it. */
function Star({
  size,
  delay,
  tone,
  hideSm,
  ...pos
}: {
  size: number;
  delay: string;
  tone: string;
  hideSm?: boolean;
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ ...pos, animationDelay: delay }}
      className={cx(
        "pointer-events-none absolute z-10 motion-safe:animate-twinkle",
        tone,
        hideSm && "hidden sm:block",
      )}
    >
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path
          d="M12 1.5c.9 5.4 4.2 8.7 9.6 9.6c-5.4.9-8.7 4.2-9.6 9.6c-.9-5.4-4.2-8.7-9.6-9.6c5.4-.9 8.7-4.2 9.6-9.6z"
          fill="currentColor"
          stroke="rgb(var(--ink))"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** A chunky flat trophy, outlined in ink like everything else. Not an emoji: an emoji renders
 *  as whatever font the reader's OS ships, and none of those match a sticker-book page. */
function Trophy() {
  return (
    <span
      className="grid h-12 w-12 shrink-0 place-items-center rounded-chunk border-line border-ink bg-amber shadow-pop-press sm:h-14 sm:w-14"
      aria-hidden
    >
      <svg width="28" height="28" viewBox="0 0 24 24">
        {/* The cup: one shape with a wide mouth, so it still reads as a trophy at 28px. */}
        <path
          d="M6.5 3h11v5.5a5.5 5.5 0 0 1-11 0z"
          fill="rgb(var(--cloud))"
          stroke="rgb(var(--ink))"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* Handles, drawn outside the cup so they never muddy its silhouette. */}
        <path
          d="M6.5 4.6H4a2.6 2.6 0 0 0 2.6 3.9M17.5 4.6H20a2.6 2.6 0 0 1-2.6 3.9"
          fill="none"
          stroke="rgb(var(--ink))"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* Stem, then a base wide enough to sit on. */}
        <path d="M12 14v2.6" fill="none" stroke="rgb(var(--ink))" strokeWidth="2.2" strokeLinecap="round" />
        <path
          d="M8 20.6h8l-1.1-3.4H9.1z"
          fill="rgb(var(--cloud))"
          stroke="rgb(var(--ink))"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
