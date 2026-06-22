"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { Spinner } from "@/components/ui";

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
      setMsg({ tone: "err", text: e instanceof Error ? e.message.split("\n")[0] : "Failed." });
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
      setMsg({ tone: "err", text: e instanceof Error ? e.message.split("\n")[0] : "Failed." });
    } finally {
      setRunning(false);
    }
  }, [runId]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 pt-10">
      <header>
        <h1 className="text-2xl font-700 tracking-[-0.01em] text-bone">Demo controls</h1>
        <p className="mt-1 text-sm text-haze">
          Open a contest and start its run. Progress streams to the contest page over the
          live feed.
        </p>
      </header>

      {/* Open */}
      <section className="panel p-5">
        <h2 className="text-sm font-600 uppercase tracking-[0.16em] text-haze">
          Open a contest
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Prize pool (tUSDC)" value={prizePool} onChange={setPrizePool} />
          <Field label="Duration (seconds)" value={duration} onChange={setDuration} type="number" />
          <Field label="Top N" value={topN} onChange={setTopN} type="number" />
          <Field
            label="Puzzle count"
            value={puzzleCount}
            onChange={setPuzzleCount}
            type="number"
          />
        </div>
        <button
          type="button"
          onClick={open}
          disabled={opening}
          className="mt-4 inline-flex items-center gap-2 rounded-md border border-signal/45 bg-signal/10 px-4 py-2 text-sm font-600 text-bone transition hover:bg-signal/15 disabled:opacity-50"
        >
          {opening && <Spinner className="text-signal" />}
          Open contest
        </button>
      </section>

      {/* Run */}
      <section className="panel p-5">
        <h2 className="text-sm font-600 uppercase tracking-[0.16em] text-haze">
          Start a run
        </h2>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Contest id" value={runId} onChange={setRunId} type="number" />
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md border border-edge/70 px-4 py-2 text-sm font-600 text-chalk transition hover:border-signal/50 hover:text-bone disabled:opacity-50"
          >
            {running && <Spinner />}
            Start run
          </button>
          {lastId !== null && (
            <Link
              href={`/contest/${lastId}`}
              className="text-sm text-signal underline-offset-4 hover:underline"
            >
              open contest #{lastId} →
            </Link>
          )}
        </div>
      </section>

      {msg && (
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            msg.tone === "ok"
              ? "border-signal/40 bg-signal/5 text-signal"
              : "border-ember/40 bg-ember/5 text-ember"
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
      <span className="text-[10px] uppercase tracking-[0.18em] text-haze">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-edge/70 bg-ink-900 px-3 py-2 text-sm text-bone outline-none focus:border-signal/60"
      />
    </label>
  );
}
