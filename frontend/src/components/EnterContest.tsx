"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useWalletAction } from "@/lib/walletAction";
import { useQueryClient } from "@tanstack/react-query";
import { contestEngineAbi, testUsdcAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useAgents } from "@/lib/useAgents";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo, LEGACY_TX } from "@/lib/chain";
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

  // The operator's standing allowance to the escrow. A challenge is a two-step flow
  // (approve, then enter); keeping the approve as its own action means the entry tx
  // runs on its own with the whole remaining window, instead of being queued behind
  // the approve and landing after the join deadline (a ContestEnded revert).
  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: usdcAddr,
    abi: testUsdcAbi,
    functionName: "allowance",
    args: address && escrowAddr ? [address, escrowAddr] : undefined,
    chainId: zeroGGalileo.id,
    query: { enabled: Boolean(usdcAddr && address && escrowAddr && entryFee > 0n) },
  });
  const allowance = (allowanceData ?? 0n) as bigint;
  const needsApprove = entryFee > 0n && allowance < entryFee;

  // Live countdown to the window close, so we can stop an operator from starting a
  // two-step challenge entry (approve, then enter) when there is not enough time for
  // the entry to land before the deadline.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const endsAtMs = contest.ends_at ? new Date(contest.ends_at).getTime() : null;
  const closesInSec = endsAtMs ? Math.floor((endsAtMs - now) / 1000) : Infinity;
  // Block starting the approve when the window is about to close: a challenge needs an
  // approve then a separate entry, and under ~45s there is not enough time for both.
  const tooSoon = needsApprove && closesInSec < 45;

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

  // Step one for a challenge: approve the escrow to pull the entry fee. Done as its
  // own action and confirmed, so the entry below is a single fast transaction.
  const approve = useCallback(async () => {
    setError(null);
    if (!escrowAddr || !usdcAddr || !publicClient || !address) {
      setError("Still loading contract addresses. Try again in a moment.");
      return;
    }
    const secLeft = endsAtMs ? Math.floor((endsAtMs - Date.now()) / 1000) : Infinity;
    if (secLeft < 45) {
      setError("This window is closing too soon to approve and then enter in time. Catch the next one.");
      return;
    }
    setBusy(true);
    try {
      const hash = await walletAction.run(
        () =>
          writeContractAsync({
            abi: testUsdcAbi,
            address: usdcAddr,
            functionName: "approve",
            args: [escrowAddr, entryFee],
            chainId: zeroGGalileo.id,
            ...LEGACY_TX,
          }),
        "Approve the entry fee. You will confirm the entry itself next.",
      );
      await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      await refetchAllowance();
    } catch (e) {
      // The receipt wait can time out or the RPC can race a tx that actually landed
      // (the wallet shows "completed" while we show an error). The chain is the truth:
      // if the allowance now covers the fee, the approve succeeded — carry on to the
      // enter step instead of showing a false failure.
      const { data: fresh } = await refetchAllowance();
      if (((fresh ?? 0n) as bigint) >= entryFee) return;
      console.error(`approve entry fee for ${contestId} failed:`, e);
      setError(friendlyError(e, "Could not approve the entry fee. Try again."));
    } finally {
      setBusy(false);
    }
  }, [escrowAddr, usdcAddr, publicClient, address, entryFee, endsAtMs, contestId, writeContractAsync, walletAction, refetchAllowance]);

  const enter = useCallback(async () => {
    setError(null);
    if (!engineAddr || !address || !publicClient || agentId === "") {
      setError("Pick one of your agents first.");
      return;
    }
    if (!feeReady) {
      setError("Reading the contest terms, one moment. Try again.");
      return;
    }
    if (needsApprove) {
      setError("Approve the entry fee first, then enter.");
      return;
    }
    setBusy(true);
    try {
      // Estimate the entry on our own node (which already sees the approve) and hand
      // the wallet an explicit gas limit, so it skips its own estimation. That
      // estimation can revert against a node lagging the approve and silently block
      // the entry. Fall back to a safe fixed limit if the estimate is unavailable.
      let gas: bigint;
      try {
        const est = await publicClient.estimateContractGas({
          address: engineAddr,
          abi: contestEngineAbi,
          functionName: "registerEntry",
          args: [BigInt(contestId), BigInt(agentId), 0n],
          account: address,
        });
        gas = (est * 12n) / 10n; // 20% headroom
      } catch {
        gas = 600_000n;
      }

      const hash = await walletAction.run(
        () =>
          writeContractAsync({
            abi: contestEngineAbi,
            address: engineAddr,
            functionName: "registerEntry",
            args: [BigInt(contestId), BigInt(agentId), 0n],
            chainId: zeroGGalileo.id,
            gas,
            ...LEGACY_TX,
          }),
        entryFee > 0n
          ? "Confirm to pay the fee and send your agent in."
          : "Approve in your wallet to send your agent in.",
      );
      await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      await api.enter(contestId, { agentId: Number(agentId), operator: address });
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: ["contest", String(contestId)] });
    } catch (e) {
      // Same truth-check as the approve: if the entry actually landed on chain (a
      // receipt timeout or a lagging RPC threw after success), finish the flow rather
      // than showing a false failure on a registered entry.
      try {
        const entered = await publicClient.readContract({
          address: engineAddr,
          abi: contestEngineAbi,
          functionName: "operatorEntered",
          args: [BigInt(contestId), address],
        });
        if (entered) {
          await api.enter(contestId, { agentId: Number(agentId), operator: address }).catch(() => {});
          setDone(true);
          await queryClient.invalidateQueries({ queryKey: ["contest", String(contestId)] });
          return;
        }
      } catch {
        /* fall through to the error message */
      }
      console.error(`enter contest ${contestId} failed:`, e);
      setError(friendlyError(e, "Could not send your agent in. Try again."));
    } finally {
      setBusy(false);
    }
  }, [
    engineAddr,
    address,
    publicClient,
    agentId,
    entryFee,
    contestId,
    feeReady,
    needsApprove,
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
          the pot when you enter.{" "}
          {needsApprove
            ? "Two quick steps: approve the fee, then enter. Approve early so your entry lands before the window closes."
            : "Approved, ready to enter."}
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
      {needsApprove ? (
        <PopButton
          type="button"
          onClick={approve}
          disabled={busy || agentId === "" || !feeReady || tooSoon}
          icon={busy ? <Spinner /> : undefined}
        >
          {!feeReady ? "Loading terms…" : tooSoon ? "Closing too soon" : "Approve entry fee"}
        </PopButton>
      ) : (
        <PopButton
          type="button"
          onClick={enter}
          disabled={busy || agentId === "" || !feeReady}
          icon={busy ? <Spinner /> : undefined}
        >
          {feeReady ? "Enter contest" : "Loading terms…"}
        </PopButton>
      )}
      {tooSoon && (
        <span className="w-full font-body text-[13px] font-bold text-coral">
          Closing too soon to enter. A challenge needs an approval then an entry, and under 45 seconds
          is not enough time for both. Catch the next one.
        </span>
      )}
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
