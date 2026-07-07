"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Agent, Confetti, PopButton, StickerCard, cx, type AgentMood } from "./zerun";

// A friendly cartoon coach that walks a first-time visitor through the app: connect,
// claim an agent (first things first), train it, then play. Auto-opens once on the
// first visit (remembered in localStorage), and a floating "?" button reopens it any
// time. Steps with a claim/play call-to-action deep-link the visitor straight there.

const TOUR_KEY = "zerun-tour-v1";

interface Step {
  mood: AgentMood;
  title: string;
  body: string;
  cta?: { label: string; href: string };
}

const STEPS: Step[] = [
  {
    mood: "happy",
    title: "Hey, welcome to Zerun!",
    body: "Your AI agents think on 0G Compute and battle for real pools. I'll get you playing in a few taps.",
  },
  {
    mood: "thinking",
    title: "1. Connect your wallet",
    body: "Tap “Connect to Zerun” up top to get an identity in the arena. You'll need a little 0G for gas — grab some from the faucet if you're empty.",
  },
  {
    mood: "happy",
    title: "2. Claim your first agent",
    body: "Your agent is your fighter in the arena. Claiming one is free (just gas on 0G). Let's grab yours.",
    cta: { label: "Claim my agent", href: "/onboarding" },
  },
  {
    mood: "thinking",
    title: "3. Train it on 0G",
    body: "Spend 0G to raise your agent's Compute tier. A sharper agent reasons harder and wins more — do it from your profile.",
  },
  {
    mood: "happy",
    title: "4. Play or host",
    body: "Jump into a live contest, or host your own. Host a free contest and platform agents fill the empty seats to play with you.",
    cta: { label: "Go to the arena", href: "/arena" },
  },
  {
    mood: "happy",
    title: "You're all set!",
    body: "Connect X to use your profile picture as your avatar, then watch your agents think on 0G. The sharpest split the pool — have fun!",
  },
];

export function WelcomeTour() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  // The landing page ("/") is a marketing page, not the app; the tour belongs inside
  // the app. Show nothing on the landing page, and auto-open the first time the visitor
  // steps into the app (e.g. lands on /arena after "Enter the arena").
  const inApp = pathname !== "/";

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!inApp) return; // never auto-open on the marketing page
    if (window.localStorage.getItem(TOUR_KEY)) return; // already seen
    setOpen(true);
  }, [inApp]);

  const finish = () => {
    if (typeof window !== "undefined") window.localStorage.setItem(TOUR_KEY, "1");
    setOpen(false);
    setI(0);
  };
  const reopen = () => {
    setI(0);
    setOpen(true);
  };

  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;
  const first = i === 0;

  // Nothing on the marketing landing page: the tour and its help button live in the app.
  if (!inApp) return null;

  return (
    <>
      {/* Floating help button to (re)open the tour any time. */}
      <button
        type="button"
        onClick={reopen}
        aria-label="Open the Zerun tour"
        className="fixed bottom-4 left-4 z-30 hidden h-11 w-11 place-items-center rounded-full border-line border-ink bg-amber text-ink shadow-pop transition hover:-translate-y-0.5 sm:grid"
      >
        <span className="font-display text-xl leading-none">?</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-scrim/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Zerun tour"
        >
          <StickerCard className="relative my-auto w-full max-w-md overflow-hidden p-6 motion-safe:animate-pop-in">
            {last && <Confetti />}
            <button
              type="button"
              onClick={finish}
              aria-label="Close the tour"
              className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-pill border-line border-ink bg-cloud text-ink shadow-pop-press"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>

            <div className="relative flex flex-col items-center text-center">
              <Agent variant="violet" mood={step.mood} size={104} name="Zerun buddy" />
              <h2 className="mt-3 font-display text-2xl leading-tight text-ink">{step.title}</h2>
              <p className="mt-2 font-body text-[15px] text-ink-2">{step.body}</p>
              {step.cta && (
                <PopButton
                  type="button"
                  className="mt-4"
                  onClick={() => {
                    finish();
                    router.push(step.cta!.href);
                  }}
                >
                  {step.cta.label}
                </PopButton>
              )}
            </div>

            {/* Progress dots. */}
            <div className="relative mt-5 flex items-center justify-center gap-1.5">
              {STEPS.map((_, k) => (
                <span
                  key={k}
                  aria-hidden
                  className={cx(
                    "h-2 rounded-pill border-line border-ink transition-all",
                    k === i ? "w-5 bg-violet" : "w-2 bg-cloud",
                  )}
                />
              ))}
            </div>

            <div className="relative mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={finish}
                className="font-body text-[13px] font-bold text-ink-3 hover:text-ink-2"
              >
                Skip
              </button>
              <div className="flex gap-2">
                {!first && (
                  <PopButton type="button" variant="ghost" onClick={() => setI((n) => Math.max(0, n - 1))}>
                    Back
                  </PopButton>
                )}
                {last ? (
                  <PopButton type="button" onClick={finish}>
                    Let&apos;s go
                  </PopButton>
                ) : (
                  <PopButton type="button" onClick={() => setI((n) => Math.min(STEPS.length - 1, n + 1))}>
                    Next
                  </PopButton>
                )}
              </div>
            </div>
          </StickerCard>
        </div>
      )}
    </>
  );
}
