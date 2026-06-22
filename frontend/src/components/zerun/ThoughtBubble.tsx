import { type ReactNode } from "react";
import { cx } from "./cx";

// The signature Zerun element. A rounded thought bubble with little trailing dots
// toward the agent, showing what it is doing (thinking on 0G, an answer, a line of
// reasoning). When `thinking`, it shows three animated dots instead of children.
export function ThoughtBubble({
  children,
  thinking = false,
  tone = "cloud",
  tail = "left",
  className = "",
}: {
  children?: ReactNode;
  thinking?: boolean;
  tone?: "cloud" | "violet" | "mint" | "cyan";
  tail?: "left" | "right" | "none";
  className?: string;
}) {
  const tones: Record<string, string> = {
    cloud: "bg-cloud text-ink",
    violet: "bg-violet text-white",
    mint: "bg-mint text-ink",
    cyan: "bg-cyan text-ink",
  };
  const dotColor = tone === "violet" ? "bg-white" : "bg-ink";

  return (
    <div className={cx("relative inline-block max-w-full", className)}>
      <div
        className={cx(
          "rounded-chunk border-line border-ink px-4 py-3 shadow-pop font-body text-[14px] font-bold leading-snug",
          "motion-safe:animate-pop-in",
          tones[tone],
        )}
      >
        {thinking ? (
          <span className="inline-flex items-center gap-1.5" aria-label="thinking">
            <Dot delay="0ms" color={dotColor} />
            <Dot delay="160ms" color={dotColor} />
            <Dot delay="320ms" color={dotColor} />
          </span>
        ) : (
          children
        )}
      </div>
      {/* Trailing dots toward the agent. */}
      {tail !== "none" && (
        <span
          aria-hidden
          className={cx(
            "absolute -bottom-2 flex gap-1",
            tail === "left" ? "left-5" : "right-5",
          )}
        >
          <span className={cx("h-2.5 w-2.5 rounded-full border-line border-ink", tones[tone])} />
          <span className={cx("h-1.5 w-1.5 self-end rounded-full border-line border-ink", tones[tone])} />
        </span>
      )}
    </div>
  );
}

function Dot({ delay, color }: { delay: string; color: string }) {
  return (
    <span
      className={cx("inline-block h-2 w-2 rounded-full", color)}
      style={{ animation: "zr-dots 1.2s infinite both", animationDelay: delay }}
    />
  );
}
