"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { zeroGGalileo, FAUCET_URL } from "@/lib/chain";
import { ensureGalileo } from "@/lib/network";
import { shortAddr } from "@/lib/format";
import { Spinner } from "./ui";
import { PopButton } from "./zerun/PopButton";

// "Connect to Zerun". Connects the injected wallet, then ensures chain 16602.
export function ConnectButton({ routeOnConnect = false }: { routeOnConnect?: boolean }) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [busy, setBusy] = useState(false);
  const [hasRouted, setHasRouted] = useState(false);

  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
  const wrongChain = isConnected && chainId !== zeroGGalileo.id;

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
          /* user may reject the switch; surfaced via wrongChain banner */
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

  useEffect(() => {
    if (routeOnConnect && isConnected && !wrongChain && !hasRouted) {
      setHasRouted(true);
      router.push("/arena");
    }
  }, [routeOnConnect, isConnected, wrongChain, hasRouted, router]);

  if (!isConnected) {
    return (
      <PopButton
        type="button"
        onClick={handleConnect}
        disabled={busy || isPending}
        icon={(busy || isPending) ? <Spinner /> : undefined}
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

  return <ConnectedChip address={address!} onDisconnect={() => disconnect()} />;
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
