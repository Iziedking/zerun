"use client";

import { useState } from "react";
import { useAccount, useBalance } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zeroGGalileo, FAUCET_URL } from "@/lib/chain";
import { useUsdcBalance } from "@/lib/useChainData";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { StickerCard } from "./zerun/StickerCard";
import { PopButton } from "./zerun/PopButton";
import { Spinner } from "./ui";

// Wallet readiness for the operator's own profile: the 0G gas balance with a
// faucet link, and the tUSDC balance with a one-click claim from the capped
// faucet (100 tUSDC per 7 days) to top up the arena's test currency.
export function WalletReady() {
  const { address } = useAccount();
  const { data: gas } = useBalance({
    address,
    chainId: zeroGGalileo.id,
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
  });
  const usdc = useUsdcBalance(address);
  const queryClient = useQueryClient();
  const statusQ = useQuery({
    queryKey: ["faucetStatus", address],
    queryFn: () => api.faucetStatus(address!),
    enabled: Boolean(address),
    staleTime: 30_000,
  });
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!address) return null;

  const lowGas = gas ? gas.value === 0n : false;
  const gasText = gas ? `${(Number(gas.value) / 1e18).toFixed(3)} 0G` : "·";
  const capped = statusQ.data?.capped ?? false;

  const mint = async () => {
    setError(null);
    setMinting(true);
    try {
      await api.faucetUsdc({ owner: address });
      await usdc.refetch();
      await queryClient.invalidateQueries({ queryKey: ["faucetStatus"] });
    } catch (err) {
      setError(friendlyError(err, "That claim did not go through. Try again."));
    } finally {
      setMinting(false);
    }
  };

  return (
    <StickerCard className="p-5">
      <h3 className="font-display text-lg text-ink">Wallet</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 p-4">
          <div className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
            0G for gas
          </div>
          <div className="mt-1 font-display text-xl text-ink">{gasText}</div>
          <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="mt-3 inline-block">
            <PopButton type="button" variant={lowGas ? "primary" : "secondary"}>
              {lowGas ? "Get 0G gas" : "Top up 0G"}
            </PopButton>
          </a>
        </div>

        <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 p-4">
          <div className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
            tUSDC balance
          </div>
          <div className="mt-1 font-display text-xl text-ink">
            {usdc.formatted} <span className="font-body text-[12px] font-extrabold text-ink-2">tUSDC</span>
          </div>
          <PopButton
            type="button"
            variant={capped ? "ghost" : "primary"}
            onClick={() => void mint()}
            disabled={minting || capped}
            icon={minting ? <Spinner /> : undefined}
            className="mt-3"
          >
            {capped ? "Claimed this week" : minting ? "Claiming" : "Get tUSDC"}
          </PopButton>
        </div>
      </div>
      {error && <p className="mt-3 font-body text-[13px] font-bold text-coral">{error}</p>}
      <p className="mt-3 font-body text-[12px] leading-relaxed text-ink-3">
        tUSDC is the prize and hosting currency: you win it in contests and spend it to host your
        own. Compute training is paid in 0G. The faucet tops you up to 100 tUSDC per wallet each
        week, and prizes you win are claimed on that contest's page. 0G is the network gas.
      </p>
    </StickerCard>
  );
}
