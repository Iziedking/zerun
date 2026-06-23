"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { decodeEventLog } from "viem";
import {
  useAccount,
  usePublicClient,
  useWriteContract,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { agentRegistryAbi, contestEngineAbi, testUsdcAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useAgents, useContests } from "@/lib/useAgents";
import { useUsdcBalance } from "@/lib/useChainData";
import { kindMeta } from "@/lib/kind";
import { api } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo } from "@/lib/chain";
import { ConnectGate } from "@/components/ConnectGate";
import { Spinner } from "@/components/ui";
import {
  Agent,
  agentVariant,
  Chip,
  Confetti,
  CoinStat,
  PopButton,
  ProgressGoo,
  StickerCard,
} from "@/components/zerun";

// 100 tUSDC in 6 decimals.
const MINT_AMOUNT = 100_000000n;

type Step = 0 | 1 | 2 | 3;
const TOTAL = 4;

export default function OnboardingPage() {
  return (
    <div className="pt-10">
      <ConnectGate
        title="Connect to set up"
        subtitle="Connect a wallet to claim your agent and send it in."
      >
        <OnboardingInner />
      </ConnectGate>
    </div>
  );
}

function OnboardingInner() {
  const router = useRouter();
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();

  const agentsQ = useAgents(address);
  const contestsQ = useContests();
  const balance = useUsdcBalance(address);

  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState<number | null>(null);
  const [celebrate, setCelebrate] = useState(false);

  const registryAddr = deployment?.contracts.agentRegistry;
  const usdcAddr = deployment?.contracts.testUSDC;
  const engineAddr = deployment?.contracts.contestEngine;
  const ready = Boolean(deployment?.ready && registryAddr && usdcAddr);

  const agents = agentsQ.data?.agents ?? [];
  const myAgent = agents.find((a) => a.agent_id === agentId) ?? agents[0];
  const activeName = myAgent?.name || name.trim() || "your agent";
  const variant = agentVariant(myAgent?.agent_id ?? agentId ?? 1);

  // Easiest open contest: the smallest open pool, preferring solver flavor.
  const easiest = useMemo(() => {
    const open = (contestsQ.data?.contests ?? []).filter((c) => {
      const s = (c.status || "").toLowerCase();
      return s === "open" || s === "pending" || s === "running" || s === "active";
    });
    return [...open].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "solver" ? -1 : 1;
      const diff = BigInt(a.prize_pool) - BigInt(b.prize_pool);
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    })[0];
  }, [contestsQ.data]);

  // Step a: claim the agent NFT, then register it in the backend.
  const claim = useCallback(async () => {
    setError(null);
    if (!registryAddr || !address || !publicClient) return;
    setBusy(true);
    try {
      const metadataURI = `zerun:agent:${Date.now()}`;
      const hash = await writeContractAsync({
        abi: agentRegistryAbi,
        address: registryAddr,
        functionName: "createAgent",
        args: [metadataURI],
        chainId: zeroGGalileo.id,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      let newId: bigint | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== registryAddr.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: agentRegistryAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "AgentCreated") {
            newId = ev.args.agentId as bigint;
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (newId === null) throw new Error("Agent claimed, but no AgentCreated log was found.");

      const id = Number(newId);
      setAgentId(id);
      await api.registerAgent({ agentId: id, owner: address, name: `Agent #${id}` });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      setCelebrate(true);
      setStep(1);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [registryAddr, address, publicClient, writeContractAsync, queryClient]);

  // Step b: name it. Stored via POST /api/agents; the name shows under the character.
  const saveName = useCallback(async () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your agent a short name.");
      return;
    }
    if (!address || agentId === null) return;
    setBusy(true);
    try {
      await api.registerAgent({ agentId, owner: address, name: trimmed });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      setStep(2);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [name, address, agentId, queryClient]);

  // Step c: mint 100 tUSDC so the agent can enter.
  const mint = useCallback(async () => {
    setError(null);
    if (!usdcAddr || !address || !publicClient) return;
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        abi: testUsdcAbi,
        address: usdcAddr,
        functionName: "mint",
        args: [address, MINT_AMOUNT],
        chainId: zeroGGalileo.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await balance.refetch();
      setStep(3);
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [usdcAddr, address, publicClient, writeContractAsync, balance]);

  // Step d: send the agent into the easiest open contest.
  const sendIn = useCallback(async () => {
    setError(null);
    if (!engineAddr || !address || !publicClient || agentId === null || !easiest) return;
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        abi: contestEngineAbi,
        address: engineAddr,
        functionName: "registerEntry",
        args: [BigInt(easiest.contest_id), BigInt(agentId), 0n],
        chainId: zeroGGalileo.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await api.enter(easiest.contest_id, { agentId, operator: address });
      router.push("/arena");
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }, [engineAddr, address, publicClient, agentId, easiest, writeContractAsync, router]);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header>
        <ProgressGoo
          value={(step + 1) / TOTAL}
          fill="violet"
          label={`${step + 1} of ${TOTAL}`}
        />
      </header>

      <StickerCard className="relative overflow-hidden p-7 text-center">
        {celebrate && step === 1 && <Confetti />}
        <div className="relative">
          {/* The character reacts at every step. */}
          <div className="flex justify-center">
            <Agent
              variant={variant}
              mood={step === 0 ? "idle" : step === 3 ? "happy" : "thinking"}
              size={150}
              name={activeName}
            />
          </div>
          {step >= 1 && (
            <div className="mt-2 font-display text-xl text-ink">{activeName}</div>
          )}

          {step === 0 && (
            <Stage
              title="Claim your agent"
              body="Mint your agent as an NFT in the registry. It is yours, on chain."
            >
              <PopButton
                type="button"
                onClick={claim}
                disabled={!ready || busy}
                icon={busy ? <Spinner /> : undefined}
                className="w-full"
              >
                Claim my agent
              </PopButton>
            </Stage>
          )}

          {step === 1 && (
            <Stage title="Name it" body="Pick a short, friendly name. It sticks with your agent everywhere.">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Pixel"
                maxLength={32}
                className="w-full rounded-chunk border-line border-ink bg-cloud-2 px-4 py-3 text-center font-body text-[16px] font-bold text-ink outline-none placeholder:text-ink-3"
              />
              <PopButton
                type="button"
                onClick={saveName}
                disabled={busy}
                icon={busy ? <Spinner /> : undefined}
                className="w-full"
              >
                Save the name
              </PopButton>
            </Stage>
          )}

          {step === 2 && (
            <Stage
              title="Grab some test USDC"
              body="Mints 100 test USDC to your wallet so your agent can enter."
            >
              <div className="flex justify-center">
                <CoinStat value={balance.formatted} suffix="tUSDC" caption="your balance" />
              </div>
              <PopButton
                type="button"
                variant="secondary"
                onClick={mint}
                disabled={!ready || busy}
                icon={busy ? <Spinner /> : undefined}
                className="w-full"
              >
                Get 100 tUSDC
              </PopButton>
            </Stage>
          )}

          {step === 3 && (
            <Stage
              title="Send it to compete"
              body={
                easiest
                  ? `${kindMeta(easiest.kind).label} contest #${easiest.contest_id}, a ${formatUsdc(easiest.prize_pool)} tUSDC pool.`
                  : "No open contest right now. You can send your agent in from the arena."
              }
            >
              {easiest && (
                <div className="flex justify-center">
                  <Chip tone={kindMeta(easiest.kind).tone}>{kindMeta(easiest.kind).label}</Chip>
                </div>
              )}
              {easiest ? (
                <PopButton
                  type="button"
                  onClick={sendIn}
                  disabled={busy}
                  icon={busy ? <Spinner /> : undefined}
                  className="w-full"
                >
                  Send in {activeName}
                </PopButton>
              ) : (
                <PopButton type="button" onClick={() => router.push("/arena")} className="w-full">
                  Go to the arena
                </PopButton>
              )}
            </Stage>
          )}

          {!ready && (
            <p className="mt-5 rounded-chunk border-line border-ink bg-amber/30 px-4 py-3 font-body text-[14px] font-bold text-ink">
              Waiting on the backend deployment. Contract addresses load from /api/deployment.
            </p>
          )}
          {error && (
            <p className="mt-5 rounded-chunk border-line border-ink bg-coral/20 px-4 py-3 font-body text-[14px] font-bold text-ink">
              {error}
            </p>
          )}
        </div>
      </StickerCard>
    </div>
  );
}

function Stage({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5">
      <h1 className="font-display text-3xl text-ink">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm font-body text-[15px] leading-relaxed text-ink-2">
        {body}
      </p>
      <div className="mt-6 space-y-3">{children}</div>
    </div>
  );
}

function toMessage(e: unknown): string {
  return friendlyError(e);
}
