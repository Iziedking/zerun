"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { StickerCard } from "@/components/zerun";

// Mobile wallets receive a signature request over WalletConnect but do not always
// pop to the foreground, so users think nothing happened. This wraps a wallet
// call in a clear overlay that tells them to open their wallet app and approve,
// which is the single biggest mobile UX win for signing.

const isMobile = () =>
  typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

interface WalletActionState {
  // Run the part of a flow that needs a wallet signature, showing the prompt
  // until the user approves (or rejects) in their wallet.
  run<T>(fn: () => Promise<T>, message?: string): Promise<T>;
}

const Ctx = createContext<WalletActionState | null>(null);
const DEFAULT_MSG = "Approve the request in your wallet to continue.";

export function WalletActionProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState(DEFAULT_MSG);

  const run = useCallback(async <T,>(fn: () => Promise<T>, msg?: string): Promise<T> => {
    setMessage(msg ?? DEFAULT_MSG);
    setActive(true);
    try {
      return await fn();
    } finally {
      setActive(false);
    }
  }, []);

  const value = useMemo<WalletActionState>(() => ({ run }), [run]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {active && <WalletPrompt message={message} onDismiss={() => setActive(false)} />}
    </Ctx.Provider>
  );
}

export function useWalletAction(): WalletActionState {
  const ctx = useContext(Ctx);
  // Fallback so the hook is safe even if the provider is missing: just run.
  return ctx ?? { run: (fn) => fn() };
}

function WalletPrompt({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const mobile = isMobile();
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-scrim/55 p-4 backdrop-blur-sm">
      <StickerCard className="w-full max-w-sm p-6 text-center motion-safe:animate-pop-in">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-chunk border-line border-ink bg-violet shadow-pop-press">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="3" y="6" width="18" height="13" rx="3.5" fill="#FFFFFF" stroke="#171449" strokeWidth="2" />
            <path d="M3 9h18" stroke="#171449" strokeWidth="2" />
            <circle cx="16.5" cy="13.5" r="1.6" fill="#6C4CF1" stroke="#171449" strokeWidth="1.4" />
          </svg>
        </div>
        <h3 className="mt-4 font-display text-xl text-ink">Confirm in your wallet</h3>
        <p className="mt-1.5 font-body text-[14px] font-bold text-ink-2">{message}</p>
        {mobile && (
          <p className="mt-3 font-body text-[13px] text-ink-3">
            Open your wallet app (MetaMask, Rainbow, and so on). The request is waiting there for you
            to approve, then come back here.
          </p>
        )}
        <div className="mt-5 flex items-center justify-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-violet [animation:zr-dots_1.2s_infinite]" />
          <span
            className="h-2.5 w-2.5 rounded-full bg-violet [animation:zr-dots_1.2s_infinite]"
            style={{ animationDelay: "0.15s" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full bg-violet [animation:zr-dots_1.2s_infinite]"
            style={{ animationDelay: "0.3s" }}
          />
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-4 font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-3 transition hover:text-coral"
        >
          Did not get a prompt? Close
        </button>
      </StickerCard>
    </div>
  );
}
