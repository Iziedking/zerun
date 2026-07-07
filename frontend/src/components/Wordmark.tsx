import Link from "next/link";

// The Zerun wordmark: a chunky outlined "Z" sticker tile next to the rounded
// display wordmark, tilted a touch for playfulness. `wordClassName` lets a caller
// collapse the "Zerun" text on the smallest screens (the app top bar is crowded on
// phones); the Z tile alone still reads as the brand.
export function Wordmark({
  className = "",
  wordClassName = "",
}: {
  className?: string;
  wordClassName?: string;
}) {
  return (
    <Link
      href="/"
      className={`group inline-flex items-center gap-2.5 ${className}`}
      aria-label="Zerun home"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-chunk border-line border-ink bg-violet shadow-pop-press">
        <span className="font-display text-[20px] font-extrabold leading-none text-white">Z</span>
      </span>
      <span className={`font-display text-[22px] font-extrabold leading-none text-ink -rotate-2 ${wordClassName}`}>
        Zerun
      </span>
    </Link>
  );
}
