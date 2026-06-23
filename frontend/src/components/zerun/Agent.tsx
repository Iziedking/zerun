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

// The Zerun agent character: a friendly screen-faced robot. A white rounded head
// with side ears and an antenna bead, a glowing screen in the variant color
// carrying the eyes and smile, and a domed body with a little settled-coin badge.
// Variant is the screen color, mood swaps the eyes and mouth. Idle and thinking
// agents gently bob (the weightless 0G float) and blink. Flat fills with ink
// outlines and the pop shadow, just a soft screen glow, no 3D.
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

  const motion = mood === "happy" ? "motion-safe:animate-hop" : "motion-safe:animate-bob";

  return (
    <span
      role="img"
      aria-label={label}
      className={cx("inline-block align-bottom", motion, className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 120 120" fill="none" aria-hidden>
        {/* Antenna */}
        <path d="M60 18V10" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        <circle cx="60" cy="6.5" r="4.8" fill={bead} stroke={INK} strokeWidth="3" className="motion-safe:animate-pulse" />

        {/* Ears */}
        <rect x="15" y="33" width="11" height="23" rx="5.5" fill={WHITE} stroke={INK} strokeWidth="3.5" />
        <rect x="94" y="33" width="11" height="23" rx="5.5" fill={WHITE} stroke={INK} strokeWidth="3.5" />

        {/* Domed body with a settled-coin badge, behind the head */}
        <path
          d="M38 104 C38 89 49 82 60 82 C71 82 82 89 82 104 Z"
          fill={WHITE}
          stroke={INK}
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <circle cx="60" cy="95" r="7.5" fill={fill} stroke={INK} strokeWidth="2.6" />
        <path
          d="M60 90.5v9M57.4 92.4h3.4a1.5 1.5 0 0 1 0 3H58.2"
          stroke={WHITE}
          strokeWidth="1.9"
          strokeLinecap="round"
          fill="none"
        />

        {/* Head */}
        <rect x="26" y="18" width="68" height="55" rx="22" fill={WHITE} stroke={INK} strokeWidth="4" />

        {/* Screen */}
        <rect x="35" y="27" width="50" height="36" rx="13" fill={fill} stroke={INK} strokeWidth="3" />
        {/* soft screen glow */}
        <ellipse cx="60" cy="36" rx="19" ry="6.5" fill={WHITE} opacity="0.16" />

        <Face mood={mood} />
      </svg>
    </span>
  );
}

// The face lives on the colored screen, so eyes and mouth glow white.
function Face({ mood }: { mood: AgentMood }) {
  const blink =
    mood === "idle" || mood === "thinking"
      ? "motion-safe:[animation:zr-blink_4.5s_infinite]"
      : "";

  if (mood === "lose") {
    return (
      <g>
        <path d="M47 42q4 4 8 0" stroke={WHITE} strokeWidth="3" strokeLinecap="round" fill="none" />
        <path d="M65 42q4 4 8 0" stroke={WHITE} strokeWidth="3" strokeLinecap="round" fill="none" />
        <path d="M51 56q9-5 18 0" stroke={WHITE} strokeWidth="3" strokeLinecap="round" fill="none" />
      </g>
    );
  }

  if (mood === "happy") {
    return (
      <g>
        <path d="M46 43q4-5 8 0" stroke={WHITE} strokeWidth="3.2" strokeLinecap="round" fill="none" />
        <path d="M66 43q4-5 8 0" stroke={WHITE} strokeWidth="3.2" strokeLinecap="round" fill="none" />
        <path d="M50 50q10 9 20 0" stroke={WHITE} strokeWidth="3.4" strokeLinecap="round" fill="none" />
        <path d="M28 26l1.5 3 3 1.5-3 1.5L28 36l-1.5-3-3-1.5 3-1.5L28 26z" fill="#FFB13C" stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M92 30l1.3 2.6 2.6 1.3-2.6 1.3L92 38l-1.3-2.6-2.6-1.3 2.6-1.3L92 30z" fill="#FFB13C" stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
      </g>
    );
  }

  // idle and thinking: round glowing eyes and a small smile. Thinking lifts the
  // gaze and flattens the mouth, paired with a ThoughtBubble at the call site.
  const eyeCy = mood === "thinking" ? 42 : 44;
  return (
    <g>
      <g className={blink} style={{ transformOrigin: "60px 44px", transformBox: "fill-box" } as React.CSSProperties}>
        <circle cx="50" cy={eyeCy} r="8" fill={WHITE} opacity="0.22" />
        <circle cx="70" cy={eyeCy} r="8" fill={WHITE} opacity="0.22" />
        <circle cx="50" cy={eyeCy} r="4.6" fill={WHITE} />
        <circle cx="70" cy={eyeCy} r="4.6" fill={WHITE} />
      </g>
      {mood === "thinking" ? (
        <path d="M52 55h16" stroke={WHITE} strokeWidth="3" strokeLinecap="round" />
      ) : (
        <path d="M51 53q9 6 18 0" stroke={WHITE} strokeWidth="3" strokeLinecap="round" fill="none" />
      )}
    </g>
  );
}
