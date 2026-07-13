"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
  const router = useRouter();
  const { isConnected, address } = useAccount();

  // The admin console is a standalone, token-gated tool: no app chrome at all.
  if (pathname.startsWith("/admin")) return null;

  // The landing is a marketing page: only the wordmark shows. Everything else
  // (nav, compute badge, balance, music, connect) lives inside the app.
  const isLanding = pathname === "/";
  // A back button top-left on every inner page. The landing has nowhere to go back to, and the
  // arena is the app's home base, so both skip it.
  const showBack = !isLanding && pathname !== "/arena";
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
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          {showBack && (
            <button
              type="button"
              onClick={() => {
                // Go back if there is somewhere to go; on a direct load (no in-app history) fall
                // back to the arena so the button is never a dead end.
                if (typeof window !== "undefined" && window.history.length > 1) router.back();
                else router.push("/arena");
              }}
              aria-label="Go back"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-chunk border-line border-ink bg-cloud text-ink shadow-pop-press transition-[transform,box-shadow] duration-150 ease-spring hover:-translate-y-px hover:shadow-pop active:translate-y-0 active:shadow-pop-press"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {/* In the app the top bar is crowded (nav pills, balance, controls, the
              wallet pill), so on phones show just the Z tile and bring the word back
              at sm+. The marketing landing has room, so it keeps the full wordmark. */}
          <Wordmark wordClassName={isLanding ? "" : "hidden sm:inline-block"} />
          {/* Desktop / tablet nav. With six sections plus Profile it can outgrow the bar on a
              laptop, so it scrolls instead of clipping the last item (Profile) out of sight. */}
          {!isLanding && isConnected && (
            <nav className="hidden min-w-0 items-center gap-2 overflow-x-auto sm:flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

        {isLanding ? (
          <div className="flex shrink-0 items-center">
            <ThemeToggle />
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {isConnected && !isVote && <BalancePill className="hidden lg:inline-flex" />}
            {isConnected && <NotificationBell />}
            <ThemeToggle />
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
