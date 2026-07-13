"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Agent, PopButton, StickerCard } from "@/components/zerun";

// Resolver for the Profile nav link. The nav points here when the wallet address is not resolved
// yet (wagmi can read it undefined for a beat after a reload); this page forwards to the real
// /profile/<address> the moment the address is available, so Profile is never a dead end.
export default function ProfileResolver() {
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const { openConnectModal } = useConnectModal();

  useEffect(() => {
    if (address) router.replace(`/profile/${address}`);
  }, [address, router]);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      <StickerCard className="p-8 text-center">
        <div className="mx-auto w-fit">
          <Agent variant="violet" mood={isConnected ? "thinking" : "idle"} size={96} name="your profile" />
        </div>
        {isConnected ? (
          <p className="mt-4 font-body text-[15px] font-bold text-ink-2">Opening your profile…</p>
        ) : (
          <>
            <h1 className="mt-4 font-display text-2xl text-ink">Connect to see your profile</h1>
            <p className="mt-2 font-body text-[14px] text-ink-2">
              Your profile lives under your wallet. Connect it and this opens automatically.
            </p>
            <div className="mt-5 flex justify-center">
              <PopButton onClick={() => openConnectModal?.()} disabled={!openConnectModal}>
                Connect wallet
              </PopButton>
            </div>
          </>
        )}
      </StickerCard>
    </div>
  );
}
