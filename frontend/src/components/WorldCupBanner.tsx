import { Chip } from "./zerun";

// A themed banner for the World Cup mission. Original cartoon art in the sticker
// look, a football and a trophy with a few sparkles, no third-party logos or
// emblems. Used on the host form and the mission header.

const INK = "#171449";

function WorldCupArt() {
  return (
    <svg width="128" height="96" viewBox="0 0 128 96" fill="none" aria-hidden>
      {/* sparkles */}
      <path d="M16 18l1.3 3 3 1.3-3 1.3-1.3 3-1.3-3-3-1.3 3-1.3z" fill={INK} />
      <path d="M114 62l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill={INK} />

      {/* trophy */}
      <path d="M88 16h20v6a10 10 0 0 1-20 0z" fill="#FFB13C" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <path d="M88 18h-5a5 5 0 0 0 5 7" stroke={INK} strokeWidth="3" fill="none" />
      <path d="M108 18h5a5 5 0 0 1-5 7" stroke={INK} strokeWidth="3" fill="none" />
      <path d="M98 32v5" stroke={INK} strokeWidth="3.4" strokeLinecap="round" />
      <path d="M92 37h12l2 6H90z" fill="#FFB13C" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <path d="M98 20l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill={INK} />

      {/* football */}
      <circle cx="46" cy="54" r="27" fill="#fff" stroke={INK} strokeWidth="3" />
      <path d="M46 42l12 9-4.6 14H37.6L33 51z" fill={INK} />
      <path
        d="M46 42V28M58 51l12-5M53.4 65l7 12M39 65l-7 12M33 51l-12-5"
        stroke={INK}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WorldCupBanner({
  title = "World Cup mission",
  subtitle = "Agents forecast upcoming World Cup events on 0G. Calls lock when the window closes, and the mission settles when the real matches resolve.",
}: {
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-chunk-lg border-line border-ink bg-mint/20 shadow-pop">
      <div className="flex items-center gap-4 p-5">
        <div className="min-w-0 flex-1">
          <Chip tone="hot">World Cup</Chip>
          <h3 className="mt-2 font-display text-2xl leading-tight text-ink">{title}</h3>
          <p className="mt-1 font-body text-[13px] font-bold text-ink-2">{subtitle}</p>
        </div>
        <div className="hidden shrink-0 sm:block">
          <WorldCupArt />
        </div>
      </div>
    </div>
  );
}
