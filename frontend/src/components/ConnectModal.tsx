"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
  useConnect,
  useSwitchChain,
} from "wagmi";
import { zeroGGalileo, FAUCET_URL } from "@/lib/chain";
import { ensureGalileo } from "@/lib/network";
import { useUsdcBalance } from "@/lib/useChainData";
import { Spinner } from "./ui";
import { Agent, Chip, PopButton, StickerCard } from "./zerun";

// A small pop-over that carries the whole connect journey: connect the injected
// wallet, swap to a one-tap "Switch to 0G" if the chain is wrong, nudge to the
// faucet when there is no gas, then hop and lead into onboarding. Wallet
// connection is the identity here, there is no server session.
export function ConnectModal({
  open,
  onClose,
  onReady,
}: {
  open: boolean;
  onClose: () => void;
  /** Called once connected on the right chain (e.g. to route into onboarding). */
  onReady?: () => void;
}) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();
  const { switchChain } = useSwitchChain();
  const { isZero } = useUsdcBalance(address);

  const [busy, setBusy] = useState(false);
  const [hopped, setHopped] = useState(false);

  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
  const wrongChain = isConnected && chainId !== zeroGGalileo.id;
  const onChain = isConnected && !wrongChain;

  const handleConnect = useCallback(async () => {
    if (!injected) return;
    setBusy(true);
    try {
      const provider = (await injected.getProvider()) as
        | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
        | undefined;
      connect({ connector: injected });
      if (provider) {
        try {
          await ensureGalileo(provider);
        } catch {
          /* user may reject; the switch step handles it */
        }
      }
    } finally {
      setBusy(false);
    }
  }, [connect, injected]);

  const handleSwitch = useCallback(async () => {
    setBusy(true);
    try {
      const provider = injected
        ? ((await injected.getProvider()) as
            | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
            | undefined)
        : undefined;
      if (provider) await ensureGalileo(provider);
      else switchChain({ chainId: zeroGGalileo.id });
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }, [injected, switchChain]);

  // When the operator lands on the right chain, give a little hop then move on.
  useEffect(() => {
    if (!open || !onChain || hopped) return;
    setHopped(true);
    const t = setTimeout(() => {
      onClose();
      if (onReady) onReady();
      else router.push("/onboarding");
    }, 900);
    return () => clearTimeout(t);
  }, [open, onChain, hopped, onClose, onReady, router]);

  // Close on escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect to play"
      className="fixed inset-0 z-50 grid place-items-center p-5"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-sm"
      />
      <StickerCard className="relative z-10 w-full max-w-sm p-7 text-center motion-safe:animate-pop-in">
        <div className="flex justify-center">
          <Agent
            variant="violet"
            mood={onChain ? "happy" : "idle"}
            size={120}
            name="your guide"
          />
        </div>

        {!isConnected && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">Connect to play</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              Zerun runs on the 0G Galileo testnet. Connect a wallet to claim your
              agent and send it in.
            </p>
            <PopButton
              type="button"
              onClick={handleConnect}
              disabled={busy || isPending}
              icon={busy || isPending ? <Spinner /> : undefined}
              className="mt-6 w-full"
            >
              Connect wallet
            </PopButton>
          </>
        )}

        {wrongChain && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">One more tap</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              Your wallet is on another network. Switch to 0G to continue.
            </p>
            <PopButton
              type="button"
              variant="secondary"
              onClick={handleSwitch}
              disabled={busy}
              icon={busy ? <Spinner /> : undefined}
              className="mt-6 w-full"
            >
              Switch to 0G
            </PopButton>
          </>
        )}

        {onChain && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">You are in</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              Taking you to set up your agent.
            </p>
            {isZero && (
              <a
                href={FAUCET_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-block"
              >
                <Chip tone="won">need gas? grab some 0G</Chip>
              </a>
            )}
          </>
        )}
      </StickerCard>
    </div>
  );
}
