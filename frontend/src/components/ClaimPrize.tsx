"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Hex } from "viem";
import { contestEngineAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { api } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { zeroGGalileo } from "@/lib/chain";
import type { ClaimInfo } from "@/lib/types";
import { Spinner } from "./ui";
import { Chip, PopButton, StickerCard } from "./zerun";

// Checks claim eligibility, then claimPrize(contestId, amount, proof) and POST /claimed.
export function ClaimPrize({ contestId }: { contestId: number }) {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [info, setInfo] = useState<ClaimInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  const engineAddr = deployment?.contracts.contestEngine;

  useEffect(() => {
    let active = true;
    if (!address) {
      setInfo(null);
      return;
    }
    api
      .claim(contestId, address)
      .then((res) => {
        if (active) {
          setInfo(res);
          setClaimed(res.claimed);
        }
      })
      .catch(() => {
        if (active) setInfo(null);
      });
    return () => {
      active = false;
    };
  }, [contestId, address, busy]);

  const claim = useCallback(async () => {
    setError(null);
    if (!engineAddr || !address || !publicClient || !info) return;
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        abi: contestEngineAbi,
        address: engineAddr,
        functionName: "claimPrize",
        args: [BigInt(contestId), BigInt(info.amount), info.proof as Hex[]],
        chainId: zeroGGalileo.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await api.claimed(contestId, { operator: address });
      setClaimed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "Claim failed.");
    } finally {
      setBusy(false);
    }
  }, [engineAddr, address, publicClient, info, contestId, writeContractAsync]);

  if (!info || !info.eligible) return null;

  return (
    <StickerCard className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
            you placed #{info.rank}
          </span>
          <div className="mt-0.5 font-display text-2xl text-ink">
            {formatUsdc(info.amount)}{" "}
            <span className="font-body text-base font-extrabold text-ink-2">tUSDC</span>
          </div>
        </div>
        {claimed ? (
          <Chip tone="won">Claimed</Chip>
        ) : (
          <PopButton
            type="button"
            variant="secondary"
            onClick={claim}
            disabled={busy}
            icon={busy ? <Spinner /> : undefined}
          >
            Claim {formatUsdc(info.amount)} tUSDC
          </PopButton>
        )}
      </div>
      {error && (
        <p className="mt-2 font-body text-[13px] font-bold text-coral">{error}</p>
      )}
    </StickerCard>
  );
}
