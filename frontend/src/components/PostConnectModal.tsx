"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAccount, useBalance, useChainId, useSwitchChain } from "wagmi";
import { zeroGGalileo, FAUCET_URL, addAndSwitchZeroG } from "@/lib/chain";
import { friendlyError } from "@/lib/errors";
import { useAuth } from "@/lib/useAuth";
import { Agent } from "./zerun/Agent";
import { StickerCard } from "./zerun/StickerCard";
import { PopButton } from "./zerun/PopButton";
import { Confetti } from "./zerun/Confetti";
import { Spinner } from "./ui";

// After RainbowKit connects the wallet and switches to 0G, this walks the rest of
// the flow in a modal so it is not missed in the top bar: sign in to prove
// ownership, grab a little 0G for gas, then you are in. It only pops for a fresh
// wallet that still needs one of those, and is dismissible.
export function PostConnectModal() {
  const router = useRouter();
  const pathname = usePathname();
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const wrong = isConnected && chainId !== zeroGGalileo.id;
  const { switchChainAsync } = useSwitchChain();
  const { signedIn, signing, signIn, error } = useAuth();

  const [switching, setSwitching] = useState(false);
  const [chainErr, setChainErr] = useState<string | null>(null);

  // Put the wallet on 0G. Try wagmi's switch first; if the wallet refuses (it does not know the
  // chain), fall back to a raw add-then-switch so mobile wallets stop stalling here.
  const ensureChain = useCallback(async () => {
    setSwitching(true);
    setChainErr(null);
    try {
      await switchChainAsync({ chainId: zeroGGalileo.id });
    } catch {
      try {
        const provider = (await connector?.getProvider?.()) as
          | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
          | undefined;
        if (provider) await addAndSwitchZeroG(provider);
      } catch (err) {
        setChainErr(friendlyError(err, "Could not add the 0G network. Open your wallet, add it, then come back."));
      }
    } finally {
      setSwitching(false);
    }
  }, [switchChainAsync, connector]);

  // The vote route is a public onboarding flow, not the app. A voter connects a wallet only so the
  // faucet can send credit; forcing them to sign in and switch chains here is the exact wall that
  // blocks mobile wallets. Never pop this modal on that route.
  const suppressed = pathname === "/vote";

  const { data: bal } = useBalance({
    address,
    chainId: zeroGGalileo.id,
    query: { enabled: isConnected && !wrong, refetchInterval: 5_000 },
  });
  const noGas = bal ? bal.value === 0n : false;

  const [engaged, setEngaged] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [autoAdded, setAutoAdded] = useState(false);

  // A new wallet resets the flow.
  useEffect(() => {
    setEngaged(false);
    setDismissed(false);
    setAutoAdded(false);
    setChainErr(null);
  }, [address]);

  // Engage when a freshly connected wallet still needs the chain, sign-in, or gas, so a returning,
  // ready operator never sees the popup.
  useEffect(() => {
    if (isConnected && (wrong || !signedIn || noGas) && !dismissed) setEngaged(true);
  }, [isConnected, wrong, signedIn, noGas, dismissed]);

  const open = engaged && !dismissed && isConnected && !suppressed;

  const step: "chain" | "signin" | "gas" | "done" = wrong
    ? "chain"
    : !signedIn
      ? "signin"
      : noGas
        ? "gas"
        : "done";

  // Auto-add 0G the first time we land on the chain step, so most wallets never see a manual
  // switch. One attempt per wallet; if it is rejected the button below is the manual retry.
  useEffect(() => {
    if (open && step === "chain" && !autoAdded && !switching) {
      setAutoAdded(true);
      void ensureChain();
    }
  }, [open, step, autoAdded, switching, ensureChain]);

  if (!open) return null;

  const close = () => setDismissed(true);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4 backdrop-blur-sm">
      <StickerCard className="relative w-full max-w-md overflow-hidden p-6 text-center sm:p-7">
        {step === "done" && <Confetti className="-z-10 opacity-70" />}
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-pill border-line border-ink bg-cloud font-display text-ink shadow-pop-press transition hover:-translate-y-px"
        >
          ×
        </button>

        <div className="flex justify-center">
          <Agent
            variant={step === "done" ? "amber" : "violet"}
            mood={step === "done" ? "happy" : "thinking"}
            size={112}
          />
        </div>

        {step === "chain" && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">Add the 0G network</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              Your wallet needs the 0G network to go on. We add it for you, just approve the prompt
              in your wallet. If you do not see it, tap the button.
            </p>
            {chainErr && <p className="mt-3 font-body text-[14px] font-bold text-coral">{chainErr}</p>}
            <div className="mt-5 flex justify-center">
              <PopButton
                type="button"
                size="lg"
                onClick={() => void ensureChain()}
                disabled={switching}
                icon={switching ? <Spinner /> : undefined}
              >
                {switching ? "Adding…" : "Add 0G network"}
              </PopButton>
            </div>
          </>
        )}

        {step === "signin" && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">Sign in to prove it is you</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              One signature shows you own this wallet. It is not a transaction and costs no gas.
            </p>
            {error && <p className="mt-3 font-body text-[14px] font-bold text-coral">{error}</p>}
            <div className="mt-5 flex justify-center">
              <PopButton
                type="button"
                size="lg"
                onClick={() => void signIn()}
                disabled={signing}
                icon={signing ? <Spinner /> : undefined}
              >
                Sign in
              </PopButton>
            </div>
          </>
        )}

        {step === "gas" && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">Grab a little 0G for gas</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              You are signed in. You need a bit of 0G to claim an agent and enter contests. Claim
              from the faucet, then come right back, this checks for it on its own.
            </p>
            <div className="mt-5 flex justify-center">
              <a href={FAUCET_URL} target="_blank" rel="noreferrer">
                <PopButton type="button" size="lg">
                  Open the 0G faucet
                </PopButton>
              </a>
            </div>
            <p className="mt-3 inline-flex items-center justify-center gap-2 font-body text-[13px] text-ink-3">
              <Spinner /> checking your balance
            </p>
          </>
        )}

        {step === "done" && (
          <>
            <h2 className="mt-4 font-display text-[28px] text-ink -rotate-1">You are in!</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              Wallet ready. Go raise an agent and send it into the arena.
            </p>
            <div className="mt-5 flex justify-center">
              <PopButton
                type="button"
                size="lg"
                onClick={() => {
                  close();
                  router.push("/arena");
                }}
              >
                Enter the arena
              </PopButton>
            </div>
          </>
        )}
      </StickerCard>
    </div>
  );
}
