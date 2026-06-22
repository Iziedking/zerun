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
      <button
        type="button"
        onClick={handleConnect}
        disabled={busy || isPending}
        className="group relative inline-flex items-center gap-2 overflow-hidden rounded-md border border-signal/45 bg-signal/10 px-4 py-2 text-sm font-600 text-bone transition hover:border-signal/80 hover:bg-signal/15 disabled:opacity-60"
      >
        <span className="absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-signal/10 blur-md transition group-hover:translate-x-[400%] duration-700" aria-hidden />
        {(busy || isPending) && <Spinner className="text-signal" />}
        Connect to Zerun
      </button>
    );
  }

  if (wrongChain) {
    return (
      <button
        type="button"
        onClick={handleSwitch}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-md border border-amber/50 bg-amber/10 px-4 py-2 text-sm font-600 text-amber transition hover:bg-amber/15 disabled:opacity-60"
      >
        {busy && <Spinner />}
        Switch to 0G Galileo
      </button>
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
          className="hidden rounded-md border border-amber/40 bg-amber/5 px-2.5 py-1 text-[11px] font-500 text-amber transition hover:bg-amber/10 sm:inline-block"
        >
          0G balance is 0 · faucet
        </a>
      )}
      <div className="flex items-center gap-2 rounded-md border border-edge/70 bg-ink-700/80 px-3 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />
        <span className="font-mono text-[12px] text-chalk">{shortAddr(address)}</span>
        <button
          type="button"
          onClick={onDisconnect}
          className="text-[11px] uppercase tracking-[0.14em] text-haze transition hover:text-ember"
        >
          exit
        </button>
      </div>
    </div>
  );
}
