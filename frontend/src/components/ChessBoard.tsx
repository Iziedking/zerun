"use client";

import type { WsChessSnapshot } from "@/lib/types";
import { shortAddr } from "@/lib/format";
import { agentVariant, Chip, SkinnedAgent, StickerCard, cx } from "./zerun";

// The live chess view: an outlined sticker board with cartoon agent characters top and
// bottom, the running captured-material score, a highlight on the last move, and the
// mover's reasoning "on 0G" in a thought bubble. Mirrors the poker table's live feel.

const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

// FEN placement -> 64 squares, index 0 = a8 (top-left with white at the bottom).
function fenToBoard(fen: string): string[] {
  const placement = (fen || "").split(" ")[0] ?? "";
  const board: string[] = [];
  for (const rank of placement.split("/")) {
    for (const ch of rank) {
      if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) board.push("");
      else board.push(ch);
    }
  }
  while (board.length < 64) board.push("");
  return board;
}

// Algebraic square ("e2") -> render index in the a8-first array.
function algToIdx(alg: string): number {
  if (!alg || alg.length < 2) return -1;
  const file = alg.charCodeAt(0) - 97;
  const rank = Number(alg[1]) - 1;
  return (7 - rank) * 8 + file;
}

function PlayerBar({
  snap,
  color,
  active,
}: {
  snap: WsChessSnapshot;
  color: "w" | "b";
  active: boolean;
}) {
  // The mover carries the identity/skin we know; the other side we only style by color.
  const isMover = snap.mover.color === color;
  const captured = color === "w" ? snap.captures.w : snap.captures.b;
  return (
    <div
      className={cx(
        "flex items-center gap-3 rounded-chunk border-line border-ink px-3 py-2 transition",
        active ? "bg-mint/20 shadow-pop-press" : "bg-cloud",
      )}
    >
      <SkinnedAgent
        agentId={snap.mover.agentId}
        variant={agentVariant(isMover ? snap.mover.agentId : snap.mover.agentId + 1)}
        mood={active ? "thinking" : "idle"}
        size={30}
        name={isMover ? snap.mover.agentName : color === "w" ? "White" : "Black"}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[14px] text-ink">
            {isMover ? snap.mover.agentName : color === "w" ? "White" : "Black"}
          </span>
          <span
            className="grid h-4 w-4 place-items-center rounded-full border border-ink text-[10px]"
            style={{ background: color === "w" ? "#fff" : "#171449", color: color === "w" ? "#171449" : "#fff" }}
            aria-label={color === "w" ? "white" : "black"}
          >
            ♚
          </span>
          {active && <Chip tone="thinking">to move</Chip>}
        </div>
        {isMover && <span className="font-mono text-[11px] text-ink-3">{shortAddr(snap.mover.operator)}</span>}
      </div>
      <div className="shrink-0 text-right">
        <div className="font-display text-lg text-ink">{captured}</div>
        <div className="font-mono text-[10px] text-ink-3">captured</div>
      </div>
    </div>
  );
}

export function ChessBoard({ snapshot }: { snapshot: WsChessSnapshot }) {
  const board = fenToBoard(snapshot.fen);
  const fromIdx = algToIdx(snapshot.lastFrom);
  const toIdx = algToIdx(snapshot.lastTo);

  return (
    <StickerCard className="p-4 sm:p-5">
      {snapshot.match && (
        <div className="mb-3 flex items-center gap-2">
          <Chip tone="won">{snapshot.match.label}</Chip>
        </div>
      )}
      <PlayerBar snap={snapshot} color="b" active={snapshot.turn === "b"} />

      <div className="mx-auto my-3 w-full max-w-[420px]">
        <div className="grid grid-cols-8 overflow-hidden rounded-chunk border-line border-ink shadow-pop">
          {board.map((piece, i) => {
            const file = i % 8;
            const rank = 7 - Math.floor(i / 8);
            const light = (file + rank) % 2 === 1;
            const lastMove = i === fromIdx || i === toIdx;
            const white = piece !== "" && piece === piece.toUpperCase();
            return (
              <div
                key={i}
                className={cx(
                  "relative aspect-square select-none",
                  light ? "bg-cloud-2" : "bg-violet/25",
                  lastMove && "ring-2 ring-inset ring-amber",
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

      <PlayerBar snap={snapshot} color="w" active={snapshot.turn === "w"} />

      {/* The mover's reasoning, from 0G. */}
      <div className="mt-3 rounded-chunk border-line border-ink bg-cloud-2 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-body text-[13px] font-extrabold text-ink">
            {snapshot.mover.agentName} played {snapshot.lastMove}
            {snapshot.capture ? " ✕" : ""}
          </span>
          <Chip tone={snapshot.source === "0g-compute" ? "info" : "neutral"}>
            {snapshot.source === "engine" ? "engine" : "on 0G"}
          </Chip>
        </div>
        {snapshot.reason && (
          <p className="mt-1 font-body text-[13px] text-ink-2">{snapshot.reason}</p>
        )}
        <div className="mt-1 font-mono text-[10px] text-ink-3">
          {snapshot.model}
          {snapshot.verified === true ? " · verified on 0G" : ""} · move {snapshot.ply}
        </div>
      </div>
    </StickerCard>
  );
}
