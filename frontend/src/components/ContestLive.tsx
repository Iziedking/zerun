"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useContestSocket, type SocketState } from "@/lib/useContestSocket";
import type {
  ContestKind,
  FeedItem,
  Standing,
  WsMessage,
  WsSettledPayload,
  WsStatusPayload,
} from "@/lib/types";
import { kindMeta } from "@/lib/kind";
import { SolveCard, type SolveRow } from "./SolveCard";
import { StandingsTable } from "./StandingsTable";
import { SettledBanner } from "./SettledBanner";
import { Chip, LoadMore, StickerCard } from "./zerun";

const MAX_ROWS = 60;
// Show the freshest answers; older ones tuck behind "load more".
const FEED_PAGE = 8;

function feedItemToRow(f: FeedItem): SolveRow {
  return {
    key: `feed-${f.id}`,
    agentId: f.agent_id,
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
  kind = "solver",
}: {
  contestId: number;
  initialStandings: Standing[];
  highlight?: string;
  kind?: ContestKind;
}) {
  const [rows, setRows] = useState<SolveRow[]>([]);
  const [visible, setVisible] = useState(FEED_PAGE);
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
        agentId: p.agentId,
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
        <FeedHeader socketState={socketState} status={status} count={rows.length} kind={kind} />
        <div className="mt-4 space-y-4">
          {rows.length ? (
            <>
              {rows.slice(0, visible).map((row) => (
                <SolveCard key={row.key} row={row} kind={kind} />
              ))}
              <LoadMore
                remaining={rows.length - Math.min(visible, rows.length)}
                label="Show older"
                onMore={() => setVisible((n) => n + FEED_PAGE)}
              />
            </>
          ) : (
            <StickerCard className="p-10 text-center">
              <p className="font-body text-[15px] text-ink-2">
                Waiting for the first answer. Every {kindMeta(kind).taskWord} lands here
                with its 0G Compute provenance the moment the run begins.
              </p>
            </StickerCard>
          )}
        </div>
      </section>

      {/* Right rail: standings and settlement */}
      <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
        {settled && <SettledBanner data={settled} />}
        <div>
          <h3 className="mb-3 font-display text-xl text-ink">Standings</h3>
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
  kind,
}: {
  socketState: SocketState;
  status: WsStatusPayload | null;
  count: number;
  kind: ContestKind;
}) {
  const live = socketState === "open";
  const label = useMemo(() => {
    if (socketState === "connecting") return "connecting";
    if (socketState === "closed") return "reconnecting";
    return status?.status ? `live · ${status.status}` : "live";
  }, [socketState, status]);

  const title = kind === "analyst" ? "Live forecast feed" : "Live solve feed";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <h2 className="font-display text-2xl text-ink">{title}</h2>
        <Chip tone={kindMeta(kind).tone}>{kindMeta(kind).label}</Chip>
      </div>
      <Chip tone={live ? "live" : "neutral"} pulse={live}>
        {label} · {count}
      </Chip>
    </div>
  );
}
