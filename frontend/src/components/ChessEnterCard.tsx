"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMyChessAgent } from "@/lib/useAgents";
import { useChessSubmitAuth } from "@/lib/chessAuth";
import { STARTER_AGENT } from "@/lib/chessStarter";
import type { ChessSubmitResult } from "@/lib/types";
import { identityUrl } from "@/lib/format";
import { useDeployment } from "@/lib/useDeployment";
import { ClaimIdentity } from "@/components/ClaimIdentity";
import { ReceiptsLink } from "@/components/ReceiptsLink";
import { Agent, Chip, PopButton, StickerCard, cx } from "@/components/zerun";
import { popButtonClass } from "@/components/zerun/PopButton";
import { ConnectX } from "@/components/ConnectX";

// The competition front door: pick a name, hand us one Python file, sign it with your wallet, and
// the agent joins the ladder. The submit call is slow on purpose: the backend is playing your
// agent on three real positions inside the sandbox before it lets it on the board, so the waiting
// state says exactly that instead of spinning silently.

const MAX_BYTES = 65536;

function friendly(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  const brace = m.indexOf("{");
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(m.slice(brace)) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* fall through to the raw message */
    }
  }
  if (/user rejected|denied|rejected the request/i.test(m)) return "You cancelled the signature.";
  return m;
}

export function ChessEnterCard() {
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const owner = address?.toLowerCase() ?? null;
  const { data } = useMyChessAgent(owner);
  const mine = data?.agent ?? null;
  const open = data?.open ?? true;

  // Entering requires a connected X account (anti-bot: one X maps to one wallet). Gate the form on
  // it. If X connect is not configured on this deployment, the gate is skipped.
  const { data: xStatus } = useQuery({ queryKey: ["x-status"], queryFn: () => api.xStatus(), staleTime: 300_000 });
  const { data: xId } = useQuery({
    queryKey: ["x-identity", owner ?? "none"],
    queryFn: () => api.xIdentity(owner as string),
    enabled: Boolean(owner),
    staleTime: 30_000,
  });
  const xEnabled = xStatus?.enabled ?? false;
  const xConnected = Boolean(xId?.identity);

  const [editing, setEditing] = useState(false);
  const showForm = !mine || editing;

  if (!owner) {
    return (
      <StickerCard className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center">
        <Agent variant="cyan" mood="idle" size={64} name="waiting for a challenger" />
        <div className="flex-1">
          <h2 className="font-display text-xl text-ink">Enter the competition</h2>
          <p className="mt-1 font-body text-[14px] text-ink-2">
            One Python file, one function, and your agent plays every other agent around the clock.
            Free to enter. Connect the wallet you want the entry credited to.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <PopButton onClick={() => openConnectModal?.()}>Connect wallet</PopButton>
          <Link href="/chess/guide" className={popButtonClass("ghost")}>
            Build guide
          </Link>
        </div>
      </StickerCard>
    );
  }

  if (!open) {
    return (
      <StickerCard className="p-6">
        <h2 className="font-display text-xl text-ink">Submissions are closed</h2>
        <p className="mt-1 font-body text-[14px] text-ink-2">
          The board keeps playing, but no new agents are being accepted right now.
        </p>
      </StickerCard>
    );
  }

  // No entry, and X is required but not connected: gate on X before the form.
  if (!mine && xEnabled && !xConnected) {
    return (
      <StickerCard className="p-6">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Agent variant="cyan" mood="idle" size={64} name="connect X to enter" />
          <div className="flex-1">
            <h2 className="font-display text-xl text-ink">Connect X to enter</h2>
            <p className="mt-1 font-body text-[14px] text-ink-2">
              Entering needs a connected X account, one X per wallet, so the competition stays free of
              bots and duplicate entries. Your handle and picture show on your agent on the board. It
              is a free signature, no gas.
            </p>
            <div className="mt-3">
              <ConnectX address={owner} isMe />
            </div>
          </div>
        </div>
      </StickerCard>
    );
  }

  return (
    <div className="space-y-4">
      {mine ? <MyAgentCard agent={mine} onReplace={() => setEditing((v) => !v)} replacing={editing} /> : null}
      {showForm ? <SubmitForm owner={owner} existingName={mine?.name ?? ""} onDone={() => setEditing(false)} /> : null}
    </div>
  );
}

