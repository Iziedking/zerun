"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { shortAddr, formatUsdc } from "@/lib/format";
import { StickerCard, PopButton } from "@/components/zerun";

const INPUT =
  "w-full rounded-chunk border-line border-ink bg-cloud px-4 py-2.5 font-body text-[15px] text-ink shadow-pop-press outline-none placeholder:text-ink-3 focus:-translate-y-px";
const LABEL = "block font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2";

type AgentInfo = Awaited<ReturnType<typeof api.adminAgent>>;
type OpInfo = Awaited<ReturnType<typeof api.adminOperator>>;
type ContestInfo = Awaited<ReturnType<typeof api.adminContest>>;
type RepairInfo = Awaited<ReturnType<typeof api.adminRepairClaims>>;

// Internal support console. Diagnose and fix the common operator issues: a
// training payment that did not reflect, a user who cannot host or enter for
// lack of tUSDC, and a stuck contest. All gated by the admin token.
export default function AdminPage() {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState("");
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // agent tools
  const [agentId, setAgentId] = useState("");
  const [txHash, setTxHash] = useState("");
  const [level, setLevel] = useState("");
  const [agent, setAgent] = useState<AgentInfo | null>(null);

  // operator tools
  const [opAddr, setOpAddr] = useState("");
  const [op, setOp] = useState<OpInfo | null>(null);
  const [grant, setGrant] = useState("");

  // contest tools
  const [contestId, setContestId] = useState("");
  const [contest, setContest] = useState<ContestInfo | null>(null);
  const [repair, setRepair] = useState<RepairInfo | null>(null);

  // Token lives in memory only: not localStorage, sessionStorage, or cookies.
  // It is verified against the backend once, then held in state for this tab.
  const unlock = async () => {
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.adminCheck(t);
      setSaved(t);
      setAuthed(true);
    } catch {
      setMsg({ ok: false, text: "That token was not accepted." });
    } finally {
      setBusy(false);
    }
  };

  const lock = () => {
    setSaved("");
    setToken("");
    setAuthed(false);
    setMsg(null);
  };

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e, "That did not go through.") });
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(saved) && !busy;

  // Login gate: nothing shows until a valid token unlocks the console.
  if (!authed) {
    return (
      <div className="mx-auto max-w-md space-y-5 pt-24">
        <header className="text-center">
          <h1 className="font-display text-4xl text-ink -rotate-1">Support console</h1>
          <p className="mt-1 font-body text-[15px] text-ink-2">
            Enter the admin token to continue.
          </p>
        </header>
        <StickerCard className="space-y-3 p-5">
          <label className={LABEL}>Admin token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
            placeholder="paste the admin token"
            className={INPUT}
            autoFocus
          />
          <PopButton
            type="button"
            onClick={unlock}
            disabled={busy || !token.trim()}
            className="w-full"
          >
            {busy ? "Checking" : "Unlock"}
          </PopButton>
          {msg && !msg.ok && (
            <p className="font-body text-[13px] font-bold text-coral">{msg.text}</p>
          )}
        </StickerCard>
        <p className="text-center font-body text-[12px] text-ink-3">
          The token is held in memory only, never stored, and cleared when you leave.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 pt-10">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl text-ink -rotate-1">Support console</h1>
          <p className="mt-1 font-body text-[15px] text-ink-2">Diagnose and fix operator issues.</p>
        </div>
        <PopButton type="button" variant="ghost" onClick={lock}>
          Lock
        </PopButton>
      </header>

      {/* ---- Operator: balances, grant tUSDC (the "cannot host" fix) ---- */}
      <StickerCard className="space-y-4 p-5">
        <h2 className="font-display text-lg text-ink">Operator</h2>
        <p className="font-body text-[13px] text-ink-2">
          Look up a wallet to see why they cannot host or enter (usually no tUSDC), then grant some.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={opAddr}
            onChange={(e) => setOpAddr(e.target.value.trim())}
            placeholder="0x… wallet"
            className={INPUT + " flex-1 font-mono text-[13px]"}
          />
          <PopButton
            type="button"
            variant="ghost"
            disabled={!ready || !opAddr}
            onClick={() =>
              run(async () => {
                const r = await api.adminOperator(opAddr, saved);
                setOp(r);
                return `Loaded ${shortAddr(r.owner)}.`;
              })
            }
          >
            Look up
          </PopButton>
        </div>

        {op && (
          <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 p-4">
            <div className="font-display text-lg text-ink">
              {formatUsdc(op.usdcWei)} tUSDC on hand
            </div>
            <div className="mt-0.5 font-body text-[12px] text-ink-2">
              claimed this week: {formatUsdc(op.usdcClaimedThisWeekWei)} / 100
            </div>
            <div className="mt-2 font-body text-[13px] text-ink-2">
              {op.agents.length} agent(s) · {op.contests.length} recent contest(s)
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t-line border-ink/10 pt-3">
          <div className="flex-1">
            <label className={LABEL}>Grant tUSDC</label>
            <input
              inputMode="decimal"
              value={grant}
              onChange={(e) => setGrant(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="amount, e.g. 200"
              className={INPUT + " mt-1"}
            />
          </div>
          <PopButton
            type="button"
            disabled={!ready || !opAddr || !grant}
            onClick={() =>
              run(async () => {
                await api.adminGrantUsdc({ owner: opAddr, amount: Number(grant) }, saved);
                return `Granted ${grant} tUSDC to ${shortAddr(opAddr)}.`;
              })
            }
          >
            Grant
          </PopButton>
        </div>
      </StickerCard>

      {/* ---- Agent: credit a stuck training, override compute level ---- */}
      <StickerCard className="space-y-4 p-5">
        <h2 className="font-display text-lg text-ink">Agent</h2>
        <div className="flex flex-wrap gap-2">
          <input
            inputMode="numeric"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value.replace(/\D/g, ""))}
            placeholder="agent id, e.g. 29"
            className={INPUT + " flex-1"}
          />
          <PopButton
            type="button"
            variant="ghost"
            disabled={!ready || !agentId}
            onClick={() =>
              run(async () => {
                const r = await api.adminAgent(Number(agentId), saved);
                setAgent(r);
                return `Loaded agent #${r.agent.agent_id}.`;
              })
            }
          >
            Look up
          </PopButton>
        </div>

        {agent && (
          <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 p-4">
            <div className="font-display text-lg text-ink">
              {agent.agent.name} · Compute level {agent.agent.compute_level}
              {agent.agent.is_house ? " · house" : ""}
            </div>
            <div className="mt-0.5 font-mono text-[12px] text-ink-2">
              owner {shortAddr(agent.agent.owner)} · {agent.trainings.length} training(s)
            </div>
          </div>
        )}

        <div>
          <label className={LABEL}>Credit a training payment (tx hash)</label>
          <input
            value={txHash}
            onChange={(e) => setTxHash(e.target.value.trim())}
            placeholder="0x… on-chain payment that did not reflect"
            className={INPUT + " mt-1 font-mono text-[13px]"}
          />
          <PopButton
            type="button"
            className="mt-2"
            disabled={!ready || !agentId || !txHash}
            onClick={() =>
              run(async () => {
                const r = await api.adminCreditTraining(
                  { agentId: Number(agentId), txHash: txHash.trim() },
                  saved,
                );
                return `Credited. Agent #${agentId} is now Compute level ${r.computeLevel}.`;
              })
            }
          >
            Credit training
          </PopButton>
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t-line border-ink/10 pt-3">
          <div className="flex-1">
            <label className={LABEL}>Override level (0 to 5)</label>
            <input
              inputMode="numeric"
              value={level}
              onChange={(e) => setLevel(e.target.value.replace(/\D/g, ""))}
              placeholder="0-5"
              className={INPUT + " mt-1"}
            />
          </div>
          <PopButton
            type="button"
            variant="ghost"
            disabled={!ready || !agentId || level === ""}
            onClick={() =>
              run(async () => {
                const r = await api.adminSetCompute(
                  { agentId: Number(agentId), level: Number(level) },
                  saved,
                );
                return `Agent #${agentId} set to Compute level ${r.computeLevel}.`;
              })
            }
          >
            Set level
          </PopButton>
        </div>
      </StickerCard>

      {/* ---- Contest: inspect and recover a stuck contest ---- */}
      <StickerCard className="space-y-4 p-5">
        <h2 className="font-display text-lg text-ink">Contest</h2>
        <div className="flex flex-wrap gap-2">
          <input
            inputMode="numeric"
            value={contestId}
            onChange={(e) => setContestId(e.target.value.replace(/\D/g, ""))}
            placeholder="contest id"
            className={INPUT + " flex-1"}
          />
          <PopButton
            type="button"
            variant="ghost"
            disabled={!ready || !contestId}
            onClick={() =>
              run(async () => {
                setRepair(null);
                const r = await api.adminContest(Number(contestId), saved);
                setContest(r);
                return `Loaded contest #${r.contest.contest_id} (${r.contest.status}).`;
              })
            }
          >
            Inspect
          </PopButton>
        </div>

        {contest && (
          <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 p-4">
            <div className="font-display text-lg text-ink">
              #{contest.contest.contest_id} · {contest.contest.status} · {contest.contest.kind}
            </div>
            <div className="mt-0.5 font-body text-[13px] text-ink-2">
              entries: {contest.dbEntries} in db / {contest.onchainEntries} on chain · pool{" "}
              {formatUsdc(contest.contest.prize_pool)} tUSDC
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t-line border-ink/10 pt-3">
          <PopButton
            type="button"
            disabled={!ready || !contestId}
            onClick={() =>
              run(async () => {
                await api.adminResettle(Number(contestId), saved);
                return `Resettle triggered for #${contestId}.`;
              })
            }
          >
            Resettle
          </PopButton>
          <PopButton
            type="button"
            variant="ghost"
            disabled={!ready || !contestId}
            onClick={() =>
              run(async () => {
                await api.adminCancelContest(Number(contestId), saved);
                return `Cancelled #${contestId}.`;
              })
            }
          >
            Cancel contest
          </PopButton>
        </div>

        {/* Repair claims: fix winners blocked by a stored-proof vs on-chain-root
            mismatch. Check first (dry run), then credit. */}
        <div className="space-y-2 border-t-line border-ink/10 pt-3">
          <label className={LABEL}>Repair claims (proof / on-chain root mismatch)</label>
          <div className="flex flex-wrap gap-2">
            <PopButton
              type="button"
              variant="ghost"
              disabled={!ready || !contestId}
              onClick={() =>
                run(async () => {
                  const r = await api.adminRepairClaims(Number(contestId), false, saved);
                  setRepair(r);
                  if (r.note) return r.note;
                  const would = r.results?.filter((x) => x.action.includes("WOULD")).length ?? 0;
                  return `Dry run for #${contestId}: ${would} winner(s) would be credited.`;
                })
              }
            >
              Check claims
            </PopButton>
            <PopButton
              type="button"
              disabled={!ready || !contestId}
              onClick={() => {
                if (
                  !window.confirm(
                    `Credit owed winners for contest #${contestId}? This mints tUSDC and cannot be undone.`,
                  )
                )
                  return;
                void run(async () => {
                  const r = await api.adminRepairClaims(Number(contestId), true, saved);
                  setRepair(r);
                  if (r.note) return r.note;
                  const credited = r.results?.filter((x) => x.action === "credited").length ?? 0;
                  return `Repaired #${contestId}: credited ${credited} winner(s).`;
                });
              }}
            >
              Repair + credit
            </PopButton>
          </div>

          {repair?.results && (
            <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 p-4 text-[13px]">
              <div className="font-body text-ink-2">
                chain root {repair.chainRoot?.slice(0, 12)}…{" "}
                {repair.dbRoot === repair.chainRoot
                  ? "matches db"
                  : `≠ db ${repair.dbRoot?.slice(0, 12)}…`}
                {repair.dryRun ? " · dry run" : " · credited"}
              </div>
              <ul className="mt-2 space-y-1">
                {repair.results.map((x) => (
                  <li
                    key={x.operator}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span className="font-mono text-[12px] text-ink">{shortAddr(x.operator)}</span>
                    <span className="font-body text-ink-2">
                      {formatUsdc(x.amountWei)} tUSDC · {x.action}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </StickerCard>

      {msg && (
        <p className={"font-body text-[14px] font-bold " + (msg.ok ? "text-ink" : "text-coral")}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
