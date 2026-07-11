"use client";

import { useRouter, usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAccount, useBalance, useChainId, useDisconnect, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  zeroGGalileo,
  zeroGMainnet,
  FAUCET_URL,
  addAndSwitchZeroG,
  addAndSwitchZeroGMainnet,
} from "@/lib/chain";
import { shortAddr } from "@/lib/format";
import { useAuth } from "@/lib/useAuth";
import { Spinner } from "./ui";
import { PopButton } from "./zerun/PopButton";

// "Connect to Zerun". RainbowKit's modal handles the wallet pick and adds and
// switches to 0G Galileo; the sign-in proof and faucet gas-gate after it are
// ours and unchanged.
export function ConnectButton({ routeOnConnect = false }: { routeOnConnect?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signedIn, signing, signIn, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [hasRouted, setHasRouted] = useState(false);

  // The vote route lives on 0G mainnet and needs no sign-in; the rest of the app is the arena on
  // the testnet. The expected chain follows the route.
  const isVote = pathname === "/vote";
  const expected = isVote ? zeroGMainnet : zeroGGalileo;
  const wrongChain = isConnected && chainId !== expected.id;

  // Try wagmi's switch first; if the wallet refuses because it does not know the chain, fall back
  // to a raw add-then-switch so mobile wallets that will not switch to an unknown chain still land.
  const handleSwitch = useCallback(async () => {
    setBusy(true);
    try {
      try {
        await switchChainAsync({ chainId: expected.id });
      } catch {
        const provider = (await connector?.getProvider?.()) as
          | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
          | undefined;
        if (provider) await (isVote ? addAndSwitchZeroGMainnet : addAndSwitchZeroG)(provider);
      }
    } catch {
      /* ignore; the operator can tap again */
    } finally {
      setBusy(false);
    }
  }, [switchChainAsync, connector, expected.id, isVote]);

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

  // On the vote route a connected wallet is all we need: no chain switch, no sign-in signature.
  if (isVote) {
    return (
      <ConnectedChip
        address={address!}
        chainId={zeroGMainnet.id}
        showFaucet={false}
        onDisconnect={() => {
          signOut();
          disconnect();
        }}
      />
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
        Switch to {expected.name}
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
  chainId = zeroGGalileo.id,
  showFaucet = true,
}: {
  address: string;
  onDisconnect: () => void;
  chainId?: typeof zeroGGalileo.id | typeof zeroGMainnet.id;
  showFaucet?: boolean;
}) {
  const { data } = useBalance({ address: address as `0x${string}`, chainId });
  const zero = showFaucet && (data ? data.value === 0n : false);

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
