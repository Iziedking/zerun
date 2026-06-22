import Link from "next/link";

// The Zerun wordmark: a chunky outlined "0G" sticker tile next to the heavy rounded
// Baloo wordmark, tilted a touch for playfulness.
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`group inline-flex items-center gap-2.5 ${className}`}
      aria-label="Zerun home"
    >
      <span className="grid h-9 w-9 place-items-center rounded-chunk border-line border-ink bg-violet shadow-pop-press">
        <span className="font-display text-[15px] leading-none text-white">0G</span>
      </span>
      <span className="font-display text-[22px] leading-none text-ink -rotate-2">
        Zerun
      </span>
    </Link>
  );
}
