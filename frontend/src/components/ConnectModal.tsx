"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useSwitchChain,
} from "wagmi";
import { zeroGGalileo, FAUCET_URL } from "@/lib/chain";
import { ensureGalileo } from "@/lib/network";
import { useAuth } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { Spinner } from "./ui";
import { Agent, Chip, PopButton, StickerCard } from "./zerun";

type EthProvider = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

// The whole connect journey in one small pop-over, strictly in order:
// connect the wallet, switch to 0G if needed, sign in to prove ownership, then
// you are in. Sign-in state is shared app-wide, so the navbar stays in step.
export function ConnectModal({
  open,
  onClose,
  onReady,
}: {
  open: boolean;
  onClose: () => void;
  onReady?: () => void;
}) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectAsync, connectors, isPending } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const { data: bal } = useBalance({ address, chainId: zeroGGalileo.id });
  const { signedIn, signing, error: signError, signIn } = useAuth();

  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [hopped, setHopped] = useState(false);

  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
  const wrongChain = isConnected && chainId !== zeroGGalileo.id;
  const onChain = isConnected && !wrongChain;
  const noGas = bal ? bal.value === 0n : false;
  const shownError = localError ?? signError;

  const handleConnect = useCallback(async () => {
    if (!injected) return;
    setLocalError(null);
    setBusy(true);
    try {
      await connectAsync({ connector: injected });
      try {
        const provider = (await injected.getProvider()) as EthProvider | undefined;
        if (provider) await ensureGalileo(provider);
      } catch {
        /* a wrong chain is handled by the switch step below */
      }
    } catch (err) {
      setLocalError(friendlyError(err, "Could not connect. Is your wallet unlocked?"));
    } finally {
      setBusy(false);
    }
  }, [connectAsync, injected]);

  const handleSwitch = useCallback(async () => {
    setLocalError(null);
    setBusy(true);
    try {
      const provider = injected ? ((await injected.getProvider()) as EthProvider | undefined) : undefined;
      if (provider) await ensureGalileo(provider);
      else await switchChainAsync({ chainId: zeroGGalileo.id });
    } catch (err) {
      setLocalError(friendlyError(err, "Could not switch network. Try from your wallet."));
    } finally {
      setBusy(false);
    }
  }, [injected, switchChainAsync]);

  // Once signed in on the right chain, give a little hop then move on.
  useEffect(() => {
    if (!open || !onChain || !signedIn || hopped) return;
    setHopped(true);
    const t = setTimeout(() => {
      onClose();
      if (onReady) onReady();
      else router.push("/onboarding");
    }, 900);
    return () => clearTimeout(t);
  }, [open, onChain, signedIn, hopped, onClose, onReady, router]);

  // Clear any stale error when the step changes.
  useEffect(() => {
    setLocalError(null);
  }, [isConnected, wrongChain, signedIn]);

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

  const connecting = busy || isPending;

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
          <Agent variant="violet" mood={signedIn ? "happy" : "idle"} size={120} name="your guide" />
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
              disabled={connecting}
              icon={connecting ? <Spinner /> : undefined}
              className="mt-6 w-full"
            >
              {connecting ? "Connecting" : "Connect wallet"}
            </PopButton>
          </>
        )}

        {wrongChain && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">One more tap</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              Your wallet is on another network. Switch to 0G to keep going.
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

        {onChain && !signedIn && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">Sign in</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              Sign a quick message to prove this wallet is yours. No transaction,
              no gas.
            </p>
            {noGas && (
              <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="mt-4 inline-block">
                <Chip tone="won">no 0G yet? grab some gas</Chip>
              </a>
            )}
            <PopButton
              type="button"
              onClick={() => void signIn()}
              disabled={signing}
              icon={signing ? <Spinner /> : undefined}
              className="mt-6 w-full"
            >
              {signing ? "Check your wallet" : "Sign in"}
            </PopButton>
          </>
        )}

        {onChain && signedIn && (
          <>
            <h2 className="mt-4 font-display text-2xl text-ink">You are in</h2>
            <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
              Taking you to set up your agent.
            </p>
          </>
        )}

        {shownError && (
          <p className="mt-4 font-body text-[13px] font-bold text-coral">{shownError}</p>
        )}
      </StickerCard>
    </div>
  );
}
