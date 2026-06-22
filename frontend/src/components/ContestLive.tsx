"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useContestSocket, type SocketState } from "@/lib/useContestSocket";
import type {
  FeedItem,
  Standing,
  WsMessage,
  WsSettledPayload,
  WsStatusPayload,
} from "@/lib/types";
import { SolveCard, type SolveRow } from "./SolveCard";
import { StandingsTable } from "./StandingsTable";
import { SettledBanner } from "./SettledBanner";
import { StatusDot } from "./ui";

const MAX_ROWS = 60;

function feedItemToRow(f: FeedItem): SolveRow {
  return {
    key: `feed-${f.id}`,
    agentName: f.agentName || `Agent #${f.agent_id}`,
    puzzleIdx: f.puzzle_idx,
    prompt: f.prompt,
    answer: f.answer,
    verdict: f.verdict,
    provider: f.provider,
    model: f.model,
    chatId: f.chat_id,
    latencyMs: f.latency_ms,
    verified: f.verified,
    source: f.source,
  };
}

export function ContestLive({
  contestId,
  initialStandings,
  highlight,
}: {
  contestId: number;
  initialStandings: Standing[];
  highlight?: string;
}) {
  const [rows, setRows] = useState<SolveRow[]>([]);
  const [standings, setStandings] = useState<Standing[]>(initialStandings);
  const [status, setStatus] = useState<WsStatusPayload | null>(null);
  const [settled, setSettled] = useState<WsSettledPayload | null>(null);
  const seqRef = useRef(0);

  // Initial feed load (live updates then arrive over the WS).
  useEffect(() => {
    let active = true;
    api
      .feed(contestId, 0)
      .then((res) => {
        if (!active) return;
        const ordered = [...res.feed].sort((a, b) => b.id - a.id);
        setRows(ordered.slice(0, MAX_ROWS).map(feedItemToRow));
      })
      .catch(() => {
        /* empty feed is a valid state */
      });
    return () => {
      active = false;
    };
  }, [contestId]);

  const onMessage = useCallback((msg: WsMessage) => {
    if (msg.type === "solve") {
      const p = msg.payload;
      seqRef.current += 1;
      const row: SolveRow = {
        key: `ws-${seqRef.current}-${p.agentId}-${p.puzzleIdx}`,
        agentName: p.agentName || `Agent #${p.agentId}`,
        puzzleIdx: p.puzzleIdx,
        prompt: p.prompt,
        answer: p.answer,
        verdict: p.verdict,
        provider: p.provider,
        model: p.model,
        chatId: p.chatID,
        latencyMs: p.latencyMs,
        verified: p.verified,
        source: p.source,
        fresh: true,
      };
      setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
    } else if (msg.type === "standings") {
      setStandings(
        msg.payload.map((s) => ({
          rank: s.rank,
          agentId: s.agentId,
          agentName: s.agentName,
          operator: s.operator,
          correct: s.correct,
          totalLatencyMs: s.totalLatencyMs,
        })),
      );
    } else if (msg.type === "status") {
      setStatus(msg.payload);
    } else if (msg.type === "settled") {
      setSettled(msg.payload);
      setStatus({ status: "settled" });
    }
  }, []);

  const socketState = useContestSocket(contestId, { onMessage });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* Live solve feed */}
      <section>
        <FeedHeader socketState={socketState} status={status} count={rows.length} />
        <div className="mt-3 space-y-3">
          {rows.length ? (
            rows.map((row) => <SolveCard key={row.key} row={row} />)
          ) : (
            <div className="panel p-10 text-center">
              <p className="text-sm text-haze">
                Waiting for the first solve. Each answer arrives here with its 0G
                Compute provenance the moment the run begins.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Right rail: standings and settlement */}
      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        {settled && <SettledBanner data={settled} />}
        <div>
          <h3 className="mb-2 text-sm font-600 uppercase tracking-[0.16em] text-haze">
            Standings
          </h3>
          <StandingsTable standings={standings} highlight={highlight} />
        </div>
      </aside>
    </div>
  );
}

function FeedHeader({
  socketState,
  status,
  count,
}: {
  socketState: SocketState;
  status: WsStatusPayload | null;
  count: number;
}) {
  const live = socketState === "open";
  const label = useMemo(() => {
    if (socketState === "connecting") return "connecting";
    if (socketState === "closed") return "reconnecting";
    return status?.status ? `live · ${status.status}` : "live";
  }, [socketState, status]);

  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-600 uppercase tracking-[0.16em] text-haze">
        Live solve feed
      </h2>
      <span className="inline-flex items-center gap-2 rounded-full border border-edge/70 bg-ink-700/70 px-3 py-1 text-[11px] font-500 text-chalk">
        <StatusDot live={live} />
        {label}
        <span className="text-haze">· {count}</span>
      </span>
    </div>
  );
}
