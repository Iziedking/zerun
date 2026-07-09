"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ZerunLoader } from "./ZerunLoader";

// The loading curtain, twice over.
//
//   1. FIRST LOAD: the splash. The bouncing Z, the wordmark, and "Built on 0G" with the 0G
//      mark. Held 7s the first time this browser ever opens Zerun, 3s on every load after.
//   2. NAVIGATING BETWEEN THE MAIN PAGES: the same curtain, without the 0G credit — repeating
//      the credit on each click turns a statement into wallpaper. This one exists purely for
//      feel: nothing is fetching behind it, so the wait is real and it is deliberate.
//
// It is skipped entirely for `prefers-reduced-motion`, and on back/forward navigation, where
// a person expects the page they just left to come straight back rather than a loading screen.
//
// And it is skipped for everything that is not a top-level page. An in-app action that happens
// to end in a `router.push` — hosting a contest and landing on it, claiming an agent, finishing
// onboarding — is not a navigation the user asked for, it is the result of work they just did.
// Covering that result with two seconds of branding makes the app feel like it is stalling on
// their behalf. The curtain belongs to the nav bar, and nowhere else.

// The FIRST time anyone opens Zerun: the brand moment. The mark bounces, the bar fills, and
// "Built on 0G" sits under it long enough to be read rather than glimpsed.
export const SPLASH_FIRST_MS = 7000;

// Every load after that, including a plain reload. The same splash, but a returning visitor
// has already read the credit and does not need seven seconds of it.
export const SPLASH_RETURN_MS = 3000;

// A deliberate pause on every route after the first. Arena and Leaderboard already fetch in
// well under this, so the user is waiting on the animation and nothing else.
export const ROUTE_MS = 2000;

// Remembers that this browser has seen the long splash. localStorage rather than session:
// a reload is not a first visit, and neither is coming back tomorrow.
const SEEN_KEY = "zerun:splash:seen";

function firstEverVisit(): boolean {
  try {
    if (localStorage.getItem(SEEN_KEY) === "1") return false;
    localStorage.setItem(SEEN_KEY, "1");
    return true;
  } catch {
    // Private mode, or storage denied. Treat it as a return visit: a stranger who cannot be
    // remembered should not be held for seven seconds on every single load.
    return false;
  }
}

// The only destinations that draw a curtain: the pages in the top nav, plus Docs. Anything
// else — /contest/123, /onboarding, /admin, /x/... — arrives instantly. Exact matches only,
// so a nested route under one of these does not inherit the curtain.
const CURTAIN_ROUTES = new Set(["/", "/arena", "/ladder", "/leaderboard", "/models", "/profile", "/docs"]);

function isCurtainRoute(path: string): boolean {
  return CURTAIN_ROUTES.has(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function RouteCurtain() {
  const pathname = usePathname();

  // Start shown so the splash covers the very first paint rather than flashing in after it.
  const [phase, setPhase] = useState<"splash" | "route" | "idle">("splash");
  // How long this particular splash is held. Resolved on mount, because localStorage is not
  // readable during the server render.
  const [splashMs, setSplashMs] = useState(SPLASH_RETURN_MS);
  const firstPath = useRef<string | null>(null);
  const popped = useRef(false);

  // A back/forward navigation should never show a curtain.
  useEffect(() => {
    const onPop = () => {
      popped.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The splash, on mount only.
  useEffect(() => {
    firstPath.current = pathname;
    if (prefersReducedMotion()) {
      setPhase("idle");
      return;
    }
    const ms = firstEverVisit() ? SPLASH_FIRST_MS : SPLASH_RETURN_MS;
    setSplashMs(ms);
    const t = setTimeout(() => setPhase("idle"), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every subsequent route change.
  useEffect(() => {
    // The mount effect above owns the first path; do not double-curtain it.
    if (firstPath.current === null || firstPath.current === pathname) return;
    firstPath.current = pathname;

    if (popped.current) {
      popped.current = false;
      return;
    }
    if (prefersReducedMotion()) return;
    if (!isCurtainRoute(pathname)) return;

    setPhase("route");
    const t = setTimeout(() => setPhase("idle"), ROUTE_MS);
    return () => clearTimeout(t);
  }, [pathname]);

  if (phase === "idle") return null;
  const splash = phase === "splash";
  return <ZerunLoader built={splash} durationMs={splash ? splashMs : ROUTE_MS} />;
}