function MyAgentCard({
  agent,
  onReplace,
  replacing,
}: {
  agent: NonNullable<ReturnType<typeof useMyChessAgent>["data"]>["agent"];
  onReplace: () => void;
  replacing: boolean;
}) {
  const { data: deployment } = useDeployment();
  const queryClient = useQueryClient();
  const identityEnabled = Boolean(deployment?.identityEnabled);
  if (!agent) return null;
  const played = agent.games > 0;
  return (
    <StickerCard className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center">
      <Agent variant="violet" mood={played ? "happy" : "thinking"} size={64} name={agent.name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-xl text-ink">{agent.name}</h2>
          <Chip tone="live" pulse>
            on the ladder
          </Chip>
          {agent.storageRoot ? <Chip tone="info">anchored on 0G</Chip> : null}
          {agent.identityClaimed && agent.identityTokenId != null ? (
            <a
              href={identityUrl(agent.identityTokenId)}
              target="_blank"
              rel="noreferrer"
              title={`ERC-8004 identity #${agent.identityTokenId} on 0G mainnet`}
              className="inline-flex"
            >
              <Chip tone="won">verified on 0G</Chip>
            </a>
          ) : null}
        </div>
        <p className="mt-1 font-body text-[14px] text-ink-2">
          {played
            ? `${agent.games} games · ${agent.wins}W ${agent.draws}D ${agent.losses}L · rating ${agent.rating.toFixed(1)}`
            : "Waiting for its first game. The matchmaker pairs it with the nearest rating, so it starts against the mid-table and works up."}
        </p>
        {agent.identityTokenId != null ? (
          <a
            href={identityUrl(agent.identityTokenId)}
            target="_blank"
            rel="noreferrer"
            title="ERC-8004 identity on 0G mainnet"
            className="mt-1 inline-block font-mono text-[11px] text-ink-3 underline decoration-ink-3/40 underline-offset-2 transition-colors hover:text-violet"
          >
            0G ID #{agent.identityTokenId}
          </a>
        ) : null}
        <div className="mt-1">
          <ReceiptsLink agentId={agent.agentId} kind="chess" />
        </div>
        {identityEnabled && !agent.identityClaimed ? (
          <ClaimIdentity
            kind="chess"
            agentId={agent.agentId}
            identityTokenId={agent.identityTokenId}
            claimed={false}
            compact
            className="mt-3"
            requiredAfter={deployment?.identityRequiredAfter ?? null}
            onClaimed={() => queryClient.invalidateQueries({ queryKey: ["chess-mine"] })}
          />
        ) : null}
      </div>
      <PopButton variant="ghost" onClick={onReplace} className="shrink-0">
        {replacing ? "Keep my agent" : "Replace my code"}
      </PopButton>
    </StickerCard>
  );
}

type Phase = "idle" | "signing" | "checking" | "done";

function SubmitForm({
  owner,
  existingName,
  onDone,
}: {
  owner: string;
  existingName: string;
  onDone: () => void;
}) {
  const signEntry = useChessSubmitAuth();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(existingName);
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChessSubmitResult | null>(null);

  const bytes = new TextEncoder().encode(code).length;
  const tooBig = bytes > MAX_BYTES;
  const busy = phase === "signing" || phase === "checking";
  const ready = name.trim().length >= 2 && code.trim().length > 0 && !tooBig && !busy;

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setCode(await file.text());
    if (!name.trim()) setName(file.name.replace(/\.py$/i, "").slice(0, 24));
  }

  async function submit() {
    const clean = name.trim();
    setError(null);
    try {
      setPhase("signing");
      const auth = await signEntry(clean, code);
      setPhase("checking");
      const r = await api.submitChessAgent({ ...auth, name: clean, code });
      setResult(r);
      setPhase("done");
      await qc.invalidateQueries({ queryKey: ["chess-mine", owner] });
      await qc.invalidateQueries({ queryKey: ["chess-ladder"] });
    } catch (err) {
      setError(friendly(err));
      setPhase("idle");
    }
  }

  if (phase === "done" && result) {
    return (
      <StickerCard className="p-6">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Agent variant="mint" mood="happy" size={64} name={result.name} />
          <div className="flex-1">
            <h2 className="font-display text-xl text-ink">
              {result.name} is {result.resubmitted ? "back on the ladder" : "on the ladder"}
            </h2>
            <p className="mt-1 font-body text-[14px] text-ink-2">
              It passed the check and starts playing within the minute. Watch it climb below.
              {result.resubmitted
                ? " New code means a clean slate: your old position is cleared and it climbs again from scratch."
                : ""}
            </p>
          </div>
          <PopButton
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              setResult(null);
              setPhase("idle");
              setCode("");
              onDone();
            }}
          >
            Done
          </PopButton>
        </div>
        <ul className="mt-4 grid gap-2 sm:grid-cols-3">
          {result.smoke.map((m) => (
            <li key={m.position} className="rounded-chunk border-line border-ink bg-cloud-2 p-3 shadow-pop-press">
              <span className="font-body text-[12px] font-extrabold text-ink-3">{m.position}</span>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-[15px] text-ink">{m.uci}</span>
                <span className="font-body text-[11px] text-ink-3">{m.ms} ms</span>
              </div>
            </li>
          ))}
        </ul>
        {result.storageRoot ? (
          <p className="mt-3 font-mono text-[11px] text-ink-3">0G Storage anchor · {result.storageRoot}</p>
        ) : null}
        {result.identityTokenId != null ? (
          <p className="mt-1 font-mono text-[11px] text-ink-3">
            ERC-8004 identity ·{" "}
            <a href={identityUrl(result.identityTokenId)} target="_blank" rel="noreferrer" className="text-violet underline">
              #{result.identityTokenId} on 0G mainnet
            </a>
          </p>
        ) : null}
      </StickerCard>
    );
  }

  return (
    <StickerCard className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl text-ink">
          {existingName ? "Replace your code" : "Enter the competition"}
        </h2>
        <Link href="/chess/guide" className="font-body text-[13px] font-extrabold text-violet underline">
          Read the build guide
        </Link>
      </div>
      <p className="mt-1 font-body text-[14px] text-ink-2">
        One Python file that defines <code className="font-mono text-[13px]">choose_move(state)</code> and returns a
        move from <code className="font-mono text-[13px]">state[&quot;legal&quot;]</code>. We run it, we pay for its
        thinking on 0G, and it plays around the clock. New here? Start from the example.
      </p>

      <div className="mt-5 grid gap-4">
        <label className="grid gap-1">
          <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink-3">
            Agent name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            placeholder="Rook Raider"
            className="rounded-chunk border-line border-ink bg-cloud px-4 py-3 font-body text-[15px] font-bold text-ink shadow-pop-press outline-none focus:ring-4 focus:ring-violet/30"
          />
        </label>

        <div className="grid gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink-3">
              Your agent
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded-pill border-line border-ink bg-cloud px-3 py-1 font-body text-[12px] font-extrabold text-ink shadow-pop-press"
              >
                Upload a .py file
              </button>
              <button
                type="button"
                onClick={() => setCode(STARTER_AGENT)}
                className="rounded-pill border-line border-ink bg-amber px-3 py-1 font-body text-[12px] font-extrabold text-candyink shadow-pop-press"
              >
                Use the example
              </button>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".py,text/x-python,text/plain"
            className="hidden"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            rows={12}
            placeholder={"def choose_move(state):\n    return state[\"legal\"][0]"}
            className="rounded-chunk border-line border-ink bg-cloud p-4 font-mono text-[12px] leading-relaxed text-ink shadow-pop-press outline-none focus:ring-4 focus:ring-violet/30"
          />
          <span className={cx("font-body text-[11px]", tooBig ? "font-extrabold text-coral" : "text-ink-3")}>
            {(bytes / 1024).toFixed(1)} KB of {MAX_BYTES / 1024} KB · standard library only · no network
          </span>
        </div>

        {error ? (
          <div className="rounded-chunk border-line border-ink bg-coral/15 p-4">
            <p className="font-body text-[14px] font-bold text-ink">{error}</p>
          </div>
        ) : null}

        {phase === "checking" ? (
          <div className="flex items-center gap-3 rounded-chunk border-line border-ink bg-cloud-2 p-4 shadow-pop-press">
            <Agent variant="cyan" mood="thinking" size={44} name="checking your agent" />
            <p className="font-body text-[14px] text-ink-2">
              Running your agent in the sandbox on three positions: an opening, a middlegame and an
              endgame. It has to return a legal move in each one. This takes a few seconds.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <PopButton onClick={() => void submit()} disabled={!ready}>
            {phase === "signing"
              ? "Sign in your wallet…"
              : phase === "checking"
                ? "Checking your agent…"
                : existingName
                  ? "Replace and re-enter"
                  : "Submit my agent"}
          </PopButton>
          <span className="font-body text-[13px] text-ink-3">
            Signing is free and just proves the entry is yours. No gas, no fee.
          </span>
        </div>
      </div>
    </StickerCard>
  );
}
