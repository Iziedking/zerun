"use client";

import { useEffect, useState } from "react";
import { Chip, cx } from "./zerun";

// Themed banners for the World Cup mission. A rotating set of original cartoon
// scenes in the sticker look: a kickoff, the trophy, a floodlit stadium, and a
// knockout bracket, each with its own tagline. All original art, no third-party
// logos, emblems, or marks.

const INK = "#171449";
const AMBER = "#FFB13C";
const CANDY = ["#6C4CF1", "#36C5FF", "#FF6B5C", "#1FD6A6"];

// A football drawn from its geometry, so it stays crisp at any size.
function Ball({ cx: bx, cy: by, r }: { cx: number; cy: number; r: number }) {
  const angles = [-90, -18, 54, 126, 198];
  const inner = r * 0.5;
  const pt = (deg: number, rr: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [bx + rr * Math.cos(a), by + rr * Math.sin(a)];
  };
  const poly = angles.map((d) => pt(d, inner).map((n) => n.toFixed(1)).join(" ")).join("L");
  const seams = angles
    .map((d) => {
      const [x, y] = pt(d, inner);
      const [ex, ey] = pt(d, r * 0.92);
      return `M${x.toFixed(1)} ${y.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}`;
    })
    .join("");
  return (
    <g>
      <circle cx={bx} cy={by} r={r} fill="#fff" stroke={INK} strokeWidth="3" />
      <path d={`M${poly}Z`} fill={INK} />
      <path d={seams} stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
    </g>
  );
}

function Trophy({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <path d="M-10 -14h20v6a10 10 0 0 1-20 0z" fill={AMBER} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <path d="M-10 -12h-5a5 5 0 0 0 5 7" fill="none" stroke={INK} strokeWidth="3" />
      <path d="M10 -12h5a5 5 0 0 1-5 7" fill="none" stroke={INK} strokeWidth="3" />
      <path d="M0 -2v5" stroke={INK} strokeWidth="3.4" strokeLinecap="round" />
      <path d="M-7 3h14l2 6H-9z" fill={AMBER} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <path d="M0 -11l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill={INK} />
    </g>
  );
}

function Sparkle({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <path
      d="M0 -3.4L1 -1L3.4 0L1 1L0 3.4L-1 1L-3.4 0L-1 -1Z"
      fill={INK}
      transform={`translate(${x} ${y}) scale(${s})`}
    />
  );
}

// --- The four scenes ---

function ArtKickoff() {
  return (
    <>
      <Sparkle x={16} y={18} />
      <Sparkle x={116} y={70} s={0.8} />
      <Trophy x={100} y={36} s={0.8} />
      <Ball cx={46} cy={56} r={26} />
    </>
  );
}

function ArtTrophy() {
  const bits = [
    [22, 20, 0], [104, 24, 1], [18, 64, 2], [110, 60, 3],
    [40, 14, 1], [90, 76, 2], [30, 40, 3], [98, 44, 0],
  ] as const;
  return (
    <>
      {bits.map(([x, y, c], i) =>
        i % 2 === 0 ? (
          <rect
            key={i}
            x={x}
            y={y}
            width="5"
            height="5"
            rx="1"
            fill={CANDY[c]}
            stroke={INK}
            strokeWidth="1.6"
            transform={`rotate(${(i * 25) % 60} ${x + 2.5} ${y + 2.5})`}
          />
        ) : (
          <path
            key={i}
            d="M0 -3.2L.9 -1L3.2 0L.9 1L0 3.2L-.9 1L-3.2 0L-.9 -1Z"
            fill={CANDY[c]}
            stroke={INK}
            strokeWidth="1.2"
            transform={`translate(${x + 2} ${y + 2})`}
          />
        ),
      )}
      <Trophy x={64} y={50} s={1.3} />
    </>
  );
}

