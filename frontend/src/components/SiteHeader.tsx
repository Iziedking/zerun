"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { Wordmark } from "./Wordmark";
import { ConnectButton } from "./ConnectButton";
import { ComputeBadge } from "./ComputeBadge";
import { cx } from "./zerun/cx";

const NAV = [
  { href: "/arena", label: "Arena" },
  { href: "/demo", label: "Demo" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { isConnected } = useAccount();

  return (
    <header className="sticky top-0 z-40 border-b-line border-ink bg-sky/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <div className="flex items-center gap-5">
          <Wordmark />
          {isConnected && (
            <nav className="hidden items-center gap-2 sm:flex">
              {NAV.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cx(
                      "rounded-pill border-line px-3.5 py-1.5 font-body text-sm font-extrabold transition",
                      active
                        ? "border-ink bg-violet text-white shadow-pop-press"
                        : "border-transparent text-ink-2 hover:border-ink hover:bg-cloud hover:text-ink",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          )}
        </div>

        <div className="flex items-center gap-3">
          <ComputeBadge className="hidden md:inline-flex" />
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
