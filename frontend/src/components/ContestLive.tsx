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
  WsPokerSnapshot,
  WsChessSnapshot,
  WsBracketSnapshot,
  WsX402Payload,
} from "@/lib/types";
import { kindMeta } from "@/lib/kind";
import { useMusic } from "@/lib/music";
import {
  playActionSound,
  playChessMove,
  playChessGameEnd,
  playChessGameStart,
  playPokerAction,
  preloadChessSfx,
  preloadPokerSfx,
} from "@/lib/sound";
import { SolveCard, type SolveRow } from "./SolveCard";
import { PokerTable, X402Feed } from "./PokerTable";
import { ChessBoard } from "./ChessBoard";
import { TournamentBracket } from "./TournamentBracket";
import { StandingsTable } from "./StandingsTable";
import { SettledBanner } from "./SettledBanner";
import { LiveWinnerOverlay } from "./LiveWinnerOverlay";
import { Chip, LoadMore, StickerCard } from "./zerun";

// Minimum gap between action blips, so a fast feed stays pleasant rather than a buzz.
const SFX_THROTTLE_MS = 180;

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
    samples: f.samples,
    sources: f.sources,
  };
}

export function ContestLive({
  contestId,
  initialStandings,
  highlight,
  kind = "solver",
  isChallenge = false,
}: {
  contestId: number;
  initialStandings: Standing[];
  highlight?: string;
  kind?: ContestKind;
  /** An entry-fee challenge. The house never joins one, which changes how a chess lobby ends. */
  isChallenge?: boolean;
}) {
  const [rows, setRows] = useState<SolveRow[]>([]);
  const [visible, setVisible] = useState(FEED_PAGE);
  const [standings, setStandings] = useState<Standing[]>(initialStandings);
  const [status, setStatus] = useState<WsStatusPayload | null>(null);
  const [settled, setSettled] = useState<WsSettledPayload | null>(null);
  const [snapshot, setSnapshot] = useState<WsPokerSnapshot | null>(null);
  const [chessSnap, setChessSnap] = useState<WsChessSnapshot | null>(null);
  const [bracket, setBracket] = useState<WsBracketSnapshot | null>(null);
  const [payments, setPayments] = useState<WsX402Payload[]>([]);
  const [winnerOverlay, setWinnerOverlay] = useState<{ winner: Standing; prize: string | null } | null>(null);
  const seqRef = useRef(0);

  // Warm this game's samples on mount, so the first action is not the one that discovers a file
  // is missing and falls back mid-game.
  useEffect(() => {
    if (kind === "chess") preloadChessSfx();
    if (kind === "poker") preloadPokerSfx();
  }, [kind]);

  // Sound: gated by the global mute (the music toggle also mutes effects). Refs let the
  // stable message handler read the latest values without re-subscribing the socket.
  const { muted, duck } = useMusic();
  const mutedRef = useRef(muted);
  const lastSfxRef = useRef(0);
  // How many bracket matches were decided at the last snapshot, so a newly finished game
  // sounds its cadence exactly once. -1 until the first snapshot: an operator opening the
  // page mid-tournament must not hear a cadence for games that finished before they arrived.
  const decidedRef = useRef(-1);
  // Latest standings, so the settle handler can name the winner (rank 1) at once.
  const standingsRef = useRef<Standing[]>(initialStandings);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // A game brings its own sound. Pause the theme while a chess or poker contest is on screen
  // and give it back on the way out — without touching the mute setting, so the operator's own
  // choice survives the visit. The other kinds have no in-game audio, so they keep the theme.
  useEffect(() => {
    if (kind !== "chess" && kind !== "poker") return;
    duck(true);
    return () => duck(false);
  }, [kind, duck]);

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
        samples: p.samples,
        sources: p.sources,
        liveInsight: p.liveInsight,
        reasoning: p.reasoning,
        fresh: true,
      };
      setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
      // A short, kind-themed blip as each live action lands, throttled so a fast feed
      // stays pleasant. Muting the music mutes these too.
      const t = Date.now();
      if (!mutedRef.current && t - lastSfxRef.current > SFX_THROTTLE_MS) {
        lastSfxRef.current = t;
        if (kind === "poker") playPokerAction(p.answer);
        else playActionSound(kind);
      }
    } else if (msg.type === "standings") {
      const mapped = msg.payload.map((s) => ({
        rank: s.rank,
        agentId: s.agentId,
        agentName: s.agentName,
        operator: s.operator,
        correct: s.correct,
        totalLatencyMs: s.totalLatencyMs,
        computeLevel: s.computeLevel,
        passes: s.passes,
        score: s.score,
        metric: s.metric,
      }));
      standingsRef.current = mapped;
      setStandings(mapped);
    } else if (msg.type === "status") {
      setStatus(msg.payload);
    } else if (msg.type === "settled") {
      setSettled(msg.payload);
      setStatus({ status: "settled" });
      // Surface the winner to everyone watching live, the instant it settles. Rank 1 is
      // the game winner by strength and may be a house agent. House never takes the pot,
      // though: the prize routes to the best real player, so only attribute a prize when
      // the winner is a real player (a house winner shows with a "prize to top human"
      // note instead). The paid winner gets their own app-wide "You won!" celebration, so
      // skip the spectator overlay for them to avoid two stacked modals.
      const winner = standingsRef.current[0];
      const isMe = highlight && winner?.operator?.toLowerCase() === highlight.toLowerCase();
      if (winner && !isMe) {
        const prize = winner.isHouse ? null : (msg.payload.payouts.find((p) => p.rank === 1)?.amount ?? null);
        setWinnerOverlay({ winner, prize });
      }
    } else if (msg.type === "poker") {
      setSnapshot(msg.payload);
    } else if (msg.type === "chess") {
      const p = msg.payload;
      setChessSnap(p);

      // A chess move IS an answer, and it never reached the feed: the runner broadcasts a
      // `chess` board snapshot, while the feed only listened for `solve`. So the live feed sat
      // on "waiting for the first answer" while moves streamed past above it. The snapshot
      // already carries the full 0G provenance, so derive the row here rather than making the
      // backend send every move twice.
      seqRef.current += 1;
      const row: SolveRow = {
        key: `chess-${p.ply}-${p.mover.agentId}`,
        agentId: p.mover.agentId,
        agentName: p.mover.agentName || `Agent #${p.mover.agentId}`,
        puzzleIdx: p.ply - 1,
        prompt: p.match ? `${p.match.label} · ${p.mover.color === "w" ? "white" : "black"}` : p.mover.color === "w" ? "white" : "black",
        answer: p.lastMove,
        verdict: "move",
        provider: p.provider,
        model: p.model,
        chatId: p.chatID ?? "",
        latencyMs: p.latencyMs,
        verified: p.verified,
        source: p.source,
        reasoning: p.reason,
        fresh: true,
      };
      setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
      // A piece landing, and a heavier double knock when it took something. Moves arrive a
      // few seconds apart, so this is never throttled away the way a fast solve feed is —
      // but keep the guard, because the engine can play a fallback move instantly.
      const tc = Date.now();
      if (!mutedRef.current) {
        // Ply 1 is the opening move of a game — of the duel, or of each bracket match, since
        // playChessGame restarts the count per game. Announce it, then let the moves knock.
        if (p.ply === 1) {
          lastSfxRef.current = tc;
          playChessGameStart();
        } else if (tc - lastSfxRef.current > SFX_THROTTLE_MS) {
          lastSfxRef.current = tc;
          playChessMove(p.capture);
        }
      }
    } else if (msg.type === "bracket") {
      // A game just ended when one more match has a winner than it did a tick ago. The board
      // snapshot cannot tell us: it stops arriving, it never announces. Counting decided
      // matches is the only signal the bracket actually gives.
      const decided = msg.payload.rounds.flat().filter((m) => m.winner != null).length;
      const isNewGame = decidedRef.current >= 0 && decided > decidedRef.current;
      decidedRef.current = decided;
      if (isNewGame && !mutedRef.current) playChessGameEnd();
      setBracket(msg.payload);
    } else if (msg.type === "x402") {
      setPayments((prev) => [msg.payload, ...prev].slice(0, 20));
    }
  }, [kind, highlight]);

  const socketState = useContestSocket(contestId, { onMessage });

  return (
    <div className="space-y-6">
      {winnerOverlay && (
        <LiveWinnerOverlay
          contestId={contestId}
          winner={winnerOverlay.winner}
          prize={winnerOverlay.prize}
          onDismiss={() => setWinnerOverlay(null)}
        />
      )}
      {kind === "poker" && snapshot && <PokerTable snapshot={snapshot} />}
      {kind === "chess" && bracket && <TournamentBracket snapshot={bracket} isChallenge={isChallenge} />}
      {kind === "chess" && chessSnap && <ChessBoard snapshot={chessSnap} />}
      {(kind === "poker" || kind === "worldcup") && <X402Feed payments={payments} />}
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

  const title =
    kind === "analyst" ? "Live forecast feed" : kind === "poker" ? "Live duel feed" : "Live solve feed";

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
