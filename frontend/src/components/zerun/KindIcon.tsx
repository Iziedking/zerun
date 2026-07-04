import type { ContestKind } from "@/lib/types";
import { cx } from "./cx";

// Original, on-brand cartoon icons for each contest flavor: a lightbulb for
// puzzles, a crystal ball for predictions, a card-and-spade for poker, and a
// football for the World Cup mission. Flat ink line art on a candy-tinted badge,
// matching the sticker look (chunky outline, hard pop shadow). All original art,
// no third-party logos or marks.

const INK = "#171449";

// The badge fill per flavor. Kept as hex so it can drive an inline style (Tailwind
// cannot see a dynamic class name).
const BADGE_BG: Record<ContestKind, string> = {
  solver: "#36C5FF", // cyan
  analyst: "#6C4CF1", // violet
  poker: "#FF6B5C", // coral
  worldcup: "#1FD6A6", // mint
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
    // Crystal ball on a stand, with a sparkle: a forecast.
    return (
      <svg {...common}>
        <path
          d="M6.7 18.2h10.6l-1.4 2.4H8.1z"
          fill="#fff"
          stroke={INK}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="10.5" r="6" fill="#fff" stroke={INK} strokeWidth="2" />
        <path d="M12 6.6l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill={INK} />
      </svg>
    );
  }
  if (kind === "poker") {
    // A playing card with a spade.
    return (
      <svg {...common}>
        <rect x="6.5" y="4.5" width="11" height="15" rx="2.3" fill="#fff" stroke={INK} strokeWidth="2" />
        <path
          d="M12 7.6c0 1.7 3.4 2.7 3.4 4.8 0 1.3-1.4 2-2.5 1.3.2 1 .7 1.4 1.3 1.8H9.8c.6-.4 1.1-.8 1.3-1.8-1.1.7-2.5 0-2.5-1.3 0-2.1 3.4-3.1 3.4-4.8Z"
          fill={INK}
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
  // solver: a lightbulb (solve it).
  return (
    <svg {...common}>
      <path
        d="M12 3.2a5.4 5.4 0 0 0-3.3 9.7c.5.4.8 1 .8 1.7v.4h5v-.4c0-.7.3-1.3.8-1.7A5.4 5.4 0 0 0 12 3.2Z"
        fill="#fff"
        stroke={INK}
        strokeWidth="2"
        strokeLinejoin="round"
      />
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
