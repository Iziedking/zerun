import { cx } from "./cx";

// The winner's crown. A flat amber sticker with an ink outline and three round jewels,
// drawn rather than typed: an emoji renders as whatever font the reader's OS ships, which
// on Windows is a glossy 3D photograph of a crown and on Android is a different one again.
// Neither belongs anywhere near a chunky outlined cartoon.
//
// Sized by `size` (the height in px follows the width), and it inherits nothing from the
// text around it, so it never shifts the baseline of a row it sits in.
export function Crown({
  size = 14,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** Give this when the crown is the ONLY thing saying "winner"; omit when text already does. */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* The band and the three points, one path, so the ink outline is continuous. */}
      <path
        d="M3.4 17.2 L2.1 7.4 a0.9 0.9 0 0 1 1.5 -0.8 L7.4 10 L11.1 4.2 a1 1 0 0 1 1.8 0 L16.6 10 l3.8 -3.4 a0.9 0.9 0 0 1 1.5 0.8 l-1.3 9.8 z"
        fill="rgb(var(--amber))"
        stroke="rgb(var(--ink))"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      {/* Jewels on the band. Ink-outlined dots keep them readable at 12px. */}
      <circle cx="7.3" cy="14.4" r="1.15" fill="rgb(var(--coral))" stroke="rgb(var(--ink))" strokeWidth="1" />
      <circle cx="12" cy="14.4" r="1.15" fill="rgb(var(--mint))" stroke="rgb(var(--ink))" strokeWidth="1" />
      <circle cx="16.7" cy="14.4" r="1.15" fill="rgb(var(--cyan))" stroke="rgb(var(--ink))" strokeWidth="1" />
    </svg>
  );
}
