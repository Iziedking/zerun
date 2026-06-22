import Link from "next/link";

// The Zerun wordmark: a precise mark with the leading glyph carrying the signal.
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`group inline-flex items-center gap-2.5 ${className}`}
      aria-label="Zerun home"
    >
      <span className="relative grid h-7 w-7 place-items-center rounded-[7px] border border-signal/50 bg-ink-700">
        <span className="absolute inset-0 rounded-[7px] bg-signal/10 blur-[6px]" aria-hidden />
        <span className="relative font-mono text-[15px] font-600 leading-none text-signal">
          0
        </span>
      </span>
      <span className="text-[17px] font-600 tracking-[0.04em] text-bone">
        Zerun
      </span>
    </Link>
  );
}
