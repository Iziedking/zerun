"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { contestEngineAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useAgents } from "@/lib/useAgents";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo } from "@/lib/chain";
import { Spinner } from "./ui";
import { Chip, PopButton } from "./zerun";

// registerEntry(contestId, agentId, 0); after receipt POST /enter.
export function EnterContest({ contestId }: { contestId: number }) {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const agentsQ = useAgents(address);
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();

  const agents = agentsQ.data?.agents ?? [];
  const [agentId, setAgentId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const engineAddr = deployment?.contracts.contestEngine;

  const enter = useCallback(async () => {
    setError(null);
    if (!engineAddr || !address || !publicClient || agentId === "") {
      setError("Pick one of your agents first.");
      return;
    }
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        abi: contestEngineAbi,
        address: engineAddr,
        functionName: "registerEntry",
        args: [BigInt(contestId), BigInt(agentId), 0n],
        chainId: zeroGGalileo.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await api.enter(contestId, { agentId: Number(agentId), operator: address });
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: ["contest", String(contestId)] });
    } catch (e) {
      setError(friendlyError(e, "Could not send your agent in. Try again."));
    } finally {
      setBusy(false);
    }
  }, [engineAddr, address, publicClient, agentId, contestId, writeContractAsync, queryClient]);

  if (done) {
    return (
      <div className="inline-block">
        <Chip tone="live">Entry registered. Your agent is in.</Chip>
      </div>
    );
  }

  if (!agents.length) {
    return (
      <p className="font-body text-[15px] text-ink-2">
        Claim an agent in the Arena before you can enter.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        value={agentId}
        onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : "")}
        disabled={busy}
        className="min-h-[44px] rounded-chunk border-line border-ink bg-cloud px-4 py-2 font-body text-[15px] font-bold text-ink outline-none"
      >
        <option value="">Select an agent</option>
        {agents.map((a) => (
          <option key={a.agent_id} value={a.agent_id}>
            {a.name} · #{a.agent_id}
          </option>
        ))}
      </select>
      <PopButton
        type="button"
        onClick={enter}
        disabled={busy || agentId === ""}
        icon={busy ? <Spinner /> : undefined}
      >
        Enter contest
      </PopButton>
      {error && (
        <span className="w-full font-body text-[13px] font-bold text-coral">{error}</span>
      )}
    </div>
  );
}
