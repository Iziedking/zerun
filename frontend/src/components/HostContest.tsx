"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { keccak256, toHex } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { contestEngineAbi, testUsdcAbi, CONTEST_TYPE } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useUsdcBalance } from "@/lib/useChainData";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo } from "@/lib/chain";
import type { ContestKind } from "@/lib/types";
import { Agent, Chip, PopButton, StickerCard, cx } from "./zerun";
import { Spinner } from "./ui";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const METRIC = {
  solver: keccak256(toHex("PUZZLE")),
  analyst: keccak256(toHex("PREDICTION")),
} as const;

// How the pool is split among the top finishers. topN sets how many winners share
// it; the pool is weighted so rank 1 takes the largest share, descending (the
// linear weighting the settlement uses). pct is that breakdown, for display.
const SPLITS = [
  { key: "winner", label: "Winner takes all", topN: 1, cut: 10000, pct: [100] },
  { key: "top2", label: "Top 2 split", topN: 2, cut: 7000, pct: [67, 33] },
  { key: "top3", label: "Top 3 split", topN: 3, cut: 6000, pct: [50, 33, 17] },
  { key: "top5", label: "Top 5 split", topN: 5, cut: 5000, pct: [33, 27, 20, 13, 7] },
] as const;

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"];

// "1st 50%, 2nd 33%, 3rd 17%"
function splitBreakdown(pct: readonly number[]): string {
  if (pct.length === 1) return "the winner takes the whole pool";
  return pct.map((p, i) => `${ORDINALS[i]} ${p}%`).join(", ");
}

// Turn a tUSDC amount (whole + up to 6dp) into a 6-decimal bigint.
function toSixDp(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0");
}

type Phase = "idle" | "approving" | "listing" | "saving";

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
  approving: "Approving the escrow…",
  listing: "Listing the contest…",
  saving: "Adding it to the arena…",
};

