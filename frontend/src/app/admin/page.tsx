"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { shortAddr } from "@/lib/format";
import { StickerCard, PopButton } from "@/components/zerun";

const TOKEN_KEY = "zerun:admin:token";
const INPUT =
  "w-full rounded-chunk border-line border-ink bg-cloud px-4 py-2.5 font-body text-[15px] text-ink shadow-pop-press outline-none placeholder:text-ink-3 focus:-translate-y-px";
const LABEL = "block font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2";

type AgentInfo = Awaited<ReturnType<typeof api.adminAgent>>;

// Internal support console: credit a training payment that did not reflect (the
// common RPC-blip case) or override an agent's Compute level. Everything is gated
// by the admin token, which the backend checks on every call.
export default function AdminPage() {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState("");
  const [agentId, setAgentId] = useState("");
  const [txHash, setTxHash] = useState("");
  const [level, setLevel] = useState("");
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY) ?? "";
    setSaved(t);
    setToken(t);
  }, []);

  const saveToken = () => {
    localStorage.setItem(TOKEN_KEY, token.trim());
    setSaved(token.trim());
    setMsg({ ok: true, text: "Token saved in this browser." });
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

  const lookup = () =>
    run(async () => {
      const r = await api.adminAgent(Number(agentId), saved);
      setInfo(r);
      return `Loaded agent #${r.agent.agent_id}.`;
    });

  const credit = () =>
    run(async () => {
      const r = await api.adminCreditTraining(
        { agentId: Number(agentId), txHash: txHash.trim() },
        saved,
      );
      const a = await api.adminAgent(Number(agentId), saved).catch(() => null);
      if (a) setInfo(a);
      return `Credited. Agent #${agentId} is now Compute level ${r.computeLevel}.`;
    });

  const setCompute = () =>
    run(async () => {
      const r = await api.adminSetCompute({ agentId: Number(agentId), level: Number(level) }, saved);
      const a = await api.adminAgent(Number(agentId), saved).catch(() => null);
      if (a) setInfo(a);
      return `Agent #${agentId} set to Compute level ${r.computeLevel}.`;
    });

  const canAct = Boolean(saved) && Boolean(agentId) && !busy;

  return (
    <div className="mx-auto max-w-2xl space-y-6 pt-10">
      <header>
        <h1 className="font-display text-4xl text-ink -rotate-1">Admin</h1>
        <p className="mt-1 font-body text-[15px] text-ink-2">
          Support tools. Everything here is gated by the admin token.
        </p>
      </header>

      <StickerCard className="space-y-3 p-5">
        <label className={LABEL}>Admin token</label>
        <div className="flex flex-wrap gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste the admin token"
            className={INPUT + " flex-1"}
          />
          <PopButton type="button" onClick={saveToken}>
            Save
          </PopButton>
        </div>
        <p className="font-body text-[12px] text-ink-3">
          {saved ? "Token set for this browser." : "Set the token to use the tools below."}
        </p>
      </StickerCard>

      <StickerCard className="space-y-4 p-5">
        <div>
          <label className={LABEL}>Agent id</label>
          <div className="mt-1 flex flex-wrap gap-2">
            <input
              inputMode="numeric"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 29"
              className={INPUT + " flex-1"}
            />
            <PopButton type="button" variant="ghost" onClick={lookup} disabled={!canAct}>
              Look up
            </PopButton>
          </div>
        </div>

        {info && (
          <div className="rounded-chunk border-line border-ink/15 bg-cloud-2 p-4">
            <div className="font-display text-lg text-ink">
              {info.agent.name} · Compute level {info.agent.compute_level}
              {info.agent.is_house ? " · house" : ""}
            </div>
            <div className="mt-0.5 font-mono text-[12px] text-ink-2">
              owner {shortAddr(info.agent.owner)}
            </div>
            <div className="mt-3 font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-3">
              recent trainings
            </div>
            {info.trainings.length === 0 ? (
              <p className="font-body text-[13px] text-ink-3">none on record</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {info.trainings.map((t) => (
                  <li key={t.tx_hash} className="font-mono text-[12px] text-ink-2">
                    L{t.level_after} · {shortAddr(t.tx_hash, 10, 8)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </StickerCard>

      <StickerCard className="space-y-4 p-5">
        <h2 className="font-display text-lg text-ink">Credit a training payment</h2>
        <p className="font-body text-[13px] text-ink-2">
          For a payment that is on chain but did not reflect. Re-reads the transaction and credits
          the next level if it checks out.
        </p>
        <div>
          <label className={LABEL}>Payment tx hash</label>
          <input
            value={txHash}
            onChange={(e) => setTxHash(e.target.value.trim())}
            placeholder="0x…"
            className={INPUT + " mt-1 font-mono text-[13px]"}
          />
        </div>
        <PopButton type="button" onClick={credit} disabled={!canAct || !txHash}>
          {busy ? "Working" : "Credit training"}
        </PopButton>
      </StickerCard>

      <StickerCard className="space-y-4 p-5">
        <h2 className="font-display text-lg text-ink">Override Compute level</h2>
        <p className="font-body text-[13px] text-ink-2">
          Emergency only. Sets the level directly without a payment.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <label className={LABEL}>Level (0 to 5)</label>
            <input
              inputMode="numeric"
              value={level}
              onChange={(e) => setLevel(e.target.value.replace(/\D/g, ""))}
              placeholder="0-5"
              className={INPUT + " mt-1"}
            />
          </div>
          <PopButton type="button" variant="ghost" onClick={setCompute} disabled={!canAct || level === ""}>
            Set level
          </PopButton>
        </div>
      </StickerCard>

      {msg && (
        <p
          className={
            "font-body text-[14px] font-bold " + (msg.ok ? "text-ink" : "text-coral")
          }
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}
