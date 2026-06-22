import { cx } from "./cx";

// A chunky outlined progress bar with a rounded cap and a soft wobble as it grows.
export function ProgressGoo({
  value,
  fill = "mint",
  label,
  className = "",
}: {
  /** 0 to 1. */
  value: number;
  fill?: "mint" | "violet" | "amber";
  label?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const fills: Record<string, string> = {
    mint: "bg-mint",
    violet: "bg-violet",
    amber: "bg-amber",
  };

  return (
    <div className={className}>
      {label && (
        <div className="mb-1.5 font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
          {label}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-5 w-full overflow-hidden rounded-pill border-line border-ink bg-cloud-2"
      >
        <div
          className={cx(
            "h-full rounded-pill origin-left transition-[width] duration-500 ease-spring motion-safe:[animation:zr-goo_0.5s_ease-out]",
            fills[fill],
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
