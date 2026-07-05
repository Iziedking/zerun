"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { useWalletAction } from "@/lib/walletAction";
import type { Hex } from "viem";
import { contestEngineAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo } from "@/lib/chain";
import { Spinner } from "./ui";
import { Chip, PopButton } from "./zerun";

// A compact claim control for the "prizes to claim" nudge: claims the prize directly
// (fetch the proof, claimPrize, mark claimed) without navigating to the contest, so the
// row's link can route to the contest while this button just claims. Mirrors ClaimPrize.
export function InlineClaimButton({
  contestId,
  onClaimed,
}: {
  contestId: number;
  onClaimed?: () => void;
}) {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const walletAction = useWalletAction();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engineAddr = deployment?.contracts.contestEngine;

  const claim = useCallback(async () => {
    setError(null);
    if (!engineAddr || !address || !publicClient) return;
    setBusy(true);
    try {
      const info = await api.claim(contestId, address);
      if (!info.eligible || info.claimed) {
        setDone(true);
        onClaimed?.();
        return;
      }
      const hash = await walletAction.run(
        () =>
          writeContractAsync({
            abi: contestEngineAbi,
            address: engineAddr,
            functionName: "claimPrize",
            args: [BigInt(contestId), BigInt(info.amount), info.proof as Hex[]],
            chainId: zeroGGalileo.id,
          }),
        "Approve in your wallet to claim your prize.",
      );
      await publicClient.waitForTransactionReceipt({ hash });
      await api.claimed(contestId, { operator: address });
      setDone(true);
      onClaimed?.();
    } catch (e) {
      // Landed on chain but a later step failed: a retry reverts AlreadyClaimed, which
      // means the prize is already in the wallet.
      const msg = String((e as Error)?.message ?? "");
      if (/AlreadyClaimed|already claimed/i.test(msg)) {
        await api.claimed(contestId, { operator: address }).catch(() => {});
        setDone(true);
        onClaimed?.();
      } else {
        setError(friendlyError(e, "Could not claim. Try again."));
      }
    } finally {
      setBusy(false);
    }
  }, [engineAddr, address, publicClient, contestId, writeContractAsync, walletAction, onClaimed]);

  if (done) return <Chip tone="won">Claimed</Chip>;
  return (
    <span className="flex flex-col items-end gap-1">
      <PopButton
        type="button"
        variant="secondary"
        onClick={claim}
        disabled={busy}
        icon={busy ? <Spinner /> : undefined}
      >
        Claim
      </PopButton>
      {error && <span className="font-body text-[11px] font-bold text-coral">{error}</span>}
    </span>
  );
}
