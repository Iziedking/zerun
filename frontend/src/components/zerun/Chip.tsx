import { type ReactNode } from "react";
import { cx } from "./cx";

export type ChipTone =
  | "live"
  | "thinking"
  | "won"
  | "hot"
  | "info"
  | "neutral";

// Status pill: ink text on a candy fill, ink outline, small pop, a leading dot.
// Use white text only on coral (hot) for contrast; ink reads fine on the rest.
const TONES: Record<ChipTone, { fill: string; text: string; dot: string }> = {
  live: { fill: "bg-mint", text: "text-ink", dot: "bg-ink" },
  thinking: { fill: "bg-cyan", text: "text-ink", dot: "bg-ink" },
  won: { fill: "bg-amber", text: "text-ink", dot: "bg-ink" },
  hot: { fill: "bg-coral", text: "text-white", dot: "bg-white" },
  info: { fill: "bg-cloud", text: "text-ink", dot: "bg-violet" },
  neutral: { fill: "bg-cloud-2", text: "text-ink-2", dot: "bg-ink-3" },
};

export function Chip({
  tone = "neutral",
  children,
  pulse = false,
  className = "",
}: {
  tone?: ChipTone;
  children: ReactNode;
  /** Soft blink on the leading dot (e.g. when live). */
  pulse?: boolean;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-pill border-line border-ink px-3 py-1",
        "font-body text-[12px] font-extrabold uppercase tracking-[0.02em]",
        "shadow-pop-press",
        t.fill,
        t.text,
        className,
      )}
    >
      <span
        aria-hidden
        className={cx(
          "inline-block h-2 w-2 rounded-full",
          t.dot,
          pulse && "motion-safe:animate-pulse",
        )}
      />
      {children}
    </span>
  );
}
