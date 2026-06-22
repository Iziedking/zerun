"use client";

import type { ReactNode } from "react";
import { useAccount, useChainId } from "wagmi";
import { zeroGGalileo } from "@/lib/chain";
import { ConnectButton } from "./ConnectButton";

// Renders children only when connected on 0G Galileo; otherwise a graceful prompt.
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
    <div className="mx-auto mt-20 max-w-md text-center">
      <div className="panel p-8">
        <h2 className="text-lg font-600 text-bone">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-haze">
          {wrongChain
            ? "Your wallet is on the wrong network. Switch to 0G Galileo to continue."
            : subtitle}
        </p>
        <div className="mt-5 flex justify-center">
          <ConnectButton />
        </div>
      </div>
    </div>
  );
}
