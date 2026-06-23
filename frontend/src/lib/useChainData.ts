"use client";

import { useReadContract } from "wagmi";
import { agentRegistryAbi, testUsdcAbi, CONTEST_TYPE } from "./contracts";
import { useDeployment } from "./useDeployment";
import { zeroGGalileo } from "./chain";
import { formatUsdc } from "./format";

// The connected operator's test-USDC balance, formatted, refreshing on a poll.
export function useUsdcBalance(address: string | undefined) {
  const { data: deployment } = useDeployment();
  const usdcAddr = deployment?.contracts.testUSDC;
  const q = useReadContract({
    abi: testUsdcAbi,
    address: usdcAddr,
    functionName: "balanceOf",
    args: address ? [address as `0x${string}`] : undefined,
    chainId: zeroGGalileo.id,
    query: { enabled: Boolean(usdcAddr && address), refetchInterval: 8_000 },
  });
  const raw = q.data as bigint | undefined;
  return {
    raw,
    formatted: raw !== undefined ? formatUsdc(raw) : "·",
    isZero: raw !== undefined ? raw === 0n : false,
    refetch: q.refetch,
  };
}

// An agent's solver-ladder tier read from the registry (ContestType.SOLVER = 2).
export function useSolverTier(agentId: number | undefined) {
  const { data: deployment } = useDeployment();
  const registryAddr = deployment?.contracts.agentRegistry;
  const q = useReadContract({
    abi: agentRegistryAbi,
    address: registryAddr,
    functionName: "getTier",
    args: agentId !== undefined ? [BigInt(agentId), CONTEST_TYPE.solver] : undefined,
    chainId: zeroGGalileo.id,
    query: { enabled: Boolean(registryAddr && agentId !== undefined), staleTime: 30_000 },
  });
  const tier = q.data !== undefined ? Number(q.data as bigint | number) : null;
  return { tier };
}
