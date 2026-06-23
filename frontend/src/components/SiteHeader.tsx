"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { Wordmark } from "./Wordmark";
import { ConnectButton } from "./ConnectButton";
import { ComputeBadge } from "./ComputeBadge";
import { BalancePill } from "./BalancePill";
import { MusicPlayer } from "./MusicPlayer";
import { NotificationBell } from "./NotificationBell";
import { cx } from "./zerun/cx";

export function SiteHeader() {
  const pathname = usePathname();
  const { isConnected, address } = useAccount();

  // The landing is a marketing page: only the wordmark shows. Everything else
  // (nav, compute badge, balance, music, connect) lives inside the app.
  const isLanding = pathname === "/";

  const nav = [
    { href: "/arena", label: "Arena" },
    { href: "/leaderboard", label: "Leaderboard" },
    ...(address ? [{ href: `/profile/${address}`, label: "Profile" }] : []),
  ];

  const navItems = nav.map((item) => {
    const active = item.href.startsWith("/profile")
      ? pathname.startsWith("/profile")
      : pathname === item.href || pathname.startsWith(`${item.href}/`);
    return { ...item, active };
  });

  return (
    <header className="sticky top-0 z-40 border-b-line border-ink bg-sky/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-3 sm:gap-5">
          <Wordmark />
          {/* Desktop / tablet nav */}
          {!isLanding && isConnected && (
            <nav className="hidden items-center gap-2 sm:flex">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    "rounded-pill border-line px-3.5 py-1.5 font-body text-sm font-extrabold transition",
                    item.active
                      ? "border-ink bg-violet text-white shadow-pop-press"
                      : "border-transparent text-ink-2 hover:border-ink hover:bg-cloud hover:text-ink",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          )}
        </div>

        {!isLanding && (
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <ComputeBadge className="hidden lg:inline-flex" />
            {isConnected && <BalancePill className="hidden md:inline-flex" />}
            {isConnected && <NotificationBell />}
            <MusicPlayer className="grid" />
            <ConnectButton />
          </div>
        )}
      </div>

      {/* Compact mobile nav: a row of pill links under the wordmark, phones only */}
      {!isLanding && isConnected && (
        <nav className="flex items-center gap-2 overflow-x-auto border-t-line border-ink/10 px-4 py-2 sm:hidden">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cx(
                "shrink-0 rounded-pill border-line px-3.5 py-1.5 font-body text-[13px] font-extrabold transition",
                item.active
                  ? "border-ink bg-violet text-white shadow-pop-press"
                  : "border-ink bg-cloud text-ink-2 hover:text-ink",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
