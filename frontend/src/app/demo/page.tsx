"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { Spinner } from "@/components/ui";
import { PopButton, StickerCard } from "@/components/zerun";

export default function DemoPage() {
  const [prizePool, setPrizePool] = useState("100");
  const [duration, setDuration] = useState("300");
  const [topN, setTopN] = useState("3");
  const [puzzleCount, setPuzzleCount] = useState("5");

  const [opening, setOpening] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);
  const [runId, setRunId] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const open = useCallback(async () => {
    setMsg(null);
    setOpening(true);
    try {
      const res = await api.adminOpen({
        prizePoolUsdc: prizePool.trim(),
        durationSecs: Number(duration),
        topN: Number(topN),
        puzzleCount: Number(puzzleCount),
      });
      setLastId(res.contestId);
      setRunId(String(res.contestId));
      setMsg({ tone: "ok", text: `Opened contest #${res.contestId}.` });
    } catch (e) {
      setMsg({ tone: "err", text: friendlyError(e, "That did not go through.") });
    } finally {
      setOpening(false);
    }
  }, [prizePool, duration, topN, puzzleCount]);

  const run = useCallback(async () => {
    setMsg(null);
    const idNum = Number(runId);
    if (!Number.isFinite(idNum)) {
      setMsg({ tone: "err", text: "Enter a contest id to run." });
      return;
    }
    setRunning(true);
    try {
      await api.adminRun(idNum);
      setMsg({ tone: "ok", text: `Run started for #${idNum}. Watch it on the contest page.` });
    } catch (e) {
      setMsg({ tone: "err", text: friendlyError(e, "That did not go through.") });
    } finally {
      setRunning(false);
    }
  }, [runId]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 pt-10">
      <header>
        <h1 className="font-display text-4xl text-ink -rotate-1">Demo controls</h1>
        <p className="mt-2 font-body text-[16px] text-ink-2">
          Open a contest and start its run. Progress streams to the contest page over
          the live feed.
        </p>
      </header>

      {/* Open */}
      <StickerCard className="p-6">
        <h2 className="font-display text-xl text-ink">Open a contest</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Prize pool (tUSDC)" value={prizePool} onChange={setPrizePool} />
          <Field label="Duration (seconds)" value={duration} onChange={setDuration} type="number" />
          <Field label="Top N" value={topN} onChange={setTopN} type="number" />
          <Field label="Puzzle count" value={puzzleCount} onChange={setPuzzleCount} type="number" />
        </div>
        <PopButton
          type="button"
          onClick={open}
          disabled={opening}
          icon={opening ? <Spinner /> : undefined}
          className="mt-5"
        >
          Open contest
        </PopButton>
      </StickerCard>

      {/* Run */}
      <StickerCard className="p-6">
        <h2 className="font-display text-xl text-ink">Start a run</h2>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Contest id" value={runId} onChange={setRunId} type="number" />
          <PopButton
            type="button"
            variant="secondary"
            onClick={run}
            disabled={running}
            icon={running ? <Spinner /> : undefined}
          >
            Start run
          </PopButton>
          {lastId !== null && (
            <Link
              href={`/contest/${lastId}`}
              className="font-body text-[14px] font-extrabold text-violet underline-offset-4 hover:underline"
            >
              open contest #{lastId} →
            </Link>
          )}
        </div>
      </StickerCard>

      {msg && (
        <p
          className={`rounded-chunk border-line border-ink px-4 py-3 font-body text-[14px] font-bold text-ink ${
            msg.tone === "ok" ? "bg-mint/25" : "bg-coral/20"
          }`}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="font-body text-[12px] font-extrabold uppercase tracking-[0.02em] text-ink-2">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 min-h-[44px] w-full rounded-chunk border-line border-ink bg-cloud-2 px-4 py-2 font-body text-[15px] font-bold text-ink outline-none"
      />
    </label>
  );
}
