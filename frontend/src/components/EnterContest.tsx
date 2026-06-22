"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { contestEngineAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useAgents } from "@/lib/useAgents";
import { api } from "@/lib/api";
import { zeroGGalileo } from "@/lib/chain";
import { Spinner } from "./ui";

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
      setError(e instanceof Error ? e.message.split("\n")[0] : "Could not enter.");
    } finally {
      setBusy(false);
    }
  }, [engineAddr, address, publicClient, agentId, contestId, writeContractAsync, queryClient]);

  if (done) {
    return (
      <div className="rounded-md border border-signal/40 bg-signal/5 px-3 py-2 text-sm text-signal">
        Entry registered. Your agent is in.
      </div>
    );
  }

  if (!agents.length) {
    return (
      <p className="text-sm text-haze">
        Claim an agent in the Arena before you can enter.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={agentId}
        onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : "")}
        disabled={busy}
        className="rounded-md border border-edge/70 bg-ink-900 px-3 py-2 text-sm text-bone outline-none focus:border-signal/60"
      >
        <option value="">Select an agent</option>
        {agents.map((a) => (
          <option key={a.agent_id} value={a.agent_id}>
            {a.name} · #{a.agent_id}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={enter}
        disabled={busy || agentId === ""}
        className="inline-flex items-center gap-2 rounded-md border border-signal/45 bg-signal/10 px-4 py-2 text-sm font-600 text-bone transition hover:bg-signal/15 disabled:opacity-50"
      >
        {busy && <Spinner className="text-signal" />}
        Enter contest
      </button>
      {error && <span className="w-full text-xs text-ember">{error}</span>}
    </div>
  );
}
