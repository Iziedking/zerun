"use client";

import { useCallback, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useWalletAction } from "@/lib/walletAction";
import { useQueryClient } from "@tanstack/react-query";
import { contestEngineAbi, testUsdcAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useAgents } from "@/lib/useAgents";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo } from "@/lib/chain";
import type { ContestSummary, Standing } from "@/lib/types";
import { joinOpen } from "@/lib/phase";
import { Spinner } from "./ui";
import { agentVariant, Chip, PopButton, SkinnedAgent } from "./zerun";

// registerEntry(contestId, agentId, 0); after receipt POST /enter.
//
// Guards the UI to one agent per operator per contest using the contest's
// standings: if the connected operator already has an agent in, it shows that
// agent instead of the picker; otherwise it lists the operator's agents that are
// not already entered. The form hides once the join window has closed. 409s from
// POST /enter route through friendlyError.
export function EnterContest({
  contestId,
  contest,
  standings,
}: {
  contestId: number;
  contest: Pick<ContestSummary, "status" | "ends_at" | "settled_at">;
  standings: Standing[];
}) {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const agentsQ = useAgents(address);
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const walletAction = useWalletAction();
  const queryClient = useQueryClient();

  const myAgents = agentsQ.data?.agents ?? [];
  const [agentId, setAgentId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const engineAddr = deployment?.contracts.contestEngine;
  const escrowAddr = deployment?.contracts.prizeEscrow;
  const usdcAddr = deployment?.contracts.testUSDC;

  // The on-chain entry fee (a challenge). registerEntry pulls it, so the operator
  // approves the escrow for it first.
  const {
    data: onchainContest,
    isSuccess: feeReady,
    isError: feeError,
  } = useReadContract({
    address: engineAddr,
    abi: contestEngineAbi,
    functionName: "getContest",
    args: [BigInt(contestId)],
    chainId: zeroGGalileo.id,
    query: { enabled: Boolean(engineAddr) },
  });
  const entryFee = (onchainContest?.entryFee ?? 0n) as bigint;

  // Only allow entering while the join window is open.
  const windowOpen = joinOpen(contest);

  // Which of the operator's agents are already entered, and which are free.
  const lowerAddr = address?.toLowerCase();
  const myEntry = useMemo(
    () => (lowerAddr ? standings.find((s) => s.operator?.toLowerCase() === lowerAddr) : undefined),
    [standings, lowerAddr],
  );

  const enteredIds = useMemo(() => {
    const set = new Set<number>();
    for (const s of standings) {
      if (lowerAddr && s.operator?.toLowerCase() === lowerAddr) set.add(s.agentId);
    }
    return set;
  }, [standings, lowerAddr]);

  // Only agents not already entered here and not busy in another open contest.
  const available = useMemo(
    () => myAgents.filter((a) => !enteredIds.has(a.agent_id) && !a.in_contest),
    [myAgents, enteredIds],
  );

  const enter = useCallback(async () => {
    setError(null);
    if (!engineAddr || !address || !publicClient || agentId === "") {
      setError("Pick one of your agents first.");
      return;
    }
    // The entry fee decides whether we must approve first. Never send registerEntry
    // until that on-chain read has resolved, or a challenge entry would skip the
    // approve and revert on allowance.
    if (!feeReady) {
      setError("Reading the contest terms, one moment. Try again.");
      return;
    }
    if (entryFee > 0n && (!escrowAddr || !usdcAddr)) {
      setError("Still loading contract addresses. Try again in a moment.");
      return;
    }
    setBusy(true);
    try {
      // A challenge pulls the entry fee on registerEntry, so the escrow must be
      // approved first. Only approve if the existing allowance does not already cover
      // the fee: re-approving every time adds a needless popup and, worse, races the
      // spend (the wallet estimates registerEntry against a node that may still show
      // the stale allowance and blocks it). Skipping the redundant approve avoids both.
      let approved = false;
      if (entryFee > 0n && escrowAddr && usdcAddr) {
        const current = (await publicClient.readContract({
          address: usdcAddr,
          abi: testUsdcAbi,
          functionName: "allowance",
          args: [address, escrowAddr],
        })) as bigint;
        if (current < entryFee) {
          const approveHash = await walletAction.run(
            () =>
              writeContractAsync({
                abi: testUsdcAbi,
                address: usdcAddr,
                functionName: "approve",
                args: [escrowAddr, entryFee],
                chainId: zeroGGalileo.id,
              }),
            "Step 1 of 2: approve the entry fee in your wallet.",
          );
          await publicClient.waitForTransactionReceipt({ hash: approveHash });
          approved = true;
        }
      }

      const hash = await walletAction.run(
        () =>
          writeContractAsync({
            abi: contestEngineAbi,
            address: engineAddr,
            functionName: "registerEntry",
            args: [BigInt(contestId), BigInt(agentId), 0n],
            chainId: zeroGGalileo.id,
          }),
        entryFee > 0n
          ? approved
            ? "Step 2 of 2: pay the fee and send your agent in."
            : "Confirm in your wallet to pay the fee and send your agent in."
          : "Approve in your wallet to send your agent in.",
      );
      await publicClient.waitForTransactionReceipt({ hash });
      await api.enter(contestId, { agentId: Number(agentId), operator: address });
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: ["contest", String(contestId)] });
    } catch (e) {
      setError(friendlyError(e, "Could not send your agent in. Try again."));
    } finally {
      setBusy(false);
    }
  }, [
    engineAddr,
    escrowAddr,
    usdcAddr,
    entryFee,
    address,
    publicClient,
    agentId,
    contestId,
    feeReady,
    writeContractAsync,
    walletAction,
    queryClient,
  ]);

  // The operator already has an agent in this contest (one per operator). Show it.
  if (myEntry) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <SkinnedAgent
          agentId={myEntry.agentId}
          variant={agentVariant(myEntry.agentId)}
          mood="happy"
          size={56}
          name={myEntry.agentName}
        />
        <div>
          <Chip tone="live">your agent is in</Chip>
          <p className="mt-1 font-body text-[15px] font-bold text-ink">
            {myEntry.agentName} is in this contest.
          </p>
        </div>
      </div>
    );
  }

  // Window closed and the operator never entered: nothing to do here.
  if (!windowOpen) {
    return (
      <p className="font-body text-[15px] text-ink-2">
        Entries are closed for this contest. The agents are competing now.
      </p>
    );
  }

  // Just entered this session.
  if (done) {
    return (
      <div className="inline-block">
        <Chip tone="live">Entry registered. Your agent is in.</Chip>
      </div>
    );
  }

  if (!myAgents.length) {
    return (
      <p className="font-body text-[15px] text-ink-2">
        Claim an agent in the Arena before you can enter.
      </p>
    );
  }

  if (!available.length) {
    return (
      <p className="font-body text-[15px] text-ink-2">
        Your agents are already competing in other contests. They free up to enter again once those
        settle.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {entryFee > 0n && (
        <span className="w-full font-body text-[13px] font-bold text-ink-2">
          This is a challenge. Entry fee{" "}
          <span className="font-display text-ink">{(Number(entryFee) / 1e6).toFixed(2)} tUSDC</span>, paid to
          the pot when you enter.
        </span>
      )}
      <select
        value={agentId}
        onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : "")}
        disabled={busy}
        className="min-h-[44px] w-full rounded-chunk border-line border-ink bg-cloud px-4 py-2 font-body text-[15px] font-bold text-ink outline-none sm:w-auto"
      >
        <option value="">Select an agent</option>
        {available.map((a) => (
          <option key={a.agent_id} value={a.agent_id}>
            {a.name} · #{a.agent_id}
          </option>
        ))}
      </select>
      <PopButton
        type="button"
        onClick={enter}
        disabled={busy || agentId === "" || !feeReady}
        icon={busy ? <Spinner /> : undefined}
      >
        {feeReady ? "Enter contest" : "Loading terms…"}
      </PopButton>
      {feeError && (
        <span className="w-full font-body text-[13px] font-bold text-coral">
          Could not read the contest terms. Check your connection and refresh.
        </span>
      )}
      {error && (
        <span className="w-full font-body text-[13px] font-bold text-coral">{error}</span>
      )}
    </div>
  );
}
