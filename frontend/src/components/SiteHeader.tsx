"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { Wordmark } from "./Wordmark";
import { ConnectButton } from "./ConnectButton";
import { ComputeBadge } from "./ComputeBadge";

const NAV = [
  { href: "/arena", label: "Arena" },
  { href: "/demo", label: "Demo" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { isConnected } = useAccount();

  return (
    <header className="sticky top-0 z-40 border-b border-edge/50 bg-ink-900/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <div className="flex items-center gap-6">
          <Wordmark />
          {isConnected && (
            <nav className="hidden items-center gap-1 sm:flex">
              {NAV.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-md px-3 py-1.5 text-sm transition ${
                      active
                        ? "bg-ink-600 text-bone"
                        : "text-haze hover:bg-ink-700 hover:text-chalk"
                    }`}
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
