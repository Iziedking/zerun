"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatEther, parseEther } from "viem";
import { api } from "@/lib/api";
import { memoryEscrowAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useWalletAction } from "@/lib/walletAction";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo, LEGACY_TX } from "@/lib/chain";
import { Spinner } from "./ui";
import { Chip, PopButton, StickerCard, cx } from "./zerun";
import { ExplorerLink } from "./ExplorerLink";

// An agent's memory balance: fund it, revoke it, take it back.
//
// The three buttons here map exactly onto the contract's three owner powers, and the copy
// says what each one actually does. `depositAndAllow` funds and authorizes together (the
// normal path). `setAllowance(0)` revokes the coordinator's spending instantly without
// moving a wei. `withdraw` returns the balance, needing nobody's permission.
//
// This is the whole non-custodial claim, made operable rather than merely documented.

// A short 0G amount: enough precision to see a small balance, not so much it is noise.
function og(wei: string | bigint): string {
  const n = Number(formatEther(typeof wei === "string" ? BigInt(wei) : wei));
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

const PRESETS = ["0.05", "0.2", "1"];

export function AgentWalletPanel({ agentId, agentName }: { agentId: number; agentName?: string }) {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const walletAction = useWalletAction();

  const [amount, setAmount] = useState("0.2");
  const [busy, setBusy] = useState<"fund" | "revoke" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const walletQ = useQuery({
    queryKey: ["agentWallet", agentId],
    queryFn: () => api.agentWallet(agentId),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });

  const escrow = deployment?.contracts.memoryEscrow ?? null;
  const w = walletQ.data;

  const send = useCallback(
    async (
      job: "fund" | "revoke" | "withdraw",
      call: { functionName: string; args: readonly unknown[]; value?: bigint },
      prompt: string,
    ) => {
      setError(null);
      if (!escrow || !address || !publicClient) return;
      setBusy(job);
      try {
        const hash = await walletAction.run(
          () =>
            writeContractAsync({
              abi: memoryEscrowAbi,
              address: escrow,
              functionName: call.functionName as "depositAndAllow",
              args: call.args as [bigint],
              value: call.value,
              chainId: zeroGGalileo.id,
              ...LEGACY_TX,
            }),
          prompt,
        );
        await publicClient.waitForTransactionReceipt({ hash });
        setTx(hash);
        await walletQ.refetch();
      } catch (e) {
        setError(friendlyError(e, "That did not go through. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [escrow, address, publicClient, writeContractAsync, walletAction, walletQ],
  );

  const fund = () => {
    let value: bigint;
    try {
      value = parseEther(amount || "0");
    } catch {
      setError("Enter an amount in 0G, like 0.2");
      return;
    }
    if (value <= 0n) {
      setError("Enter an amount above zero.");
      return;
    }
    return send(
      "fund",
      { functionName: "depositAndAllow", args: [BigInt(agentId)], value },
      `Approve in your wallet to fund ${agentName ?? `agent #${agentId}`} with ${amount} 0G.`,
    );
  };

  const revoke = () =>
    send(
      "revoke",
      { functionName: "setAllowance", args: [BigInt(agentId), 0n] },
      "Approve in your wallet to revoke spending. Your balance stays where it is.",
    );

  const withdraw = () =>
    send(
      "withdraw",
      { functionName: "withdraw", args: [BigInt(agentId), BigInt(w?.balanceWei ?? "0")] },
      "Approve in your wallet to take your 0G back.",
    );

  // The market is not deployed, or this agent has no wallet yet: say nothing.
  if (!w || !w.market || !escrow || !w.address) return null;

  const balance = BigInt(w.balanceWei);
  const allowance = BigInt(w.allowanceWei);
  const revoked = balance > 0n && allowance === 0n;
  const dry = w.callsRemaining === 0;

  return (
    <StickerCard className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-xl text-ink">{agentName ?? `Agent #${agentId}`} · memory</h3>
            {revoked ? (
              <Chip tone="hot">revoked</Chip>
            ) : dry ? (
              <Chip tone="neutral">playing blind</Chip>
            ) : (
              <Chip tone="live">funded</Chip>
            )}
          </div>
          <p className="mt-1 font-body text-[13px] text-ink-2">
            Poker and chess memory is intel your agent buys. Solver and Analyst memory is free.
          </p>
        </div>
        <ExplorerLink kind="address" value={w.address} label="agent address" className="text-[11px]" />
      </div>

      {/* The numbers that decide whether it plays with memory. */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="balance" value={`${og(balance)} 0G`} />
        <Stat label="you allowed" value={`${og(allowance)} 0G`} />
        <Stat
          label="calls left"
          value={w.callsRemaining.toLocaleString()}
          tone={dry ? "coral" : undefined}
        />
        <Stat label="spent" value={`${og(w.spentWei)} 0G`} />
      </div>

      {dry && !revoked && (
        <p className="mt-3 font-body text-[13px] leading-relaxed text-ink-2">
          Unfunded, this agent plays poker and chess without its memory. It does not lose and it does not
          error — it just plays the way it did before it knew anything.
        </p>
      )}

      {revoked && (
        <p className="mt-3 font-body text-[13px] leading-relaxed text-ink-2">
          Spending is revoked. Your {og(balance)} 0G is untouched and you can withdraw it at any time.
        </p>
      )}

      {/* Fund */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setAmount(p)}
              className={cx(
                "rounded-pill border-line px-3 py-1 font-body text-[12px] font-extrabold transition",
                amount === p
                  ? "border-ink bg-violet text-white shadow-pop-press"
                  : "border-ink/25 text-ink-2 hover:border-ink hover:bg-cloud-2 hover:text-ink",
              )}
            >
              {p} 0G
            </button>
          ))}
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          aria-label="Amount of 0G to fund"
          className="w-24 rounded-chunk border-line border-ink bg-cloud px-3 py-2 font-mono text-[13px] text-ink shadow-pop-press outline-none focus:ring-2 focus:ring-violet"
        />
        <PopButton type="button" onClick={fund} disabled={busy !== null} icon={busy === "fund" ? <Spinner /> : undefined}>
          Fund memory
        </PopButton>
      </div>

      {/* The two powers the platform can never take from you. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PopButton
          type="button"
          variant="ghost"
          onClick={revoke}
          disabled={busy !== null || allowance === 0n}
          icon={busy === "revoke" ? <Spinner /> : undefined}
        >
          Revoke spending
        </PopButton>
        <PopButton
          type="button"
          variant="ghost"
          onClick={withdraw}
          disabled={busy !== null || balance === 0n}
          icon={busy === "withdraw" ? <Spinner /> : undefined}
        >
          Withdraw {og(balance)} 0G
        </PopButton>
      </div>

      <p className="mt-3 font-body text-[12px] leading-relaxed text-ink-3">
        Your 0G sits in <ExplorerLink kind="address" value={escrow} label="MemoryEscrow" className="text-[12px]" />, not
        with us. Only you can withdraw it, and we can only spend up to what you allow, only on memory. Revoking is
        instant and never moves your balance.
      </p>

      {tx && <ExplorerLink kind="tx" value={tx} label="view on 0G" className="mt-2 block text-[11px]" />}
      {error && <p className="mt-2 font-body text-[13px] font-bold text-coral">{error}</p>}
    </StickerCard>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "coral" }) {
  return (
    <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 px-3 py-2">
      <div className="font-body text-[10px] font-extrabold uppercase tracking-[0.04em] text-ink-3">{label}</div>
      <div className={cx("mt-0.5 font-display text-lg", tone === "coral" ? "text-coral" : "text-ink")}>{value}</div>
    </div>
  );
}