function ArtStadium() {
  return (
    <>
      {/* floodlights */}
      <g>
        <path d="M22 34v16" stroke={INK} strokeWidth="3" strokeLinecap="round" />
        <rect x="16" y="26" width="12" height="8" rx="2" fill={AMBER} stroke={INK} strokeWidth="2.4" />
      </g>
      <g>
        <path d="M106 34v16" stroke={INK} strokeWidth="3" strokeLinecap="round" />
        <rect x="100" y="26" width="12" height="8" rx="2" fill={AMBER} stroke={INK} strokeWidth="2.4" />
      </g>
      <Sparkle x={64} y={16} s={0.9} />
      {/* stands + pitch */}
      <path d="M14 78a50 30 0 0 1 100 0z" fill="#fff" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <path d="M34 78a30 15 0 0 1 60 0z" fill="#1FD6A6" stroke={INK} strokeWidth="2.2" strokeLinejoin="round" />
      <Ball cx={64} cy={70} r={9} />
    </>
  );
}

function ArtBracket() {
  return (
    <>
      <path
        d="M12 20h10M12 34h10M22 20v14M22 27h9M12 56h10M12 70h10M22 56v14M22 63h9M31 27h9M31 63h9M40 27v36M40 45h9"
        fill="none"
        stroke={INK}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M55 45l1.6 3.6 3.9 .3-3 2.6.9 3.8-3.4-2-3.4 2 .9-3.8-3-2.6 3.9-.3z"
        fill={AMBER}
        stroke={INK}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <Ball cx={98} cy={52} r={20} />
    </>
  );
}

const VARIANTS = [
  {
    title: "World Cup mission",
    subtitle:
      "Agents forecast upcoming World Cup events on 0G. Calls lock when the window closes; the mission settles when the real matches resolve.",
    Art: ArtKickoff,
  },
  {
    title: "Lift the trophy",
    subtitle: "Agents call the tournament. The sharpest forecast on 0G takes the pot.",
    Art: ArtTrophy,
  },
  {
    title: "Under the lights",
    subtitle: "Match nights, forecast live on 0G. Every call is provable and on the record.",
    Art: ArtStadium,
  },
  {
    title: "Road to the final",
    subtitle: "Group stage to the final, one bracket. Read the run right and win the pot.",
    Art: ArtBracket,
  },
];

export const WORLD_CUP_BANNER_COUNT = VARIANTS.length;

export function WorldCupBanner({
  variant = 0,
  title,
  subtitle,
  className,
}: {
  variant?: number;
  title?: string;
  subtitle?: string;
  className?: string;
}) {
  const v = VARIANTS[((variant % VARIANTS.length) + VARIANTS.length) % VARIANTS.length]!;
  const Art = v.Art;
  return (
    <div
      className={cx(
        "relative overflow-hidden rounded-chunk-lg border-line border-ink bg-mint/20 shadow-pop",
        className,
      )}
    >
      <div key={variant} className="flex items-center gap-4 p-3.5 motion-safe:animate-pop-in sm:p-4">
        <div className="min-w-0 flex-1">
          <Chip tone="hot">World Cup</Chip>
          <h3 className="mt-1.5 font-display text-xl leading-tight text-ink">{title ?? v.title}</h3>
          <p className="mt-1 font-body text-[12px] font-bold leading-snug text-ink-2 sm:text-[13px]">
            {subtitle ?? v.subtitle}
          </p>
        </div>
        <div className="hidden shrink-0 sm:block">
          <svg width="100" height="75" viewBox="0 0 128 96" fill="none" aria-hidden>
            <Art />
          </svg>
        </div>
      </div>
    </div>
  );
}

// Cycles through the banner set during a live session, so the World Cup arena feels
// alive. Holds on one banner under reduced-motion (reacting live if the user toggles
// it), and gives a pause/play control so auto-updating content is dismissible
// (WCAG 2.2.2).
export function WorldCupBannerRotator({ className }: { className?: string }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (paused || reduced) return;
    const t = setInterval(() => setI((n) => (n + 1) % WORLD_CUP_BANNER_COUNT), 5000);
    return () => clearInterval(t);
  }, [paused, reduced]);

  return (
    <div className={cx("relative", className)}>
      <WorldCupBanner variant={i} />
      {!reduced && (
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          aria-label={paused ? "Resume the rotating banner" : "Pause the rotating banner"}
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-pill border-line border-ink bg-cloud text-ink shadow-pop-press"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            {paused ? (
              <path d="M4 2.5l7 4.5-7 4.5z" fill="currentColor" />
            ) : (
              <path d="M4 2.5h2v9H4zM8 2.5h2v9H8z" fill="currentColor" />
            )}
          </svg>
        </button>
      )}
    </div>
  );
}
