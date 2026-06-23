"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useBalance, useChainId } from "wagmi";
import { zeroGGalileo, FAUCET_URL } from "@/lib/chain";
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
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const wrong = isConnected && chainId !== zeroGGalileo.id;
  const { signedIn, signing, signIn, error } = useAuth();

  const { data: bal } = useBalance({
    address,
    chainId: zeroGGalileo.id,
    query: { enabled: isConnected && !wrong, refetchInterval: 5_000 },
  });
  const noGas = bal ? bal.value === 0n : false;

  const [engaged, setEngaged] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // A new wallet resets the flow.
  useEffect(() => {
    setEngaged(false);
    setDismissed(false);
  }, [address]);

  // Engage only when a freshly connected wallet still needs sign-in or gas, so a
  // returning, ready operator never sees the popup.
  useEffect(() => {
    if (isConnected && !wrong && (!signedIn || noGas) && !dismissed) setEngaged(true);
  }, [isConnected, wrong, signedIn, noGas, dismissed]);

  const open = engaged && !dismissed && isConnected && !wrong;
  if (!open) return null;

  const step: "signin" | "gas" | "done" = !signedIn ? "signin" : noGas ? "gas" : "done";
  const close = () => setDismissed(true);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
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
