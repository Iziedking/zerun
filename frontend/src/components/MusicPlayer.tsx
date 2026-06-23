"use client";

import { useMusic } from "@/lib/music";
import { cx } from "./zerun/cx";

// A tiny sticker toggle for the arena soundtrack, driven by the shared music
// context so it stays in step with the track started from "Enter the arena".
// Hides itself when no track is present.
export function MusicPlayer({ className = "" }: { className?: string }) {
  const { playing, available, toggle } = useMusic();

  if (!available) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={playing ? "Turn music off" : "Turn music on"}
      aria-pressed={playing}
      className={cx(
        "grid h-9 w-9 shrink-0 place-items-center rounded-pill border-line border-ink shadow-pop-press transition hover:-translate-y-px",
        playing ? "bg-mint" : "bg-cloud",
        className,
      )}
    >
      {playing ? <Bars /> : <Note muted />}
    </button>
  );
}

// Animated equalizer bars while playing.
function Bars() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {[2, 6, 10].map((x, i) => (
        <rect
          key={x}
          x={x}
          y="3"
          width="3"
          height="10"
          rx="1.5"
          fill="#171449"
          className="origin-bottom motion-safe:animate-bob"
          style={{ animationDelay: `${i * 140}ms`, animationDuration: "0.7s" }}
        />
      ))}
    </svg>
  );
}

// A music note, with a slash when off.
function Note({ muted = false }: { muted?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M6 3.5l7-1.5v8.2"
        stroke="#171449"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="4.5" cy="11.5" r="2.2" fill="#171449" />
      <circle cx="11.5" cy="10.5" r="2.2" fill="#171449" />
      {muted && (
        <path d="M2 14L14 2" stroke="#FF6B5C" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}
