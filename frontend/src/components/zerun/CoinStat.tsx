import { type ReactNode } from "react";
import { StickerCard } from "./StickerCard";
import { cx } from "./cx";

type Token = "coin" | "star" | "none";

// A metric on a sticker: a small coin or star, a big Baloo numeral, a caption.
export function CoinStat({
  value,
  caption,
  token = "coin",
  suffix,
  className = "",
}: {
  value: ReactNode;
  caption: string;
  token?: Token;
  suffix?: string;
  className?: string;
}) {
  return (
    <StickerCard className={cx("p-4 sm:p-5", className)}>
      <div className="flex items-center gap-2 sm:gap-3">
        {token !== "none" && <TokenMark token={token} />}
        <div className="min-w-0">
          {/* The numeral itself never breaks mid-token (so "24,690" cannot render as
              "24,69 0"), but the suffix may wrap under it on a narrow card rather than
              clip past the edge. Numbers are tabular so they stay tidy. */}
          <div className="font-display text-[18px] leading-none text-ink tabular-nums sm:text-[32px] lg:text-4xl">
            <span className="whitespace-nowrap">{value}</span>
            {suffix && (
              <span className="ml-1 whitespace-nowrap text-[11px] font-body font-extrabold text-ink-2 sm:ml-1.5 sm:text-sm">
                {suffix}
              </span>
            )}
          </div>
          <div className="mt-1 font-body text-[11px] font-extrabold uppercase leading-tight tracking-[0.02em] text-ink-2 sm:text-[12px]">
            {caption}
          </div>
        </div>
      </div>
    </StickerCard>
  );
}

function TokenMark({ token }: { token: Token }) {
  return (
    <span
      aria-hidden
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-line border-ink bg-amber shadow-pop-press sm:h-10 sm:w-10"
    >
      {token === "coin" ? (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="5.5" stroke="#171449" strokeWidth="2.2" />
          <path d="M9 5.5v7M6.6 7.2h3.2a1.4 1.4 0 0 1 0 2.8H7" stroke="#171449" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M9 2.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L9 12.3 5.3 14.3l.7-4.3-3.1-3 4.3-.6L9 2.5z"
            stroke="#171449"
            strokeWidth="2"
            strokeLinejoin="round"
            fill="#FFFFFF"
          />
        </svg>
      )}
    </span>
  );
}
