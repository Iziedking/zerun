"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useWalletAction } from "@/lib/walletAction";
import type { Hex } from "viem";
import { contestEngineAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo, LEGACY_TX } from "@/lib/chain";
import { Spinner } from "./ui";
import { Chip, PopButton } from "./zerun";

// A compact claim control for the "prizes to claim" nudge. It checks the real on-chain
// state first: a prize already claimed reads "Claimed", a prize that is not claimable on
// the current engine (a legacy contest from a retired engine, or one not settled here)
// reads "not claimable here" rather than offering a Claim that would fail, and only a
// genuinely claimable prize shows the button. Claims directly without navigating.
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

  const read = {
    address: engineAddr,
    abi: contestEngineAbi,
    chainId: zeroGGalileo.id,
    query: { enabled: Boolean(engineAddr && address) },
  } as const;
  const { data: onchain } = useReadContract({ ...read, functionName: "getContest", args: [BigInt(contestId)] });
  const { data: claimedOnchain } = useReadContract({
    ...read,
    functionName: "prizeClaimed",
    args: address ? [BigInt(contestId), address] : undefined,
  });

  const settledHere = Number(onchain?.status ?? 0) === 3; // 3 = SETTLED on this engine
  const alreadyClaimed = Boolean(claimedOnchain);

  // Already claimed on chain: sync the mirror so the nudge clears, and mark done.
  useEffect(() => {
    if (alreadyClaimed && address && !done) {
      api.claimed(contestId, { operator: address }).catch(() => {});
      setDone(true);
      onClaimed?.();
    }
  }, [alreadyClaimed, address, contestId, done, onClaimed]);

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
            ...LEGACY_TX,
          }),
        "Approve in your wallet to claim your prize.",
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // Only tell the backend it is claimed if the tx actually succeeded; a reverted
      // claim would otherwise be reported as "not claimed on chain".
      if (receipt.status !== "success") {
        setError("The claim did not go through on chain. It may already be claimed.");
        return;
      }
      await api.claimed(contestId, { operator: address });
      setDone(true);
      onClaimed?.();
    } catch (e) {
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
  // Loaded and not settled on the current engine: not claimable here (legacy contest or
  // one settled elsewhere). Do not offer a Claim that would revert.
  if (onchain && !settledHere) {
    return <span className="font-body text-[11px] font-bold text-ink-3">not claimable here</span>;
  }
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
