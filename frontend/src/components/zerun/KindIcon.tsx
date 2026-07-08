import type { ContestKind } from "@/lib/types";
import { cx } from "./cx";

// Original, on-brand cartoon icons for each contest flavor, grounded in the
// reference direction: a lightbulb full of puzzle pieces (puzzles), a figure
// reading a rising bar chart (predictions), a fan of cards with a chip (poker),
// and a football (World Cup). Flat ink line art on a candy-tinted sticker badge.
// All original art, no third-party logos or marks.

const INK = "#171449";
const AMBER = "#FFB13C";

// A small jigsaw piece (0..10 box), reused inside the puzzle bulb.
const PIECE =
  "M2 2h2.2a1.3 1.3 0 1 1 2.6 0H9v2.2a1.3 1.3 0 1 0 0 2.6V9H6.8a1.3 1.3 0 1 1-2.6 0H2V6.8a1.3 1.3 0 1 0 0-2.6z";

const BADGE_BG: Record<ContestKind, string> = {
  solver: "#36C5FF", // cyan
  analyst: "#6C4CF1", // violet
  poker: "#FF6B5C", // coral
  worldcup: "#1FD6A6", // mint
  chess: "#FFB13C", // amber
};

export function KindIcon({ kind, size = 22 }: { kind: ContestKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    "aria-hidden": true as const,
  };
  if (kind === "analyst") {
    // A figure reading a rising bar chart: a forecast.
    return (
      <svg {...common}>
        <rect x="4.4" y="13" width="3.4" height="6" rx="0.6" fill="#fff" stroke={INK} strokeWidth="1.7" />
        <rect x="9.2" y="10" width="3.4" height="9" rx="0.6" fill="#fff" stroke={INK} strokeWidth="1.7" />
        <rect x="14" y="6.6" width="3.4" height="12.4" rx="0.6" fill="#fff" stroke={INK} strokeWidth="1.7" />
        <path d="M3.4 19.4h17.2" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="15.7" cy="3.9" r="1.3" fill={INK} />
        <path d="M14.8 6.5l.9-1.3 .9 1.3z" fill={INK} />
      </svg>
    );
  }
  if (kind === "poker") {
    // A chip peeking behind a fan of two cards, one showing a spade.
    return (
      <svg {...common}>
        <circle cx="12" cy="8.2" r="4.2" fill="#fff" stroke={INK} strokeWidth="1.7" />
        <circle cx="12" cy="8.2" r="1.9" fill="none" stroke={INK} strokeWidth="1.2" />
        <path d="M12 3.8v1.3M12 11.3v1.3M8.2 8.2h1.3M14.5 8.2h1.3" stroke={INK} strokeWidth="1.3" strokeLinecap="round" />
        <rect x="5.6" y="10.4" width="7" height="9.6" rx="1.4" fill="#fff" stroke={INK} strokeWidth="1.7" transform="rotate(-11 9.1 15.2)" />
        <rect x="11.4" y="10.4" width="7" height="9.6" rx="1.4" fill="#fff" stroke={INK} strokeWidth="1.7" transform="rotate(11 14.9 15.2)" />
        <path
          d="M15 12.8c0 1.1 2.1 1.7 2.1 3 0 .8-.9 1.2-1.6.8.1.6.4.9.8 1.1h-2.6c.4-.2.7-.5.8-1.1-.7.4-1.6 0-1.6-.8 0-1.3 2.1-1.9 2.1-3Z"
          fill={INK}
          transform="rotate(11 14.9 15.2)"
        />
      </svg>
    );
  }
  if (kind === "worldcup") {
    // A football: a circle with a central pentagon and five seams. Original art.
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="7.6" fill="#fff" stroke={INK} strokeWidth="2" />
        <path d="M12 8.1l3.3 2.4-1.3 3.9H10l-1.3-3.9z" fill={INK} />
        <path
          d="M12 8.1V4.6M15.3 10.5l3-1.1M14 14.4l1.9 2.6M10 14.4l-1.9 2.6M8.7 10.5l-3-1.1"
          stroke={INK}
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === "chess") {
    // A chess pawn: a round head over a flared base on a plinth. Original art.
    return (
      <svg {...common}>
        <circle cx="12" cy="6.6" r="2.7" fill="#fff" stroke={INK} strokeWidth="1.7" />
        <path
          d="M9.4 10.2c0 1.2 1.1 1.6 1.1 2.7L9.2 17.2h5.6l-1.3-4.3c0-1.1 1.1-1.5 1.1-2.7z"
          fill="#fff"
          stroke={INK}
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path d="M7.6 19.6h8.8" stroke={INK} strokeWidth="2" strokeLinecap="round" />
        <path d="M9.4 10.2h5.2" stroke={INK} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  // solver: a lightbulb full of puzzle pieces (solve it).
  return (
    <svg {...common}>
      <path
        d="M12 3.2a5.4 5.4 0 0 0-3.3 9.7c.5.4.8 1 .8 1.7v.4h5v-.4c0-.7.3-1.3.8-1.7A5.4 5.4 0 0 0 12 3.2Z"
        fill="#fff"
        stroke={INK}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d={PIECE} fill={AMBER} stroke={INK} strokeWidth="1.3" transform="translate(6.8 5) scale(0.82)" />
      <path d={PIECE} fill={AMBER} stroke={INK} strokeWidth="1.9" transform="translate(15.4 1.6) scale(0.48)" />
      <path d="M9.7 17.3h4.6M10.5 19.7h3" stroke={INK} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// The icon in a candy-tinted, ink-outlined sticker badge. Use on cards, headers,
// and the flavor picker for a consistent, classy per-flavor mark.
export function KindBadge({
  kind,
  size = 44,
  className,
}: {
  kind: ContestKind;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center rounded-chunk border-line border-ink shadow-pop-press",
        className,
      )}
      style={{ width: size, height: size, background: BADGE_BG[kind] }}
    >
      <KindIcon kind={kind} size={Math.round(size * 0.6)} />
    </span>
  );
}
