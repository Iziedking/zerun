"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ZerunLoader } from "./ZerunLoader";

// The loading curtain, twice over.
//
//   1. FIRST LOAD: the splash. The bouncing Z, the wordmark, and "Built on 0G" with the 0G
//      mark. Held for SPLASH_MS so the brand lands before the arena does.
//   2. EVERY ROUTE AFTER: the same curtain, without the 0G credit — repeating the credit on
//      each click turns a statement into wallpaper. This one exists purely for feel: the app
//      is not fetching anything behind it, so the wait is real and it is deliberate.
//
// It is skipped entirely for `prefers-reduced-motion`, and on back/forward navigation, where
// a person expects the page they just left to come straight back rather than a loading screen.

// The first load is the brand moment: the mark bounces, the bar fills, and "Built on 0G"
// sits under it long enough to be read rather than glimpsed.
export const SPLASH_MS = 7000;

// A deliberate pause on every route after the first. Arena and Leaderboard already fetch in
// well under this, so the user is waiting on the animation and nothing else. Three seconds
// makes a click feel like a level loading rather than a page swapping; it is also long enough
// that a regular visitor will feel it on the thirtieth click. Lower it here if that trade sours.
export const ROUTE_MS = 3000;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function RouteCurtain() {
  const pathname = usePathname();

  // Start shown so the splash covers the very first paint rather than flashing in after it.
  const [phase, setPhase] = useState<"splash" | "route" | "idle">("splash");
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
    const t = setTimeout(() => setPhase("idle"), SPLASH_MS);
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

    setPhase("route");
    const t = setTimeout(() => setPhase("idle"), ROUTE_MS);
    return () => clearTimeout(t);
  }, [pathname]);

  if (phase === "idle") return null;
  const splash = phase === "splash";
  return <ZerunLoader built={splash} durationMs={splash ? SPLASH_MS : ROUTE_MS} />;
}
