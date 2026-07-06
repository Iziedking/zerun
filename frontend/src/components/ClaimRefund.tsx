"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useWalletAction } from "@/lib/walletAction";
import { contestEngineAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { formatUsdc } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo, LEGACY_TX } from "@/lib/chain";
import { Spinner } from "./ui";
import { Chip, PopButton, StickerCard } from "./zerun";
import { ExplorerLink } from "./ExplorerLink";

// Pull-based entry-fee refund for a cancelled challenge. Self-gating: it reads the
// on-chain entry fee, whether the connected operator entered, and whether they have
// already refunded, and renders nothing unless a refund is actually owed. Only a
// cancelled challenge (entryFee > 0) has fees to return; a staked contest refunds
// the sponsor directly on cancel, so there is nothing to claim here.
export function ClaimRefund({ contestId }: { contestId: number }) {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const walletAction = useWalletAction();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [tx, setTx] = useState<string | null>(null);

  const engineAddr = deployment?.contracts.contestEngine;
  const enabled = Boolean(engineAddr && address);
  const read = {
    address: engineAddr,
    abi: contestEngineAbi,
    chainId: zeroGGalileo.id,
    query: { enabled },
  } as const;

  const { data: onchain } = useReadContract({ ...read, functionName: "getContest", args: [BigInt(contestId)] });
  const { data: entered } = useReadContract({
    ...read,
    functionName: "operatorEntered",
    args: address ? [BigInt(contestId), address] : undefined,
  });
  const { data: refunded } = useReadContract({
    ...read,
    functionName: "refundClaimed",
    args: address ? [BigInt(contestId), address] : undefined,
  });

  const entryFee = (onchain?.entryFee ?? 0n) as bigint;
  const status = Number(onchain?.status ?? 0); // 4 = CANCELLED
  const owed = status === 4 && entryFee > 0n && Boolean(entered) && !refunded && !done;

  const claim = useCallback(async () => {
    setError(null);
    if (!engineAddr || !address || !publicClient) return;
    setBusy(true);
    try {
      const hash = await walletAction.run(
        () =>
          writeContractAsync({
            abi: contestEngineAbi,
            address: engineAddr,
            functionName: "claimRefund",
            args: [BigInt(contestId)],
            chainId: zeroGGalileo.id,
            ...LEGACY_TX,
          }),
        "Approve in your wallet to reclaim your entry fee.",
      );
      await publicClient.waitForTransactionReceipt({ hash });
      setTx(hash);
      setDone(true);
    } catch (e) {
      // The tx can land on chain while a later step fails; a retry then reverts with
      // AlreadyRefunded, which means the fee is already back in the wallet.
      const msg = String((e as Error)?.message ?? "");
      if (/AlreadyRefunded|already refunded/i.test(msg)) {
        setDone(true);
      } else {
        setError(friendlyError(e, "Could not reclaim that one. Try again."));
      }
    } finally {
      setBusy(false);
    }
  }, [engineAddr, address, publicClient, contestId, writeContractAsync, walletAction]);

  if (!owed && !done) return null;

  return (
    <StickerCard className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
            challenge cancelled
          </span>
          <div className="mt-0.5 font-display text-2xl text-ink">
            {formatUsdc(entryFee.toString())}{" "}
            <span className="font-body text-base font-extrabold text-ink-2">tUSDC entry fee</span>
          </div>
        </div>
        {done ? (
          <div className="flex flex-col items-end gap-1">
            <Chip tone="won">Refunded</Chip>
            {tx && <ExplorerLink kind="tx" value={tx} label="view refund on 0G" className="text-[11px]" />}
          </div>
        ) : (
          <PopButton
            type="button"
            variant="secondary"
            onClick={claim}
            disabled={busy}
            icon={busy ? <Spinner /> : undefined}
          >
            Reclaim {formatUsdc(entryFee.toString())} tUSDC
          </PopButton>
        )}
      </div>
      {error && <p className="mt-2 font-body text-[13px] font-bold text-coral">{error}</p>}
    </StickerCard>
  );
}
