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
    <div className="panel border-signal/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-[10px] uppercase tracking-[0.18em] text-signal">
            you placed #{info.rank}
          </span>
          <div className="mt-0.5 font-mono text-lg text-bone">
            {formatUsdc(info.amount)} tUSDC
          </div>
        </div>
        {claimed ? (
          <span className="rounded-md border border-signal/40 bg-signal/5 px-3 py-2 text-sm font-600 text-signal">
            Claimed
          </span>
        ) : (
          <button
            type="button"
            onClick={claim}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md border border-signal/50 bg-signal/15 px-4 py-2 text-sm font-600 text-bone transition hover:bg-signal/20 disabled:opacity-50"
          >
            {busy && <Spinner className="text-signal" />}
            Claim {formatUsdc(info.amount)} tUSDC
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-ember">{error}</p>}
    </div>
  );
}
