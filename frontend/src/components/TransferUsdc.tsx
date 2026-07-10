"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { api } from "@/lib/api";
import { testUsdcAbi } from "@/lib/contracts";
import { useDeployment } from "@/lib/useDeployment";
import { useUsdcBalance } from "@/lib/useChainData";
import { friendlyError } from "@/lib/errors";
import { zeroGGalileo, LEGACY_TX } from "@/lib/chain";
import { useWalletAction } from "@/lib/walletAction";
import { shortId } from "@/lib/format";
import type { XResolved } from "@/lib/types";
import { Chip, PopButton, StickerCard, cx } from "./zerun";
import { Spinner } from "./ui";

// Send tUSDC to a friend, by wallet address or by the X handle they verified on Zerun.
//
// The handle path exists because nobody reads 42 hex characters back to a person. A verified
// handle maps to exactly one wallet (`unique (x_id)` on social_identity), so "@someone" is an
// address, not a guess. An unconnected handle resolves to nothing and we say so, rather than
// sending money into a name we cannot vouch for.
//
// tUSDC has 6 decimals and no real value, but a transfer is still irreversible, so the amount
// is checked against the balance before the wallet is ever opened.

const ZERO = "0x0000000000000000000000000000000000000000";

/** A tUSDC amount (whole + up to 6dp) as a 6-decimal bigint. Throws on anything else. */
function toSixDp(amount: string): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  return BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6) || "0");
}

type Phase = "idle" | "resolving" | "sending" | "sent";

