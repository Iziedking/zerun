"use client";

import type { ReactNode } from "react";
import { useAccount, useChainId } from "wagmi";
import { zeroGGalileo } from "@/lib/chain";
import { ConnectButton } from "./ConnectButton";
import { StickerCard } from "./zerun/StickerCard";
import { Agent } from "./zerun/Agent";

// Renders children only when connected on 0G Galileo; otherwise a friendly prompt
// with a bobbing agent.
export function ConnectGate({
  children,
  title = "Connect to continue",
  subtitle = "Zerun runs on the 0G Galileo testnet. Connect an injected wallet to claim an agent and enter contests.",
}: {
  children: ReactNode;
  title?: string;
  subtitle?: string;
}) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const wrongChain = isConnected && chainId !== zeroGGalileo.id;

  if (isConnected && !wrongChain) return <>{children}</>;

  return (
    <div className="mx-auto mt-16 max-w-md">
      <StickerCard className="p-8 text-center">
        <div className="flex justify-center">
          <Agent variant="cyan" mood="idle" size={120} />
        </div>
        <h2 className="mt-4 font-display text-2xl text-ink">{title}</h2>
        <p className="mt-2 font-body text-[15px] leading-relaxed text-ink-2">
          {wrongChain
            ? "Your wallet is on the wrong network. Switch to 0G Galileo to continue."
            : subtitle}
        </p>
        <div className="mt-6 flex justify-center">
          <ConnectButton />
        </div>
      </StickerCard>
    </div>
  );
}
