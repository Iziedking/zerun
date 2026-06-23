"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAccount, useBalance, useChainId, useDisconnect, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { zeroGGalileo, FAUCET_URL } from "@/lib/chain";
import { shortAddr } from "@/lib/format";
import { useAuth } from "@/lib/useAuth";
import { Spinner } from "./ui";
import { PopButton } from "./zerun/PopButton";

// "Connect to Zerun". RainbowKit's modal handles the wallet pick and adds and
// switches to 0G Galileo; the sign-in proof and faucet gas-gate after it are
// ours and unchanged.
export function ConnectButton({ routeOnConnect = false }: { routeOnConnect?: boolean }) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signedIn, signing, signIn, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [hasRouted, setHasRouted] = useState(false);

  const wrongChain = isConnected && chainId !== zeroGGalileo.id;

  // wagmi adds the chain to the wallet if it does not know it, then switches.
  const handleSwitch = useCallback(async () => {
    setBusy(true);
    try {
      await switchChainAsync({ chainId: zeroGGalileo.id });
    } catch {
      /* ignore; the operator can tap again */
    } finally {
      setBusy(false);
    }
  }, [switchChainAsync]);

  useEffect(() => {
    if (routeOnConnect && isConnected && !wrongChain && signedIn && !hasRouted) {
      setHasRouted(true);
      router.push("/arena");
    }
  }, [routeOnConnect, isConnected, wrongChain, signedIn, hasRouted, router]);

  if (!isConnected) {
    return (
      <PopButton
        type="button"
        onClick={() => openConnectModal?.()}
        disabled={!openConnectModal}
      >
        Connect to Zerun
      </PopButton>
    );
  }

  if (wrongChain) {
    return (
      <PopButton
        type="button"
        variant="secondary"
        onClick={handleSwitch}
        disabled={busy}
        icon={busy ? <Spinner /> : undefined}
      >
        Switch to 0G Galileo
      </PopButton>
    );
  }

  if (!signedIn) {
    return (
      <PopButton
        type="button"
        onClick={() => void signIn()}
        disabled={signing}
        icon={signing ? <Spinner /> : undefined}
      >
        Sign in
      </PopButton>
    );
  }

  return (
    <ConnectedChip
      address={address!}
      onDisconnect={() => {
        signOut();
        disconnect();
      }}
    />
  );
}

function ConnectedChip({
  address,
  onDisconnect,
}: {
  address: string;
  onDisconnect: () => void;
}) {
  const { data } = useBalance({ address: address as `0x${string}`, chainId: zeroGGalileo.id });
  const zero = data ? data.value === 0n : false;

  return (
    <div className="flex items-center gap-2">
      {zero && (
        <a
          href={FAUCET_URL}
          target="_blank"
          rel="noreferrer"
          className="hidden rounded-pill border-line border-ink bg-amber px-3 py-1.5 text-[12px] font-extrabold text-ink shadow-pop-press transition hover:-translate-y-px sm:inline-block"
        >
          0G balance is 0, get some
        </a>
      )}
      <div className="flex items-center gap-2 rounded-pill border-line border-ink bg-cloud px-3 py-1.5 shadow-pop-press">
        <span className="h-2.5 w-2.5 rounded-full bg-mint" aria-hidden />
        <span className="font-mono text-[12px] text-ink">{shortAddr(address)}</span>
        <button
          type="button"
          onClick={onDisconnect}
          className="rounded-pill px-1 font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2 transition hover:text-coral"
        >
          exit
        </button>
      </div>
    </div>
  );
}
