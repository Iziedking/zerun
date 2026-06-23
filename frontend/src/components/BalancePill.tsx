"use client";

import { useAccount } from "wagmi";
import { useUsdcBalance } from "@/lib/useChainData";

// The operator's test-USDC balance as a chunky coin pill in the top bar. Coins
// earned in onboarding and contests show up here.
export function BalancePill({ className = "" }: { className?: string }) {
  const { address } = useAccount();
  const { formatted } = useUsdcBalance(address);

  return (
    <span
      className={`items-center gap-2 rounded-pill border-line border-ink bg-cloud px-3 py-1.5 shadow-pop-press ${className}`}
    >
      <span
        aria-hidden
        className="grid h-5 w-5 place-items-center rounded-full border-2 border-ink bg-amber"
      >
        <svg width="11" height="11" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="5.5" stroke="#171449" strokeWidth="2.4" />
          <path
            d="M9 5.5v7M6.6 7.2h3.2a1.4 1.4 0 0 1 0 2.8H7"
            stroke="#171449"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="font-display text-[15px] leading-none text-ink">{formatted}</span>
      <span className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
        tUSDC
      </span>
    </span>
  );
}
