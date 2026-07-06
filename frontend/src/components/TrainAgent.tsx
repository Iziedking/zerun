"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useSendTransaction } from "wagmi";
import { useWalletAction } from "@/lib/walletAction";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseEther } from "viem";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo, LEGACY_TX } from "@/lib/chain";
import { Chip, PopButton, cx } from "./zerun";
import { Spinner } from "./ui";

const LEVEL_NAMES = ["Base", "Spark", "Sharp", "Deep", "Elite", "Apex"];
const FALLBACK_MAX = 5;

// Train an agent's Compute, the single 0G-funded skill dial. Owner only. Sends 0G
// to the coordinator (which funds the 0G Compute ledger), then credits one level.
export function TrainAgent({
  agentId,
  level,
  owner,
}: {
  agentId: number;
  level: number;
  owner: string;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const walletAction = useWalletAction();
  const queryClient = useQueryClient();
  const infoQ = useQuery({ queryKey: ["computeInfo"], queryFn: () => api.computeInfo(), staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A training payment that landed on chain but has not been credited yet (a receipt
  // wait that timed out, or the coordinator lagging the tx). Persisted per agent so a
  // page refresh survives it. On the next attempt we re-submit this same txHash to be
  // credited instead of paying again, so a retry can never debit 0G twice.
  const pendingKey = `zerun:train:${agentId}`;
  const [pendingTx, setPendingTx] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window !== "undefined") setPendingTx(window.localStorage.getItem(pendingKey));
  }, [pendingKey]);

  const isOwner = Boolean(address) && address!.toLowerCase() === owner.toLowerCase();
  if (!isOwner) return null;

  const info = infoQ.data;
  const maxLevel = info?.maxLevel ?? FALLBACK_MAX;
  const atMax = level >= maxLevel;
  const cost = info && !atMax ? info.costsOg[level] : null;

  const rememberPending = (hash: string | null) => {
    setPendingTx(hash);
    if (typeof window === "undefined") return;
    if (hash) window.localStorage.setItem(pendingKey, hash);
    else window.localStorage.removeItem(pendingKey);
  };

  const train = async () => {
    if (!info || !address || !publicClient || cost == null) return;
    setError(null);
    setBusy(true);
    try {
      // Reuse a payment already made but not credited; otherwise send a new one and
      // remember it the moment it is broadcast, so any failure below retries the same
      // payment rather than charging again.
      let hash = pendingTx as `0x${string}` | null;
      if (!hash) {
        hash = await walletAction.run(
          () =>
            sendTransactionAsync({
              to: info.coordinator as `0x${string}`,
              value: parseEther(String(cost)),
              chainId: zeroGGalileo.id,
              ...LEGACY_TX,
            }),
          "Approve the 0G payment in your wallet to train your agent.",
        );
        rememberPending(hash);
      }
      // Best effort: the credit endpoint verifies the receipt itself, so a slow or
      // timed-out wait here should not block or re-throw.
      await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 }).catch(() => {});
      await api.trainAgent(agentId, { owner: address, txHash: hash });
      rememberPending(null); // credited: clear the pending payment
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["operator"] });
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      if (/already used/i.test(msg)) {
        // This payment was already credited on a prior attempt: it worked, clear it.
        rememberPending(null);
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
        await queryClient.invalidateQueries({ queryKey: ["operator"] });
      } else {
        // The payment stays remembered, so clicking again finishes it for free.
        setError(
          friendlyError(
            e,
            "Payment sent but not credited yet. Give it a moment, then click again to finish — you will not pay twice.",
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
          Compute
        </span>
        <Chip tone="info">
          L{level} {LEVEL_NAMES[Math.min(level, LEVEL_NAMES.length - 1)]}
        </Chip>
      </div>

      {/* level pips */}
      <div className="mt-2 flex gap-1">
        {Array.from({ length: maxLevel }, (_, i) => (
          <span
            key={i}
            className={cx(
              "h-2 flex-1 rounded-pill border-line border-ink/30",
              i < level ? "bg-violet" : "bg-cloud",
            )}
            aria-hidden
          />
        ))}
      </div>

      <div className="mt-3">
        {atMax ? (
          <Chip tone="won">Maxed on 0G</Chip>
        ) : (
          <PopButton
            type="button"
            onClick={() => void train()}
            disabled={busy || !info}
            icon={busy ? <Spinner /> : undefined}
          >
            {pendingTx
              ? "Finish training (already paid)"
              : cost != null
                ? `Train to L${level + 1} for ${cost} 0G`
                : "Train with 0G"}
          </PopButton>
        )}
      </div>
      {pendingTx && !error && (
        <p className="mt-2 font-body text-[12px] font-bold text-ink-2">
          A 0G payment is waiting to be credited. Click Finish to complete this level — you will not
          be charged again.
        </p>
      )}
      {error && <p className="mt-2 font-body text-[12px] font-bold text-coral">{error}</p>}
    </div>
  );
}
