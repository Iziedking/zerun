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

// The Zerun agent character: a friendly hooded blob with a big white face, a
// little antenna bead, and droplet feet. One rounded body, no separate head.
// Variant is the costume color, mood swaps the eyes and mouth. Idle and thinking
// agents gently bob (the weightless 0G float) and blink. Flat filled with an ink
// outline and the pop shadow, no 3D and no gloss.
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
        <path d="M60 22V11" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        <circle cx="60" cy="7.5" r="5" fill={bead} stroke={INK} strokeWidth="3" className="motion-safe:animate-pulse" />

        {/* Side arms, drawn behind the body so they read as little nubs */}
        <ellipse cx="22" cy="70" rx="7" ry="9" fill={fill} stroke={INK} strokeWidth="3.5" transform="rotate(18 22 70)" />
        <ellipse cx="98" cy="70" rx="7" ry="9" fill={fill} stroke={INK} strokeWidth="3.5" transform="rotate(-18 98 70)" />

        {/* Droplet feet, behind the body, peeking out at the bottom */}
        <ellipse cx="47" cy="104" rx="7" ry="9" fill={fill} stroke={INK} strokeWidth="3.5" transform="rotate(-12 47 104)" />
        <ellipse cx="73" cy="104" rx="7" ry="9" fill={fill} stroke={INK} strokeWidth="3.5" transform="rotate(12 73 104)" />

        {/* Body blob: one rounded, bottom-heavy hood */}
        <path
          d="M60 22
             C40 22 30 38 29 56
             C28 78 38 100 60 100
             C82 100 92 78 91 56
             C90 38 80 22 60 22 Z"
          fill={fill}
          stroke={INK}
          strokeWidth="4"
        />

        {/* White face opening */}
        <path
          d="M60 36
             C44 36 37 46 37 58
             C37 72 47 80 60 80
             C73 80 83 72 83 58
             C83 46 76 36 60 36 Z"
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
  const blink =
    mood === "idle" || mood === "thinking"
      ? "motion-safe:[animation:zr-blink_4.5s_infinite]"
      : "";

  if (mood === "lose") {
    // Droopy swirl eyes and a small flat mouth. Cute, never grim.
    return (
      <g>
        <circle cx="51" cy="58" r="5.5" fill="none" stroke={INK} strokeWidth="3" />
        <circle cx="69" cy="58" r="5.5" fill="none" stroke={INK} strokeWidth="3" />
        <path d="M51 58l3-3M69 58l3-3" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M54 70q6-3 12 0" stroke={INK} strokeWidth="3.2" strokeLinecap="round" fill="none" />
      </g>
    );
  }

  if (mood === "happy") {
    // Happy upturned eyes, a big smile, and little sparkles.
    return (
      <g>
        <path d="M45 56q6-6 12 0" stroke={INK} strokeWidth="3.4" strokeLinecap="round" fill="none" />
        <path d="M63 56q6-6 12 0" stroke={INK} strokeWidth="3.4" strokeLinecap="round" fill="none" />
        <path d="M50 64q10 10 20 0" stroke={INK} strokeWidth="3.6" strokeLinecap="round" fill="none" />
        <path d="M30 40l1.6 3.2 3.2 1.6-3.2 1.6L30 51l-1.6-3.2L25.2 46l3.2-1.6L30 40z" fill="#FFB13C" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M90 44l1.3 2.6 2.6 1.3-2.6 1.3L90 53l-1.3-2.6L86.1 49l2.6-1.3L90 44z" fill="#FFB13C" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
      </g>
    );
  }

  // idle and thinking: round blinky eyes and a small smile. Thinking lifts the
  // gaze and flattens the mouth, paired with a ThoughtBubble at the call site.
  const eyeCy = mood === "thinking" ? 56 : 59;
  return (
    <g>
      <g className={blink} style={{ transformOrigin: "60px 58px", transformBox: "fill-box" } as React.CSSProperties}>
        <circle cx="51" cy={eyeCy} r="5.2" fill={INK} />
        <circle cx="69" cy={eyeCy} r="5.2" fill={INK} />
        <circle cx="52.6" cy={eyeCy - 1.6} r="1.5" fill={WHITE} />
        <circle cx="70.6" cy={eyeCy - 1.6} r="1.5" fill={WHITE} />
      </g>
      {mood === "thinking" ? (
        <path d="M54 70h12" stroke={INK} strokeWidth="3.2" strokeLinecap="round" />
      ) : (
        <path d="M53 68q7 5 14 0" stroke={INK} strokeWidth="3.2" strokeLinecap="round" fill="none" />
      )}
    </g>
  );
}
