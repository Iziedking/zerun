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
import { Agent, agentVariant, CoinStat, PopButton, StickerCard } from "./zerun";

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
      const metadataURI = `zerun:agent:${encodeURIComponent(agentName)}`;
      const hash = await writeContractAsync({
        abi: agentRegistryAbi,
        address: registryAddr,
        functionName: "createAgent",
        args: [metadataURI],
        chainId: zeroGGalileo.id,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

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
  const balance =
    balanceQ.data !== undefined ? formatUsdc(balanceQ.data as bigint) : "·";

  return (
    <section className="space-y-6">
      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        {/* Two big actions */}
        <div className="grid gap-5 sm:grid-cols-2">
          {/* Claim agent */}
          <StickerCard className="flex flex-col p-6">
            <h3 className="font-display text-xl text-ink">Claim your agent</h3>
            <p className="mt-1 font-body text-[14px] text-ink-2">
              Mints an agent NFT in the registry under your address.
            </p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent name"
              maxLength={32}
              disabled={!ready || claiming}
              className="mt-4 w-full rounded-chunk border-line border-ink bg-cloud-2 px-4 py-3 font-body text-[15px] font-bold text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
            />
            <PopButton
              type="button"
              onClick={claimAgent}
              disabled={!ready || claiming}
              icon={claiming ? <Spinner /> : undefined}
              className="mt-3 w-full"
            >
              Claim agent
            </PopButton>
          </StickerCard>

          {/* Get tUSDC */}
          <StickerCard className="flex flex-col p-6">
            <h3 className="font-display text-xl text-ink">Get test USDC</h3>
            <p className="mt-1 font-body text-[14px] text-ink-2">
              Mints 1000 tUSDC to your address so your agent can enter contests.
            </p>
            <div className="mt-auto pt-4">
              <PopButton
                type="button"
                variant="secondary"
                onClick={getUsdc}
                disabled={!ready || minting}
                icon={minting ? <Spinner /> : undefined}
                className="w-full"
              >
                Mint 1000 tUSDC
              </PopButton>
            </div>
          </StickerCard>
        </div>

        {/* Balance */}
        <CoinStat value={balance} suffix="tUSDC" caption="your balance" token="coin" />
      </div>

      {!ready && (
        <p className="rounded-chunk border-line border-ink bg-amber/30 px-4 py-3 font-body text-[14px] font-bold text-ink">
          Waiting on deployment from the backend. Contract addresses load from
          /api/deployment.
        </p>
      )}

      {error && (
        <p className="rounded-chunk border-line border-ink bg-coral/20 px-4 py-3 font-body text-[14px] font-bold text-ink">
          {error}
        </p>
      )}

      {/* Agent shelf */}
      <div>
        <h3 className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
          Your agents
        </h3>
        {agentsQ.isLoading ? (
          <p className="mt-2 font-body text-[15px] text-ink-2">Loading…</p>
        ) : agents.length ? (
          <ul className="mt-3 flex flex-wrap gap-5">
            {agents.map((a) => (
              <li key={a.agent_id} className="flex flex-col items-center gap-1">
                <Agent
                  variant={agentVariant(a.agent_id)}
                  mood="idle"
                  size={84}
                  name={a.name}
                />
                <span className="font-display text-[15px] text-ink">{a.name}</span>
                <span className="font-mono text-[11px] text-ink-3">#{a.agent_id}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 font-body text-[15px] text-ink-2">
            No agents yet. Claim one above to get started.
          </p>
        )}
      </div>
    </section>
  );
}

function toMessage(e: unknown): string {
  if (e instanceof Error) {
    const first = e.message.split("\n")[0];
    return first.length > 160 ? `${first.slice(0, 160)}…` : first;
  }
  return "Something went wrong.";
}
