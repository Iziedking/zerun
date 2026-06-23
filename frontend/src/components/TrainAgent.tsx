"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useSendTransaction } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseEther } from "viem";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo } from "@/lib/chain";
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
  const queryClient = useQueryClient();
  const infoQ = useQuery({ queryKey: ["computeInfo"], queryFn: () => api.computeInfo(), staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwner = Boolean(address) && address!.toLowerCase() === owner.toLowerCase();
  if (!isOwner) return null;

  const info = infoQ.data;
  const maxLevel = info?.maxLevel ?? FALLBACK_MAX;
  const atMax = level >= maxLevel;
  const cost = info && !atMax ? info.costsOg[level] : null;

  const train = async () => {
    if (!info || !address || !publicClient || cost == null) return;
    setError(null);
    setBusy(true);
    try {
      const hash = await sendTransactionAsync({
        to: info.coordinator as `0x${string}`,
        value: parseEther(String(cost)),
        chainId: zeroGGalileo.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await api.trainAgent(agentId, { owner: address, txHash: hash });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["operator"] });
    } catch (e) {
      setError(friendlyError(e, "Training did not go through. Try again."));
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
            {cost != null ? `Train to L${level + 1} for ${cost} 0G` : "Train with 0G"}
          </PopButton>
        )}
      </div>
      {error && <p className="mt-2 font-body text-[12px] font-bold text-coral">{error}</p>}
    </div>
  );
}