// The host-a-contest form. From the connected wallet: mint test USDC if short,
// approve the escrow, list the contest on chain, then mirror it to the backend.
export function HostContestForm({ onClose }: { onClose?: () => void }) {
  const router = useRouter();
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const balance = useUsdcBalance(address);

  const [kind, setKind] = useState<ContestKind>("solver");
  const [pool, setPool] = useState("25");
  const [minutes, setMinutes] = useState("10");
  const [count, setCount] = useState("5");
  const [splitKey, setSplitKey] = useState<(typeof SPLITS)[number]["key"]>("top3");
  const [maxOps, setMaxOps] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const split = SPLITS.find((s) => s.key === splitKey)!;

  const usdcAddr = deployment?.contracts.testUSDC;
  const engineAddr = deployment?.contracts.contestEngine;
  const escrowAddr = deployment?.contracts.prizeEscrow;
  const ready = Boolean(deployment?.ready && usdcAddr && engineAddr && escrowAddr);
  const busy = phase !== "idle";

  let poolDp = 0n;
  try {
    poolDp = toSixDp(pool.trim());
  } catch {
    /* invalid input, handled on submit */
  }
  const short = balance.raw !== undefined && poolDp > 0n && balance.raw < poolDp;

  const host = useCallback(async () => {
    setError(null);
    if (!ready || !address || !publicClient || !usdcAddr || !engineAddr || !escrowAddr) return;

    const prizePool = toSixDp(pool.trim());
    const durationSecs = Math.round(Number(minutes) * 60);
    const taskCount = Math.max(1, Math.round(Number(count)));
    if (prizePool <= 0n) {
      setError("Set a prize pool above zero.");
      return;
    }
    if (!Number.isFinite(durationSecs) || durationSecs < 60) {
      setError("Give the window at least one minute.");
      return;
    }

    // The host funds the pool from their own balance.
    const have = balance.raw ?? 0n;
    if (have < prizePool) {
      const short = (Number(prizePool - have) / 1e6).toFixed(2);
      setError(`Not enough tUSDC. You are ${short} short for this pool. Mint more on your profile, then try again.`);
      return;
    }

    try {
      // Approve the escrow to pull the prize pool.
      setPhase("approving");
      const approveHash = await writeContractAsync({
        abi: testUsdcAbi,
        address: usdcAddr,
        functionName: "approve",
        args: [escrowAddr, prizePool],
        chainId: zeroGGalileo.id,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      // The new id is the next contest id before we list.
      const nextId = await publicClient.readContract({
        address: engineAddr,
        abi: contestEngineAbi,
        functionName: "nextContestId",
      });
      const contestId = Number(nextId as bigint);

      // List the contest. cType: solver=2, analyst=1. Split sets topN and the cut.
      setPhase("listing");
      const cType = kind === "solver" ? CONTEST_TYPE.solver : CONTEST_TYPE.analyst;
      const listHash = await writeContractAsync({
        abi: contestEngineAbi,
        address: engineAddr,
        functionName: "listContest",
        args: [cType, ZERO_ADDRESS, METRIC[kind], prizePool, BigInt(durationSecs), split.cut, split.topN, 0, 4],
        chainId: zeroGGalileo.id,
      });
      await publicClient.waitForTransactionReceipt({ hash: listHash });

      // Mirror it to the backend so it shows in the arena.
      setPhase("saving");
      const maxOperators = maxOps.trim() ? Math.max(1, Math.round(Number(maxOps))) : 0;
      await api.hostContest({ contestId, kind, puzzleCount: taskCount, maxOperators });
      await queryClient.invalidateQueries({ queryKey: ["contests"] });
      await balance.refetch();

      onClose?.();
      router.push(`/contest/${contestId}`);
    } catch (e) {
      setError(friendlyError(e, "Could not host the contest. Give it another go."));
      setPhase("idle");
    }
  }, [
    ready,
    address,
    publicClient,
    usdcAddr,
    engineAddr,
    escrowAddr,
    pool,
    minutes,
    count,
    kind,
    split,
    maxOps,
    balance,
    writeContractAsync,
    queryClient,
    onClose,
    router,
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Agent variant="amber" mood="happy" size={64} />
        <div>
          <h2 className="font-display text-2xl text-ink">Host a contest</h2>
          <p className="font-body text-[14px] text-ink-2">
            Set up an arena and put up the pool. Any operator can send an agent in.
          </p>
        </div>
      </div>

      {/* Kind */}
      <div>
        <Label>Flavor</Label>
        <div className="mt-2 flex gap-2">
          <KindOption active={kind === "solver"} onClick={() => setKind("solver")}>
            Puzzles
          </KindOption>
          <KindOption active={kind === "analyst"} onClick={() => setKind("analyst")}>
            Predictions
          </KindOption>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Prize pool (tUSDC)">
          <input
            inputMode="decimal"
            value={pool}
            onChange={(e) => setPool(e.target.value)}
            disabled={busy}
            className={inputCx}
          />
        </Field>
        <Field label="Window (minutes)">
          <input
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            disabled={busy}
            className={inputCx}
          />
        </Field>
        <Field label={kind === "analyst" ? "Markets" : "Puzzles"}>
          <input
            inputMode="numeric"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            disabled={busy}
            className={inputCx}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Winners split">
          <select
            value={splitKey}
            onChange={(e) => setSplitKey(e.target.value as (typeof SPLITS)[number]["key"])}
            disabled={busy}
            className={inputCx}
          >
            {SPLITS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label} ({s.pct.join("/")})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Max operators (optional)">
          <input
            inputMode="numeric"
            value={maxOps}
            onChange={(e) => setMaxOps(e.target.value)}
            placeholder="no limit"
            disabled={busy}
            className={inputCx}
          />
        </Field>
      </div>
      <p className="font-body text-[12px] text-ink-3">
        Split: {splitBreakdown(split.pct)}.
        {maxOps.trim() ? ` Up to ${maxOps} operators can join.` : " Open to any number of operators."}
      </p>

      <p className="font-body text-[13px] text-ink-2">
        Your balance:{" "}
        <span className={cx("font-display", short ? "text-coral" : "text-ink")}>
          {balance.formatted} tUSDC
        </span>
        . The pool is charged from this when you host.
      </p>

      {busy && (
        <div className="flex items-center justify-center gap-2 rounded-chunk border-line border-ink bg-cloud-2 px-4 py-3">
          <Spinner />
          <span className="font-body text-[14px] font-bold text-ink">{PHASE_LABEL[phase]}</span>
        </div>
      )}

      {!ready && (
        <p className="rounded-chunk border-line border-ink bg-amber/30 px-4 py-3 font-body text-[14px] font-bold text-ink">
          Waiting on the backend deployment. Contract addresses load from /api/deployment.
        </p>
      )}
      {error && (
        <p className="rounded-chunk border-line border-ink bg-coral/20 px-4 py-3 font-body text-[14px] font-bold text-ink">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {onClose && (
          <PopButton type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </PopButton>
        )}
        <PopButton
          type="button"
          onClick={host}
          disabled={!ready || busy || short}
          icon={busy ? <Spinner /> : undefined}
        >
          {short ? "Not enough tUSDC" : "Host it"}
        </PopButton>
      </div>
    </div>
  );
}

// A centered modal wrapper around the form.
export function HostContestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <StickerCard
        className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto p-5 motion-safe:animate-pop-in sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <HostContestForm onClose={onClose} />
      </StickerCard>
    </div>
  );
}

const inputCx =
  "w-full rounded-chunk border-line border-ink bg-cloud-2 px-3 py-2.5 font-body text-[15px] font-bold text-ink outline-none placeholder:text-ink-3 disabled:opacity-60";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
      {children}
    </span>
  );
}

function KindOption({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex-1 rounded-chunk border-line border-ink px-4 py-2.5 font-body text-[14px] font-extrabold transition",
        active ? "bg-violet text-white shadow-pop-press" : "bg-cloud text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
