"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "./zerun/cx";

// A tiny sticker toggle for the arena soundtrack. Off by default (browsers block
// autoplay and it is polite), loops at a low volume, and hides itself if no
// track is present. Drop a track at public/audio/zerun-theme.mp3, or point
// NEXT_PUBLIC_MUSIC_URL at one.
const SRC = process.env.NEXT_PUBLIC_MUSIC_URL || "/audio/zerun-theme.mp3";

export function MusicPlayer({ className = "" }: { className?: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState(false);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    const a = new Audio(SRC);
    a.loop = true;
    a.volume = 0.3;
    a.preload = "auto";
    const onError = () => setAvailable(false);
    a.addEventListener("error", onError);
    audioRef.current = a;
    return () => {
      a.removeEventListener("error", onError);
      a.pause();
      audioRef.current = null;
    };
  }, []);

  const toggle = async () => {
    const a = audioRef.current;
    if (!a) return;
    if (on) {
      a.pause();
      setOn(false);
      return;
    }
    try {
      await a.play();
      setOn(true);
    } catch {
      // No track, or the browser blocked playback.
      setAvailable(false);
    }
  };

  if (!available) return null;

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      aria-label={on ? "Turn music off" : "Turn music on"}
      aria-pressed={on}
      className={cx(
        "grid h-9 w-9 shrink-0 place-items-center rounded-pill border-line border-ink shadow-pop-press transition hover:-translate-y-px",
        on ? "bg-mint" : "bg-cloud",
        className,
      )}
    >
      {on ? <Bars /> : <Note muted />}
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
