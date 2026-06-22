"use client";

import { useCallback, useState } from "react";
import { decodeEventLog } from "viem";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { agentRegistryAbi, testUsdcAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useAgents } from "@/lib/useAgents";
import { api } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { zeroGGalileo } from "@/lib/chain";
import { Spinner } from "./ui";

// 1000 tUSDC in 6 decimals.
const MINT_AMOUNT = 1000_000000n;

export function OnboardingStrip() {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const agentsQ = useAgents(address);
  const queryClient = useQueryClient();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [claiming, setClaiming] = useState(false);
  const [minting, setMinting] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const usdcAddr = deployment?.contracts.testUSDC;
  const registryAddr = deployment?.contracts.agentRegistry;

  const balanceQ = useReadContract({
    abi: testUsdcAbi,
    address: usdcAddr,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: zeroGGalileo.id,
    query: { enabled: Boolean(usdcAddr && address), refetchInterval: 8_000 },
  });

  const claimAgent = useCallback(async () => {
    setError(null);
    if (!registryAddr || !address || !publicClient) return;
    const agentName = name.trim();
    if (!agentName) {
      setError("Give your agent a short name first.");
      return;
    }
    setClaiming(true);
    try {
      // A simple metadata string; storage of richer metadata is out of scope here.
      const metadataURI = `zerun:agent:${encodeURIComponent(agentName)}`;
      const hash = await writeContractAsync({
        abi: agentRegistryAbi,
        address: registryAddr,
        functionName: "createAgent",
        args: [metadataURI],
        chainId: zeroGGalileo.id,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Read the new agentId out of the AgentCreated log on the registry.
      let newAgentId: bigint | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== registryAddr.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({
            abi: agentRegistryAbi,
            data: log.data,
            topics: log.topics,
          });
          if (ev.eventName === "AgentCreated") {
            newAgentId = ev.args.agentId as bigint;
            break;
          }
        } catch {
          /* not our event; skip */
        }
      }
      if (newAgentId === null) {
        throw new Error("createAgent confirmed but no AgentCreated log was found.");
      }

      await api.registerAgent({
        agentId: Number(newAgentId),
        owner: address,
        name: agentName,
      });
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setClaiming(false);
    }
  }, [registryAddr, address, publicClient, name, writeContractAsync, queryClient]);

  const getUsdc = useCallback(async () => {
    setError(null);
    if (!usdcAddr || !address || !publicClient) return;
    setMinting(true);
    try {
      const hash = await writeContractAsync({
        abi: testUsdcAbi,
        address: usdcAddr,
        functionName: "mint",
        args: [address, MINT_AMOUNT],
        chainId: zeroGGalileo.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await balanceQ.refetch();
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setMinting(false);
    }
  }, [usdcAddr, address, publicClient, writeContractAsync, balanceQ]);

  const ready = Boolean(deployment?.ready && registryAddr && usdcAddr);
  const agents = agentsQ.data?.agents ?? [];

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-600 uppercase tracking-[0.16em] text-haze">
            Get set up
          </h2>
          <p className="mt-1 text-sm text-chalk">
            Claim an agent and fund it with test USDC. Two actions, then you are ready.
          </p>
        </div>
        <div className="text-right">
          <span className="text-[10px] uppercase tracking-[0.18em] text-haze">
            tUSDC balance
          </span>
          <div className="font-mono text-lg text-bone">
            {balanceQ.data !== undefined ? formatUsdc(balanceQ.data as bigint) : "—"}
          </div>
        </div>
      </div>

      {!ready && (
        <p className="mt-4 rounded-md border border-amber/40 bg-amber/5 px-3 py-2 text-xs text-amber">
          Waiting on deployment from the backend. Contract addresses load from
          /api/deployment.
        </p>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {/* Claim agent */}
        <div className="rounded-md border border-edge/60 bg-ink-800/60 p-4">
          <h3 className="text-sm font-600 text-bone">Claim your agent</h3>
          <p className="mt-1 text-xs text-haze">
            Mints an agent NFT in the registry under your address.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent name"
              maxLength={32}
              disabled={!ready || claiming}
              className="min-w-0 flex-1 rounded-md border border-edge/70 bg-ink-900 px-3 py-2 text-sm text-bone outline-none placeholder:text-haze focus:border-signal/60"
            />
            <button
              type="button"
              onClick={claimAgent}
              disabled={!ready || claiming}
              className="inline-flex items-center gap-2 rounded-md border border-signal/45 bg-signal/10 px-3.5 py-2 text-sm font-600 text-bone transition hover:bg-signal/15 disabled:opacity-50"
            >
              {claiming && <Spinner className="text-signal" />}
              Claim
            </button>
          </div>
        </div>

        {/* Get tUSDC */}
        <div className="rounded-md border border-edge/60 bg-ink-800/60 p-4">
          <h3 className="text-sm font-600 text-bone">Get test USDC</h3>
          <p className="mt-1 text-xs text-haze">Mints 1000 tUSDC to your address.</p>
          <button
            type="button"
            onClick={getUsdc}
            disabled={!ready || minting}
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-edge/70 px-3.5 py-2 text-sm font-600 text-chalk transition hover:border-signal/50 hover:text-bone disabled:opacity-50"
          >
            {minting && <Spinner />}
            Mint 1000 tUSDC
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-ember/40 bg-ember/5 px-3 py-2 text-xs text-ember">
          {error}
        </p>
      )}

      {/* Agents */}
      <div className="mt-5">
        <h3 className="text-[10px] uppercase tracking-[0.18em] text-haze">Your agents</h3>
        {agentsQ.isLoading ? (
          <p className="mt-2 text-sm text-haze">Loading…</p>
        ) : agents.length ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {agents.map((a) => (
              <li
                key={a.agent_id}
                className="flex items-center gap-2 rounded-md border border-edge/60 bg-ink-700 px-3 py-1.5"
              >
                <span className="text-sm font-500 text-bone">{a.name}</span>
                <span className="font-mono text-[11px] text-signal">#{a.agent_id}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-haze">
            No agents yet. Claim one above to get started.
          </p>
        )}
      </div>
    </section>
  );
}

function toMessage(e: unknown): string {
  if (e instanceof Error) {
    // Trim noisy wallet error bodies.
    const first = e.message.split("\n")[0];
    return first.length > 160 ? `${first.slice(0, 160)}…` : first;
  }
  return "Something went wrong.";
}
