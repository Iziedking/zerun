"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { api } from "@/lib/api";
import { identityUrl } from "@/lib/format";
import { useAgentAuth } from "@/lib/agentAuth";
import { useChessClaimAuth } from "@/lib/chessAuth";
import type { AgentClaimResult } from "@/lib/types";
import { Chip, PopButton } from "./zerun";

// Claim an agent's ERC-8004 identity: the owner signs, and the backend mints (if needed) and transfers
// the identity NFT to their wallet, so they own it on 0G mainnet. Works for both arena agents and chess
// entries. Once claimed, it shows the "verified on 0G" badge linking to the on-chain token.
//
// Gated by the caller on the deployment's identityEnabled flag, so it never shows when the feature is
// off. Claiming is idempotent on the backend, so a retry after a hiccup is safe.

export function ClaimIdentity({
  kind,
  agentId,
  identityTokenId,
  claimed,
  className = "",
  compact = false,
  onClaimed,
}: {
  kind: "arena" | "chess";
  agentId: number;
  identityTokenId: number | null;
  claimed: boolean;
  className?: string;
  /** Drop the full-width button (for inline placement next to other buttons). */
  compact?: boolean;
  onClaimed?: (r: AgentClaimResult) => void;
}) {
  const { address } = useAccount();
  const agentAuth = useAgentAuth();
  const chessClaimAuth = useChessClaimAuth();
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "error">(claimed ? "done" : "idle");
  const [tokenId, setTokenId] = useState<number | null>(identityTokenId);
  const [error, setError] = useState<string | null>(null);

  const isClaimed = phase === "done" || claimed;

  if (isClaimed) {
    const tid = tokenId ?? identityTokenId;
    if (tid == null) {
      return <Chip tone="won">verified on 0G</Chip>;
    }
    return (
      <a
        href={identityUrl(tid)}
        target="_blank"
        rel="noreferrer"
        title={`ERC-8004 identity #${tid} on 0G mainnet`}
        className="inline-flex"
      >
        <Chip tone="won">verified on 0G</Chip>
      </a>
    );
  }

  async function claim() {
    if (!address) {
      setError("Connect your wallet first.");
      return;
    }
    setError(null);
    setPhase("working");
    try {
      const auth =
        kind === "chess"
          ? await chessClaimAuth(agentId)
          : await agentAuth("claim identity", agentId);
      const result =
        kind === "chess"
          ? await api.claimChessAgent(agentId, auth)
          : await api.claimAgent(agentId, auth);
      if (result.claimed) {
        setTokenId(result.identityTokenId);
        setPhase("done");
        onClaimed?.(result);
      } else {
        // The backend accepted the claim but the transfer did not complete (e.g. an unfunded wallet or
        // a mainnet hiccup). It is safe to try again.
        setPhase("error");
        setError("The identity is not ready yet. Try again in a moment.");
      }
    } catch (e) {
      setPhase("error");
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? "Claim failed.";
      // A user rejecting the signature should read as a cancel, not an error.
      setError(/reject|denied|cancel/i.test(msg) ? "Signature cancelled." : msg);
    }
  }

  return (
    <div className={className}>
      <PopButton type="button" onClick={claim} disabled={phase === "working"} className={compact ? "" : "w-full"}>
        {phase === "working" ? "Claiming on 0G…" : "Claim on-chain identity"}
      </PopButton>
      {error ? <p className="mt-1.5 font-body text-[12px] font-bold text-coral">{error}</p> : null}
    </div>
  );
}
