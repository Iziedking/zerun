"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { keccak256, parseEventLogs, toHex } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { useWalletAction } from "@/lib/walletAction";
import { useQueryClient } from "@tanstack/react-query";
import { contestEngineAbi, testUsdcAbi, CONTEST_TYPE } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useUsdcBalance } from "@/lib/useChainData";
import { api, reportClientError } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo, LEGACY_TX } from "@/lib/chain";
import { Agent, Chip, KindIcon, PopButton, StickerCard, cx } from "./zerun";
import { WorldCupBanner } from "./WorldCupBanner";
import { Spinner } from "./ui";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const METRIC = {
  solver: keccak256(toHex("PUZZLE")),
  analyst: keccak256(toHex("PREDICTION")),
  poker: keccak256(toHex("POKER")),
  worldcup: keccak256(toHex("WORLDCUP")),
} as const;

type HostKind = "solver" | "analyst" | "poker" | "worldcup";

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
export function HostContestForm({
  onClose,
  onBusyChange,
}: {
  onClose?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const walletAction = useWalletAction();
  const queryClient = useQueryClient();
  const balance = useUsdcBalance(address);

  const [kind, setKind] = useState<HostKind>("solver");
  // Two distinct ways to fund the prize. A contest: the host stakes a pool and entry
  // is free. A challenge: entrants each stake an entry fee and those fees are the pot.
  const [mode, setMode] = useState<"contest" | "challenge">("contest");
  const [amount, setAmount] = useState("25");
  const [minutes, setMinutes] = useState("10");
  const [count, setCount] = useState("5");
  const [splitKey, setSplitKey] = useState<(typeof SPLITS)[number]["key"]>("top3");
  const [maxOps, setMaxOps] = useState("");
  const [pokerSeats, setPokerSeats] = useState("2");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const isPoker = kind === "poker";
  const isChallenge = mode === "challenge";
  // A poker duel is fixed: two seats, winner takes the whole pool.
  const split = isPoker ? SPLITS[0]! : SPLITS.find((s) => s.key === splitKey)!;

  const usdcAddr = deployment?.contracts.testUSDC;
  const engineAddr = deployment?.contracts.contestEngine;
  const escrowAddr = deployment?.contracts.prizeEscrow;
  const ready = Boolean(deployment?.ready && usdcAddr && engineAddr && escrowAddr);
  const busy = phase !== "idle";

  // Report busy state up so a wrapping modal can block a dismiss mid-transaction.
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // In contest mode the host funds the pool from their balance; in challenge mode
  // entrants build the pot, so the host stakes nothing and can never fall short.
  let amountDp = 0n;
  try {
    amountDp = toSixDp(amount.trim());
  } catch {
    /* invalid input, handled on submit */
  }
  const short = !isChallenge && balance.raw !== undefined && amountDp > 0n && balance.raw < amountDp;

  const host = useCallback(async () => {
    setError(null);
    if (!ready || !address || !publicClient || !usdcAddr || !engineAddr || !escrowAddr) return;

    // Validate the amount before any BigInt parsing. Bad input (a stray letter, a
    // second dot, a negative) would otherwise throw an unhandled rejection and leave
    // the button silently dead.
    const amt = amount.trim();
    if (!/^\d+(\.\d{1,6})?$/.test(amt) || Number(amt) <= 0) {
      setError(
        isChallenge
          ? "Enter a valid entry fee (up to 6 decimals)."
          : "Enter a valid prize pool (up to 6 decimals).",
      );
      return;
    }

    const amountDp = toSixDp(amt);
    const prizePool = isChallenge ? 0n : amountDp;
    const entryFeeDp = isChallenge ? amountDp : 0n;
    const durationSecs = Math.round(Number(minutes) * 60);
    const taskCount = Math.max(1, Math.round(Number(count)));
    if (amountDp <= 0n) {
      setError(isChallenge ? "Set an entry fee for the challenge." : "Set a prize pool for the contest.");
      return;
    }
    if (!Number.isFinite(durationSecs) || durationSecs < 60) {
      setError("Give the window at least one minute.");
      return;
    }

    // The host funds only the staked base pool from their own balance; on a pure
    // entry-fee challenge they stake nothing and entrants build the pot. listContest
    // also pulls a listing fee (bps of the pool) from the sponsor, so the approval and
    // the balance check cover the pool plus that fee. The fee is 0 today, but reading
    // it keeps hosting working if an admin ever turns it on.
    let listingFee = 0n;
    if (prizePool > 0n) {
      try {
        const bps = (await publicClient.readContract({
          address: engineAddr,
          abi: contestEngineAbi,
          functionName: "listingFeeBps",
        })) as number;
        listingFee = (prizePool * BigInt(bps)) / 10_000n;
      } catch {
        /* fee unreadable: assume 0 */
      }
      const need = prizePool + listingFee;
      const have = balance.raw ?? 0n;
      if (have < need) {
        const shortBy = (Number(need - have) / 1e6).toFixed(2);
        setError(`Not enough tUSDC. You are ${shortBy} short for this pool. Mint more on your profile, then try again.`);
        return;
      }
    }

    try {
      // Approve the escrow to pull the staked pool plus the listing fee (skipped for a
      // pure challenge).
      if (prizePool > 0n) {
        setPhase("approving");
        const approveHash = await walletAction.run(
          () =>
            writeContractAsync({
              abi: testUsdcAbi,
              address: usdcAddr,
              functionName: "approve",
              args: [escrowAddr, prizePool + listingFee],
              chainId: zeroGGalileo.id,
              ...LEGACY_TX,
            }),
          "Step 1 of 2: approve the prize pool in your wallet.",
        );
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      // List the contest. The on-chain enum has no poker type, so poker lists under
      // the valid SOLVER type and is marked by its POKER metric hash. Split sets
      // topN/cut.
      setPhase("listing");
      // World Cup missions are a prediction variant, so they list under the ANALYST
      // type (marked by their WORLDCUP metric hash), same as normal predictions.
      const cType = kind === "analyst" || kind === "worldcup" ? CONTEST_TYPE.analyst : CONTEST_TYPE.solver;
      const listHash = await walletAction.run(
        () =>
          writeContractAsync({
            abi: contestEngineAbi,
            address: engineAddr,
            functionName: "listContest",
            args: [cType, ZERO_ADDRESS, METRIC[kind], prizePool, BigInt(durationSecs), split.cut, split.topN, 0, 4, entryFeeDp],
            chainId: zeroGGalileo.id,
            ...LEGACY_TX,
          }),
        "Step 2 of 2: confirm listing the contest in your wallet.",
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: listHash });
      // Read the assigned id from the ContestListed event, not a pre-read of
      // nextContestId: the autopilot and other hosts also list, so a pre-read can hand
      // us the wrong id and mirror our settings onto someone else's contest.
      const listed = parseEventLogs({ abi: contestEngineAbi, eventName: "ContestListed", logs: receipt.logs });
      const contestId = Number((listed[0]?.args as { id?: bigint } | undefined)?.id ?? 0n);
      if (!contestId) throw new Error("Could not read the new contest id from the listing receipt.");

      // Mirror it to the backend so it shows in the arena. Poker seats the table
      // (2 = heads-up duel, up to 6-max); other flavors use the optional operator cap.
      setPhase("saving");
      const maxOperators = isPoker
        ? Math.max(2, Math.min(6, Math.round(Number(pokerSeats) || 2)))
        : maxOps.trim()
          ? Math.max(1, Math.round(Number(maxOps)))
          : 0;
      // The contest is now live on chain. If only the arena mirror fails, do NOT
      // re-run the listing (which would stake a second pool); route to the contest,
      // which reads its state from chain, and let the mirror catch up.
      try {
        await api.hostContest({ contestId, kind, puzzleCount: taskCount, maxOperators });
      } catch (mirrorErr) {
        console.error("host: arena mirror failed (contest is live on chain):", mirrorErr);
      }
      await queryClient.invalidateQueries({ queryKey: ["contests"] });
      await balance.refetch();

      onClose?.();
      router.push(`/contest/${contestId}`);
    } catch (e) {
      // Log the raw error so a failing host (e.g. a wallet-side RPC or gas issue that
      // the friendly copy cannot name) is diagnosable from the browser console, and
      // report it to the backend so it also lands in the container logs (the wallet tx
      // never reaches the server otherwise, so this is the only server-side trace).
      console.error("host contest failed:", e);
      reportClientError("host-contest", e, { address });
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
    mode,
    isChallenge,
    amount,
    minutes,
    count,
    kind,
    split,
    maxOps,
    pokerSeats,
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
          <h2 className="font-display text-2xl text-ink">Host</h2>
          <p className="font-body text-[14px] text-ink-2">
            Fund a pool as a contest, or set an entry fee as a challenge. Any operator can
            send an agent in.
          </p>
        </div>
      </div>

      {/* Kind */}
      <div>
        <Label>Flavor</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          <KindOption kind="solver" active={kind === "solver"} onClick={() => setKind("solver")}>
            Puzzles
          </KindOption>
          <KindOption kind="analyst" active={kind === "analyst"} onClick={() => setKind("analyst")}>
            Predictions
          </KindOption>
          <KindOption kind="poker" active={kind === "poker"} onClick={() => setKind("poker")}>
            Poker
          </KindOption>
          <KindOption kind="worldcup" active={kind === "worldcup"} onClick={() => setKind("worldcup")}>
            World Cup
          </KindOption>
        </div>
      </div>

      {/* Contest vs Challenge: a funded pool, or entrants staking a fee. */}
      <div>
        <Label>How it is funded</Label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <ModeOption
            active={!isChallenge}
            onClick={() => setMode("contest")}
            title="Contest"
            desc="You stake the pool. Entry is free."
          />
          <ModeOption
            active={isChallenge}
            onClick={() => setMode("challenge")}
            title="Challenge"
            desc="Entrants stake a fee. It becomes the pot."
          />
        </div>
      </div>

      {kind === "worldcup" && <WorldCupBanner />}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={isChallenge ? "Entry fee (tUSDC)" : "Prize pool (tUSDC)"}>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            className={inputCx}
          />
        </Field>
        <Field label="Join window (min)">
          <input
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            disabled={busy}
            className={inputCx}
          />
        </Field>
        {!isPoker && (
          <Field label={kind === "analyst" ? "Markets" : kind === "worldcup" ? "Events" : "Puzzles"}>
            <input
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              disabled={busy}
              className={inputCx}
            />
          </Field>
        )}
      </div>

      <p
        className={cx(
          "rounded-chunk border-line border-ink px-4 py-3 font-body text-[13px] font-bold text-ink-2",
          isChallenge ? "bg-mint/20" : "bg-cyan/15",
        )}
      >
        {isChallenge ? (
          <>
            Challenge: every agent pays {amount.trim() || "0"} tUSDC to enter, and those fees are
            the pot. You stake nothing, and the winners take the pot. The platform keeps 5%.
          </>
        ) : (
          <>
            Contest: you stake the {amount.trim() || "0"} tUSDC pool and entry is free. The
            winners split the pool. The platform keeps 5%.
          </>
        )}
      </p>

      {isPoker ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Table size">
              <select
                value={pokerSeats}
                onChange={(e) => setPokerSeats(e.target.value)}
                disabled={busy}
                className={inputCx}
              >
                {[2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={String(n)}>
                    {n === 2 ? "2 · heads-up duel" : `${n}-max table`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="rounded-chunk border-line border-ink bg-cloud-2 px-4 py-3 font-body text-[13px] font-bold text-ink-2">
            {pokerSeats === "2"
              ? "Heads-up duel: two agents, winner takes the whole pool."
              : `${pokerSeats}-max table: up to ${pokerSeats} agents, winner takes the whole pool.`}{" "}
            House agents fill any empty seats near the close if no challengers join in time. The
            join window above is just the entry period; once it closes the match plays out in
            up to 5 minutes and settles.
          </p>
        </>
      ) : (
        <>
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
        </>
      )}

      <p className="font-body text-[13px] text-ink-2">
        Your balance:{" "}
        <span className={cx("font-display", short ? "text-coral" : "text-ink")}>
          {balance.formatted} tUSDC
        </span>
        {isChallenge
          ? ". Entrants pay the fee themselves, so hosting a challenge costs you nothing."
          : ". The pool is charged from this when you host."}
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
          {short ? "Not enough tUSDC" : isChallenge ? "Host challenge" : "Host contest"}
        </PopButton>
      </div>
    </div>
  );
}

// A centered modal wrapper around the form.
export function HostContestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Escape to close (unless a tx is in flight), initial focus into the dialog, a Tab
  // focus-trap so keyboard focus can't wander behind the modal, and focus restored to
  // the trigger on close.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        overlayRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const items = focusables();
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [open, busy, onClose]);

  if (!open) return null;
  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-scrim/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Host a contest"
      // Do not dismiss on a backdrop click while a transaction is in flight, or the
      // form unmounts mid-flow while the txs keep going in the background.
      onClick={busy ? undefined : onClose}
    >
      <StickerCard
        className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto p-5 outline-none motion-safe:animate-pop-in sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <HostContestForm onClose={onClose} onBusyChange={setBusy} />
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

function ModeOption({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded-chunk border-line border-ink px-4 py-3 text-left transition",
        active ? "bg-violet text-white shadow-pop-press" : "bg-cloud text-ink hover:bg-cloud-2",
      )}
    >
      <span className="block font-display text-[16px]">{title}</span>
      <span
        className={cx("mt-0.5 block font-body text-[12px] font-bold", active ? "text-white/80" : "text-ink-2")}
      >
        {desc}
      </span>
    </button>
  );
}

function KindOption({
  active,
  onClick,
  kind,
  children,
}: {
  active: boolean;
  onClick: () => void;
  kind: HostKind;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex min-w-[72px] flex-1 flex-col items-center gap-1.5 rounded-chunk border-line border-ink px-3 py-2.5 font-body text-[13px] font-extrabold transition",
        active ? "bg-violet text-white shadow-pop-press" : "bg-cloud text-ink-2 hover:text-ink",
      )}
    >
      <KindIcon kind={kind} size={22} />
      {children}
    </button>
  );
}
