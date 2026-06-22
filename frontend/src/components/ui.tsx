import type { ReactNode } from "react";
import { cx } from "./zerun/cx";

// A small chunky spinner used inside buttons during pending transactions.
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block h-4 w-4 animate-spin rounded-full border-[3px] border-current border-t-transparent",
        className,
      )}
      aria-hidden
    />
  );
}

// Small label/value stack, used in the contest header.
export function StatChip({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
        {label}
      </span>
      <span
        className={cx(
          "text-ink",
          mono ? "font-mono text-[13px]" : "font-display text-lg",
        )}
      >
        {value}
      </span>
    </div>
  );
}
