"use client";

import { cx } from "./cx";

// The footer of a paged card: where you are on the left, where you can go on the right.
//
// It reads as a sentence rather than as a widget, and the totals tell you how much there is
// before you have clicked anything. The arrows CLAMP rather than wrap: "page 1 of 9" promises
// an end, so the control that would step past it goes dead instead of teleporting you back to
// the start.

export function Pager({
  page,
  total,
  onGo,
  noun = "item",
  nouns,
  count,
  className,
}: {
  /** Zero-indexed. */
  page: number;
  /** How many pages exist. */
  total: number;
  /** Step by +1 or -1. The caller clamps. */
  onGo: (delta: number) => void;
  /** What the things are called, singular. */
  noun?: string;
  /** The plural, when a trailing "s" will not do it ("memory" -> "memories"). */
  nouns?: string;
  /** How many things there are in total. Omit to show only the page count. */
  count?: number;
  className?: string;
}) {
  if (total <= 1) return null;
  return (
    <div
      className={cx(
        "mt-5 flex items-center justify-between gap-3 border-t-line border-ink/10 pt-4",
        className,
      )}
    >
      <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink-3">
        Page {page + 1} of {total}
        {count !== undefined && (
          <>
            {" · "}
            {count} {count === 1 ? noun : (nouns ?? `${noun}s`)}
          </>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <ArrowButton dir="back" onClick={() => onGo(-1)} disabled={page === 0} />
        <ArrowButton dir="forward" onClick={() => onGo(1)} disabled={page === total - 1} />
      </div>
    </div>
  );
}

function ArrowButton({
  dir,
  onClick,
  disabled,
}: {
  dir: "back" | "forward";
  onClick: () => void;
  disabled: boolean;
}) {
  const back = dir === "back";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={back ? "Previous page" : "Next page"}
      className={cx(
        "grid h-10 w-10 place-items-center rounded-pill border-line border-ink text-ink",
        // The same squish as PopButton: it pushes into the page, shadow and all.
        "transition-[transform,box-shadow,opacity] duration-150 ease-spring",
        disabled
          ? "cursor-not-allowed bg-cloud-2 opacity-40 shadow-pop-press"
          : cx(
              "bg-cloud shadow-pop",
              "hover:-translate-x-px hover:-translate-y-px hover:shadow-pop-lg",
              "active:translate-x-[2px] active:translate-y-[2px] active:shadow-pop-press",
            ),
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
      )}
    >
      {/* A fat, round-capped chevron: the same ink stroke as everything else on the page. */}
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={back ? "" : "rotate-180"}>
        <path
          d="M10.5 2.5 L4.5 8 l6 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Page a list, clamped, and keep the reader on a page that still exists when the list shrinks
 * or grows underneath them (a live feed does exactly that).
 */
export function usePaged<T>(items: T[], perPage: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  return { totalPages, perPage, sliceFor: (page: number) => items.slice(page * perPage, page * perPage + perPage) };
}
