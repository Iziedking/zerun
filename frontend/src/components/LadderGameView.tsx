"use client";

import { useEffect, useMemo, useState } from "react";
import { useChessGame } from "@/lib/useAgents";
import type { ChessLiveGame } from "@/lib/types";
import { Agent, agentVariant, Chip, PopButton, StickerCard, cx } from "@/components/zerun";

// Watch one agent's game: live if it is playing right now, or a replay of its most recent game.
// Opened by clicking an agent on the leaderboard. A lean board of its own (the rich ChessBoard is
// for bracket duels and needs a WS snapshot we do not have here).

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

function fenToBoard(fen: string): string[] {
  const placement = (fen || "").split(" ")[0] ?? "";
  const out: string[] = [];
  for (const rank of placement.split("/")) {
    for (const ch of rank) {
      if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push("");
      else out.push(ch);
    }
  }
  while (out.length < 64) out.push("");
  return out;
}

// UCI square ("e2") -> render index in the a8-first array (index 0 = a8, white at the bottom).
function sqToIdx(sq: string): number {
  if (!sq || sq.length < 2) return -1;
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]) - 1;
  return (7 - rank) * 8 + file;
}

function Board({ fen, lastUci }: { fen: string; lastUci: string | null }) {
  const board = fenToBoard(fen);
  const fromIdx = lastUci ? sqToIdx(lastUci.slice(0, 2)) : -1;
  const toIdx = lastUci ? sqToIdx(lastUci.slice(2, 4)) : -1;
  return (
    <div className="mx-auto w-full max-w-[420px]">
      <div className="grid grid-cols-8 overflow-hidden rounded-chunk border-line border-ink shadow-pop">
        {board.map((piece, i) => {
          const file = i % 8;
          const rank = 7 - Math.floor(i / 8);
          const light = (file + rank) % 2 === 1;
          const isLast = i === fromIdx || i === toIdx;
          const white = piece !== "" && piece === piece.toUpperCase();
          return (
            <div
              key={i}
              className={cx(
                "relative aspect-square select-none",
                light ? "bg-cloud-2" : "bg-violet/25",
                isLast && "ring-2 ring-inset ring-amber",
              )}
            >
              {piece !== "" && (
                <span
                  className={cx(
                    "absolute inset-0 grid place-items-center text-[clamp(18px,6vw,34px)] leading-none",
                    white ? "text-cloud" : "text-ink",
                  )}
                  style={white ? { WebkitTextStroke: "1.4px #171449", textShadow: "0 1px 0 #171449" } : undefined}
                >
                  {GLYPH[piece.toLowerCase()]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function kindTone(kind: string): "won" | "info" | "neutral" {
  return kind === "upload" ? "won" : kind === "showcase" ? "info" : "neutral";
}

function Side({ name, kind, active, winner }: { name: string; kind: string; active: boolean; winner: boolean }) {
  return (
    <div
      className={cx(
        "flex items-center gap-3 rounded-chunk border-line border-ink px-3 py-2",
        active ? "bg-mint/20 shadow-pop-press" : "bg-cloud",
      )}
    >
      <Agent variant={agentVariant(name)} mood={active ? "thinking" : winner ? "happy" : "idle"} size={30} name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-display text-[15px] text-ink">{name}</span>
          <Chip tone={kindTone(kind)}>{kind === "house" ? "house" : kind}</Chip>
          {winner && <Chip tone="won">winner</Chip>}
        </div>
      </div>
      {active && <Chip tone="thinking">to move</Chip>}
    </div>
  );
}

function resultLine(game: ChessLiveGame): string {
  if (game.status === "playing") return `Move ${game.moves.length}, ${game.moves.length % 2 === 0 ? "white" : "black"} to move`;
  if (game.winner === null) return `Draw by ${game.how ?? "the rules"}`;
  return `${game.winner} won by ${game.how ?? "the board"}`;
}

export function LadderGameView({ agentId, onClose }: { agentId: number; onClose: () => void }) {
  const { data, isLoading } = useChessGame(agentId);
  const game = data?.game ?? null;
  const live = game?.status === "playing";

  // Replay position for a finished game: -1 = start, then each move's resulting position.
  const [ply, setPly] = useState(-1);
  const [playing, setPlaying] = useState(true);

  // A fresh finished game starts its replay from the top and auto-plays.
  useEffect(() => {
    if (game && game.status === "done") {
      setPly(-1);
      setPlaying(true);
    }
  }, [game?.whiteId, game?.blackId, game?.startedAt, game?.status]);

  // Auto-advance the replay.
  useEffect(() => {
    if (!game || game.status !== "done" || !playing) return;
    if (ply >= game.moves.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setPly((p) => Math.min(p + 1, game.moves.length - 1)), 850);
    return () => clearTimeout(t);
  }, [game, playing, ply]);

  const view = useMemo(() => {
    if (!game) return { fen: START_FEN, lastUci: null as string | null };
    if (live) {
      const last = game.moves[game.moves.length - 1];
      return { fen: game.fen, lastUci: last ? last.uci : null };
    }
    if (ply < 0) return { fen: START_FEN, lastUci: null };
    const m = game.moves[ply];
    return { fen: m ? m.fen : game.fen, lastUci: m ? m.uci : null };
  }, [game, live, ply]);

  const turn = view.fen.split(" ")[1] ?? "w";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <StickerCard className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {live ? (
              <Chip tone="live" pulse>
                live game
              </Chip>
            ) : (
              <Chip tone="neutral">last game</Chip>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-chunk border-line border-ink bg-cloud text-ink shadow-pop-press transition hover:-translate-y-px"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {isLoading ? (
          <div className="mt-4 h-72 animate-pulse rounded-chunk border-line border-ink bg-cloud-2" aria-hidden />
        ) : !game ? (
          <p className="mt-6 text-center font-body text-[15px] text-ink-2">
            No game to watch for this agent yet. It plays soon, then its game shows up here.
          </p>
        ) : (
          <>
            <div className="mt-3">
              <Side
                name={game.black}
                kind={game.blackKind}
                active={live ? turn === "b" : false}
                winner={game.status === "done" && game.winner === game.black}
              />
            </div>
            <div className="my-3">
              <Board fen={view.fen} lastUci={view.lastUci} />
            </div>
            <Side
              name={game.white}
              kind={game.whiteKind}
              active={live ? turn === "w" : false}
              winner={game.status === "done" && game.winner === game.white}
            />

            <div className="mt-3 rounded-chunk border-line border-ink bg-cloud-2 px-4 py-2.5 text-center">
              <span className="font-body text-[14px] font-extrabold text-ink">{resultLine(game)}</span>
            </div>

            {game.status === "done" && game.moves.length > 0 && (
              <div className="mt-3 flex items-center justify-center gap-2">
                <ReplayBtn label="Start" onClick={() => { setPlaying(false); setPly(-1); }} />
                <ReplayBtn label="Prev" onClick={() => { setPlaying(false); setPly((p) => Math.max(-1, p - 1)); }} />
                <PopButton onClick={() => setPlaying((p) => !p)} className="min-w-[92px]">
                  {playing ? "Pause" : ply >= game.moves.length - 1 ? "Replay" : "Play"}
                </PopButton>
                <ReplayBtn label="Next" onClick={() => { setPlaying(false); setPly((p) => Math.min(game.moves.length - 1, p + 1)); }} />
                <span className="ml-1 font-mono text-[12px] text-ink-3">
                  {ply + 1}/{game.moves.length}
                </span>
              </div>
            )}
          </>
        )}
      </StickerCard>
    </div>
  );
}

function ReplayBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-pill border-line border-ink bg-cloud px-3 py-1.5 font-body text-[12px] font-extrabold text-ink shadow-pop-press transition hover:-translate-y-px"
    >
      {label}
    </button>
  );
}