export function TransferUsdc() {
  const { address } = useAccount();
  const { data: deployment } = useDeployment();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const walletAction = useWalletAction();
  const balance = useUsdcBalance(address);

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<XResolved | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const usdcAddr = deployment?.contracts.testUSDC;
  const busy = phase === "resolving" || phase === "sending";
  const trimmed = to.trim();
  const looksLikeHandle = trimmed.startsWith("@") || (trimmed.length > 0 && !trimmed.startsWith("0x"));

  // Look the handle up as it is typed, debounced, so the recipient's face appears before the
  // sender commits. A wallet address needs no lookup: it is already the answer.
  const seq = useRef(0);
  useEffect(() => {
    setResolved(null);
    if (!looksLikeHandle || trimmed.replace(/^@+/, "").length < 2) return;
    const mine = ++seq.current;
    setPhase("resolving");
    const t = setTimeout(() => {
      api
        .resolveHandle(trimmed)
        .then((r) => {
          if (mine !== seq.current) return; // a newer keystroke owns the field now
          setResolved(r);
          setError(null);
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setResolved(null);
        })
        .finally(() => {
          if (mine === seq.current) setPhase("idle");
        });
    }, 400);
    return () => clearTimeout(t);
  }, [trimmed, looksLikeHandle]);

  const send = useCallback(async () => {
    setError(null);
    setTxHash(null);
    if (!address || !usdcAddr || !publicClient) return;

    // Where is this going? An address is taken as written; a handle must have resolved.
    let recipient: `0x${string}` | null = null;
    if (isAddress(trimmed)) recipient = trimmed as `0x${string}`;
    else if (resolved && isAddress(resolved.wallet)) recipient = resolved.wallet as `0x${string}`;
    if (!recipient) {
      setError(
        looksLikeHandle
          ? `${trimmed.startsWith("@") ? trimmed : `@${trimmed}`} has not connected X to a Zerun wallet.`
          : "Enter a wallet address, or the X handle of someone who has connected theirs.",
      );
      return;
    }
    if (recipient.toLowerCase() === address.toLowerCase()) {
      setError("That is your own wallet.");
      return;
    }
    if (recipient === ZERO) {
      setError("That address burns the tokens. Pick a real one.");
      return;
    }

    if (!/^\d+(\.\d{1,6})?$/.test(amount.trim()) || Number(amount) <= 0) {
      setError("Enter an amount (up to 6 decimals).");
      return;
    }
    const value = toSixDp(amount);
    if (balance.raw !== undefined && value > balance.raw) {
      setError(`You only have ${balance.formatted} tUSDC.`);
      return;
    }

    try {
      setPhase("sending");
      const hash = await walletAction.run(
        () =>
          writeContractAsync({
            abi: testUsdcAbi,
            address: usdcAddr,
            functionName: "transfer",
            args: [recipient, value],
            chainId: zeroGGalileo.id,
            ...LEGACY_TX,
          }),
        `Sending ${amount} tUSDC.`,
      );
      await publicClient.waitForTransactionReceipt({ hash });
      setTxHash(hash);
      setPhase("sent");
      setAmount("");
      setTo("");
      setResolved(null);
      balance.refetch();
    } catch (err) {
      setError(friendlyError(err));
      setPhase("idle");
    }
  }, [address, usdcAddr, publicClient, trimmed, resolved, looksLikeHandle, amount, balance, walletAction, writeContractAsync]);

  if (!address) return null;

  const inputCx =
    "w-full rounded-chunk border-line border-ink bg-cloud px-3 py-2.5 font-body text-[14px] font-bold text-ink " +
    "shadow-pop-press outline-none placeholder:text-ink-3 focus:border-violet disabled:opacity-60";

  return (
    <StickerCard className="p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-display text-lg text-ink">Send tUSDC</span>
          <Chip tone="neutral">testnet</Chip>
        </div>
        <div className="text-right">
          <div className="font-display text-xl text-ink tabular-nums">{balance.formatted}</div>
          <div className="font-body text-[11px] font-extrabold uppercase tracking-[0.04em] text-ink-3">
            your balance
          </div>
        </div>
      </div>
      <p className="mb-4 font-body text-[13px] text-ink-2">
        Pay a friend by wallet address, or by the X handle they connected to Zerun.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="block">
          <span className="mb-1 block font-body text-[11px] font-extrabold uppercase tracking-[0.04em] text-ink-2">
            To
          </span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={busy}
            placeholder="@handle or 0x…"
            spellCheck={false}
            autoComplete="off"
            className={inputCx}
          />
        </label>
        <label className="block sm:w-40">
          <span className="mb-1 block font-body text-[11px] font-extrabold uppercase tracking-[0.04em] text-ink-2">
            Amount
          </span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            inputMode="decimal"
            placeholder="25"
            className={inputCx}
          />
        </label>
      </div>

      {/* Who the money is actually going to, before it goes. */}
      <div className="mt-3 min-h-[44px]">
        {phase === "resolving" && (
          <span className="inline-flex items-center gap-2 font-body text-[13px] text-ink-3">
            <Spinner /> Looking up {trimmed}…
          </span>
        )}
        {phase !== "resolving" && resolved && (
          <div className="flex items-center gap-2 rounded-chunk border-line border-ink bg-mint/20 px-3 py-2">
            {resolved.avatar && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolved.avatar}
                alt=""
                className="h-7 w-7 shrink-0 rounded-full border-2 border-ink"
              />
            )}
            <span className="min-w-0 truncate font-body text-[13px] font-extrabold text-ink">
              @{resolved.handle}
              {resolved.name ? <span className="font-bold text-ink-2"> · {resolved.name}</span> : null}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-3">{shortId(resolved.wallet, 6, 4)}</span>
          </div>
        )}
        {phase !== "resolving" && !resolved && looksLikeHandle && trimmed.replace(/^@+/, "").length >= 2 && (
          <span className="font-body text-[13px] font-bold text-coral">
            {trimmed.startsWith("@") ? trimmed : `@${trimmed}`} has not connected X to a Zerun wallet.
          </span>
        )}
        {phase !== "resolving" && !looksLikeHandle && trimmed.length > 0 && !isAddress(trimmed) && (
          <span className="font-body text-[13px] font-bold text-coral">That is not a wallet address.</span>
        )}
      </div>

      {error && <p className="mt-1 font-body text-[13px] font-bold text-coral">{error}</p>}
      {phase === "sent" && txHash && (
        <p className="mt-1 font-body text-[13px] font-bold text-ink-2">
          Sent. <span className="font-mono text-[12px] text-ink-3">{shortId(txHash, 8, 6)}</span>
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <PopButton onClick={send} disabled={busy || !usdcAddr || balance.isZero}>
          {phase === "sending" ? "Sending…" : "Send"}
        </PopButton>
        {balance.isZero && (
          <span className="font-body text-[13px] text-ink-3">Mint some tUSDC first and you can share it.</span>
        )}
      </div>
    </StickerCard>
  );
}
