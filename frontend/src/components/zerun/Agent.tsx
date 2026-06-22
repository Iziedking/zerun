import { cx } from "./cx";

export type AgentVariant = "violet" | "amber" | "mint" | "cyan" | "coral";
export type AgentMood = "idle" | "thinking" | "happy" | "lose";

const INK = "#171449";
const WHITE = "#FFFFFF";

const FILLS: Record<AgentVariant, string> = {
  violet: "#6C4CF1",
  amber: "#FFB13C",
  mint: "#1FD6A6",
  cyan: "#36C5FF",
  coral: "#FF6B5C",
};

const MOOD_LABEL: Record<AgentMood, string> = {
  idle: "resting",
  thinking: "thinking on 0G",
  happy: "celebrating",
  lose: "tired",
};

// The Zerun agent character: a flat outlined cartoon companion. Big rounded head,
// two blinky eyes, one antenna with a glowing bead, a small body, stubby limbs.
// Variant is the costume color, mood swaps the eyes and mouth. Idle agents bob (the
// weightless 0G float) and blink on a loop. Outlined and flat-filled with a pop
// shadow, no 3D and no glow.
export function Agent({
  variant = "violet",
  mood = "idle",
  size = 120,
  name,
  className = "",
}: {
  variant?: AgentVariant;
  mood?: AgentMood;
  size?: number;
  /** Optional agent name woven into the aria-label. */
  name?: string;
  className?: string;
}) {
  const fill = FILLS[variant];
  const bead = mood === "thinking" ? "#1FD6A6" : variant === "mint" ? "#6C4CF1" : "#1FD6A6";
  const label = name
    ? `Zerun agent ${name}, ${MOOD_LABEL[mood]}`
    : `Zerun agent, ${MOOD_LABEL[mood]}`;

  // Idle and thinking gently bob; the win pose hops once.
  const bob =
    mood === "happy"
      ? "motion-safe:animate-hop"
      : "motion-safe:animate-bob";

  return (
    <span
      role="img"
      aria-label={label}
      className={cx("inline-block align-bottom", bob, className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 120 120"
        fill="none"
        aria-hidden
      >
        {/* Antenna */}
        <path d="M60 26V14" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        <circle
          cx="60"
          cy="11"
          r="5"
          fill={bead}
          stroke={INK}
          strokeWidth="3"
          className="motion-safe:animate-pulse"
        />

        {/* Stubby arms */}
        <path d="M24 70c-8 2-12 8-12 16" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        <path d="M96 70c8 2 12 8 12 16" stroke={INK} strokeWidth="4" strokeLinecap="round" />

        {/* Body */}
        <rect
          x="36"
          y="74"
          width="48"
          height="30"
          rx="13"
          fill={fill}
          stroke={INK}
          strokeWidth="4"
        />
        {/* Stubby legs */}
        <path d="M50 104v8M70 104v8" stroke={INK} strokeWidth="4" strokeLinecap="round" />

        {/* Head */}
        <rect
          x="22"
          y="26"
          width="76"
          height="56"
          rx="22"
          fill={fill}
          stroke={INK}
          strokeWidth="4"
        />
        {/* Face plate */}
        <rect
          x="31"
          y="35"
          width="58"
          height="38"
          rx="15"
          fill={WHITE}
          stroke={INK}
          strokeWidth="3"
        />

        <Face mood={mood} />
      </svg>
    </span>
  );
}

function Face({ mood }: { mood: AgentMood }) {
  // Eyes are a group we can blink (scaleY) for idle and thinking.
  const blink =
    mood === "idle" || mood === "thinking"
      ? "motion-safe:[animation:zr-blink_4.5s_infinite]"
      : "";

  if (mood === "lose") {
    // Swirly tired eyes and a small flat mouth. Cute, never grim.
    return (
      <g>
        <circle cx="48" cy="52" r="6.5" fill="none" stroke={INK} strokeWidth="3" />
        <circle cx="72" cy="52" r="6.5" fill="none" stroke={INK} strokeWidth="3" />
        <path d="M48 52l3-3M72 52l3-3" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
        <path d="M52 66q8-4 16 0" stroke={INK} strokeWidth="3.4" strokeLinecap="round" />
      </g>
    );
  }

  if (mood === "happy") {
    // Big smile and happy upturned eyes, plus little sparkles.
    return (
      <g>
        <path d="M42 50q6-7 12 0" stroke={INK} strokeWidth="3.6" strokeLinecap="round" fill="none" />
        <path d="M66 50q6-7 12 0" stroke={INK} strokeWidth="3.6" strokeLinecap="round" fill="none" />
        <path d="M48 60q12 12 24 0" stroke={INK} strokeWidth="3.8" strokeLinecap="round" fill="none" />
        <path d="M27 30l2 4 4 2-4 2-2 4-2-4-4-2 4-2 2-4z" fill="#FFB13C" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M92 32l1.5 3 3 1.5-3 1.5-1.5 3-1.5-3-3-1.5 3-1.5 1.5-3z" fill="#FFB13C" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
      </g>
    );
  }

  // idle and thinking share blinky round eyes; thinking lifts the gaze up and
  // shows a tiny flat mouth, paired with a ThoughtBubble at the call site.
  const eyeCy = mood === "thinking" ? 50 : 53;
  return (
    <g>
      <g
        className={blink}
        style={{ transformOrigin: "60px 53px", transformBox: "fill-box" } as React.CSSProperties}
      >
        <circle cx="48" cy={eyeCy} r="5.5" fill={INK} />
        <circle cx="72" cy={eyeCy} r="5.5" fill={INK} />
        <circle cx="49.6" cy={eyeCy - 1.6} r="1.6" fill={WHITE} />
        <circle cx="73.6" cy={eyeCy - 1.6} r="1.6" fill={WHITE} />
      </g>
      {mood === "thinking" ? (
        <path d="M52 65h16" stroke={INK} strokeWidth="3.4" strokeLinecap="round" />
      ) : (
        <path d="M52 64q8 5 16 0" stroke={INK} strokeWidth="3.4" strokeLinecap="round" fill="none" />
      )}
    </g>
  );
}
