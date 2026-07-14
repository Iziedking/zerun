"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { Wordmark } from "./Wordmark";
import { ConnectButton } from "./ConnectButton";
import { BalancePill } from "./BalancePill";
import { MusicPlayer } from "./MusicPlayer";
import { NotificationBell } from "./NotificationBell";
import { ThemeToggle } from "./ThemeToggle";
import { cx } from "./zerun/cx";

export function SiteHeader() {
  const pathname = usePathname();
  const { isConnected, address } = useAccount();

  // The admin console is a standalone, token-gated tool: no app chrome at all.
  if (pathname.startsWith("/admin")) return null;

  // The landing is a marketing page: only the wordmark shows. Everything else
  // (nav, compute badge, balance, music, connect) lives inside the app.
  const isLanding = pathname === "/";
  // The back button no longer lives in the header: it floats at the top-left of the page CONTENT
  // (see <PageBack/> in the layout), so it is never crammed into the nav bar.
  // The vote route runs on 0G mainnet, so the arena's testnet balance nudge does not apply there.
  const isVote = pathname === "/vote";

  // Profile is ALWAYS in the nav (the nav only renders once connected anyway). Keying its
  // presence on the wallet address is what made it vanish: wagmi's `address` reads undefined for
  // a beat after a reload even while the session is signed in and the wallet pill shows the
  // address, and that transient dropped only this item. The href falls back to the /profile
  // resolver, which forwards to the connected address.
  const nav = [
    { href: "/arena", label: "Arena" },
    { href: "/chess", label: "Chess" },
    { href: "/ladder", label: "Ladder" },
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/models", label: "Models" },
    { href: address ? `/profile/${address}` : "/profile", label: "Profile" },
  ];

  const navItems = nav.map((item) => {
    const active = item.href.startsWith("/profile")
      ? pathname.startsWith("/profile")
      : pathname === item.href || pathname.startsWith(`${item.href}/`);
    return { ...item, active };
  });

  return (
    <header className="sticky top-0 z-40 border-b-line border-ink bg-sky/85 backdrop-blur-md">
      {/* The header spans the FULL width (the page content below stays capped at max-w-6xl). On a
          wide screen the old cap left big empty gutters left and right while squeezing the nav, so
          Profile got clipped. Full width plus edge padding gives every section room. */}
      <div className="flex w-full items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-8 xl:px-12">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          {/* In the app the top bar is crowded (nav pills, balance, controls, the
              wallet pill), so on phones show just the Z tile and bring the word back
              at sm+. The marketing landing has room, so it keeps the full wordmark. */}
          <Wordmark wordClassName={isLanding ? "" : "hidden sm:inline-block"} />
          {/* Full pill nav, single row, no scroll. Shown at lg+ where the full-width bar has room
              for every section including Profile. Below lg (tablet and phone) the compact scroll row
              under the wordmark takes over, so nothing ever clips. */}
          {!isLanding && isConnected && (
            <nav className="hidden shrink-0 items-center gap-2 lg:flex">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    "shrink-0 whitespace-nowrap rounded-pill border-line px-3.5 py-1.5 font-body text-sm font-extrabold transition",
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

        {isLanding ? (
          <div className="flex shrink-0 items-center">
            <ThemeToggle />
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {isConnected && !isVote && <BalancePill className="hidden xl:inline-flex" />}
            {isConnected && <NotificationBell />}
            <ThemeToggle />
            <MusicPlayer className="grid" />
            <ConnectButton />
          </div>
        )}
      </div>

      {/* Compact nav: a scrollable row of pill links under the wordmark, for phone and tablet
          (below lg, where the full pill row would not fit on one line). */}
      {!isLanding && isConnected && (
        <nav className="flex items-center gap-2 overflow-x-auto border-t-line border-ink/10 px-4 py-2 lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
