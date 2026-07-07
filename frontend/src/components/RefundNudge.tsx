"use client";

import { useAccount, useReadContracts } from "wagmi";
import { contestEngineAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { zeroGGalileo } from "@/lib/chain";
import { ClaimRefund } from "./ClaimRefund";
import { StickerCard } from "./zerun";

// Surfaces entry-fee refunds owed to the connected operator from cancelled challenges,
// so they never have to hunt for a cancelled contest to reclaim. Given the candidate
// contest ids (cancelled challenges they entered, from the profile payload), it reads
// on chain in one batch to find which still owe a refund, then shows a nudge with a
// reclaim button for each. The refund is pull-based, so the chain is the source of truth
// for whether one is still owed.
export function RefundNudge({ contestIds }: { contestIds: number[] }) {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const engineAddr = deployment?.contracts.contestEngine;

  const contracts =
    address && engineAddr
      ? contestIds.flatMap(
          (id) =>
            [
              {
                address: engineAddr,
                abi: contestEngineAbi,
                chainId: zeroGGalileo.id,
                functionName: "getContest",
                args: [BigInt(id)],
              },
              {
                address: engineAddr,
                abi: contestEngineAbi,
                chainId: zeroGGalileo.id,
                functionName: "operatorEntered",
                args: [BigInt(id), address],
              },
              {
                address: engineAddr,
                abi: contestEngineAbi,
                chainId: zeroGGalileo.id,
                functionName: "refundClaimed",
                args: [BigInt(id), address],
              },
            ] as const,
        )
      : [];

  const { data } = useReadContracts({ contracts, query: { enabled: contracts.length > 0 } });

  // A refund is owed when the contest is cancelled (status 4), has an entry fee, this
  // operator entered, and they have not already refunded.
  const owed = contestIds.filter((_, i) => {
    const contest = data?.[i * 3]?.result as { status?: number; entryFee?: bigint } | undefined;
    const entered = data?.[i * 3 + 1]?.result as boolean | undefined;
    const refunded = data?.[i * 3 + 2]?.result as boolean | undefined;
    return (
      contest != null &&
      Number(contest.status) === 4 &&
      ((contest.entryFee ?? 0n) as bigint) > 0n &&
      Boolean(entered) &&
      !refunded
    );
  });

  if (owed.length === 0) return null;

  return (
    <StickerCard className="border-amber bg-amber/15 p-5">
      <h3 className="font-display text-lg text-ink">
        You have {owed.length} refund{owed.length > 1 ? "s" : ""} to reclaim
      </h3>
      <p className="mt-1 font-body text-[14px] text-ink-2">
        Entry fees from challenges that were cancelled. Reclaim them right here, no need to
        go find the contest.
      </p>
      <div className="mt-3 space-y-2">
        {owed.map((id) => (
          <ClaimRefund key={id} contestId={id} />
        ))}
      </div>
    </StickerCard>
  );
}
