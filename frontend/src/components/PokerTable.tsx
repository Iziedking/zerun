"use client";

import type { WsPokerSnapshot, WsX402Payload } from "@/lib/types";
import { agentVariant, Chip, SkinnedAgent, StickerCard, ThoughtBubble, cx } from "./zerun";
import { ExplorerLink } from "./ExplorerLink";

const RED = new Set(["h", "d"]);
const SUIT: Record<string, string> = { h: "♥", d: "♦", c: "♣", s: "♠" };

function Card({ token, hidden }: { token?: string; hidden?: boolean }) {
  if (hidden || !token) {
    return (
      <span
        className="inline-block h-10 w-8 rounded-md border-2 border-ink bg-violet/70 shadow-[2px_2px_0_#171449]"
        aria-hidden
      />
    );
  }
  const rank = token.slice(0, -1).replace("T", "10");
  const suit = token.slice(-1);
  return (
    <span
      className={cx(
        "inline-flex h-10 w-8 flex-col items-center justify-center rounded-md border-2 border-ink bg-white font-body font-extrabold shadow-[2px_2px_0_#171449]",
        RED.has(suit) ? "text-coral" : "text-ink",
      )}
    >
      <span className="text-[13px] leading-none">{rank}</span>
      <span className="text-[11px] leading-none">{SUIT[suit] ?? ""}</span>
    </span>
  );
}

function Seat({ seat }: { seat: WsPokerSnapshot["seats"][number] }) {
  return (
    <div className={cx("flex flex-col items-center gap-2", seat.folded && "opacity-40")}>
      <SkinnedAgent
        agentId={seat.agentId}
        variant={agentVariant(seat.agentId)}
        mood={seat.folded ? "lose" : seat.isTurn ? "thinking" : "idle"}
        size={76}
        name={seat.name}
      />
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <span className="font-display text-[15px] text-ink">{seat.name}</span>
        {seat.isHouse && <Chip tone="neutral">house</Chip>}
        {seat.isTurn && <Chip tone="thinking">to act</Chip>}
      </div>
      <div className="flex gap-1">
        <Card token={seat.holeCards[0]} />
        <Card token={seat.holeCards[1]} />
      </div>
      <span className="rounded-pill border-line border-ink bg-amber px-3 py-0.5 font-display text-[15px] text-candyink">
        {seat.chips}
      </span>
    </div>
  );
}

// The live poker table: two agents facing off, the board in the middle, the pot, and
// the acting agent's move with its 0G reasoning.
export function PokerTable({ snapshot }: { snapshot: WsPokerSnapshot }) {
  const s = snapshot;
  const last = s.lastAction;
  return (
    <StickerCard className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <span className="font-display text-lg text-ink">
          Hand {s.handIndex} · {s.street}
        </span>
        <Chip tone="won">pot {s.pot}</Chip>
      </div>

      <div className="grid grid-cols-1 items-center gap-5 sm:grid-cols-[1fr_auto_1fr]">
        {s.seats[0] && <Seat seat={s.seats[0]} />}
        <div className="flex flex-col items-center gap-2">
          <span className="font-body text-[11px] font-extrabold uppercase tracking-[0.03em] text-ink-3">board</span>
          <div className="flex gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <Card key={i} token={s.board[i]} hidden={!s.board[i]} />
            ))}
          </div>
        </div>
        {s.seats[1] && <Seat seat={s.seats[1]} />}
      </div>

      {last && (
        <div className="mt-5">
          <ThoughtBubble tone="cloud" tail="left">
            <span className="font-display text-[14px] text-ink">
              {last.name} {last.action}.
            </span>
            {last.reasoning && <span className="ml-1.5 font-body text-[13px] text-ink-2">{last.reasoning}</span>}
          </ThoughtBubble>
        </div>
      )}
    </StickerCard>
  );
}

// The x402 data payments (poker dossiers or World Cup intel), each verifiable on the
// 0G explorer.
export function X402Feed({ payments }: { payments: WsX402Payload[] }) {
  if (!payments.length) return null;
  return (
    <StickerCard className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-display text-[15px] text-ink">Paid data</span>
        <Chip tone="won">x402</Chip>
      </div>
      <ul className="space-y-2">
        {payments.map((p, i) => (
          <li
            key={`${p.txHash}-${i}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-chunk border-line border-ink/15 bg-cloud-2 px-3 py-2"
          >
            <span className="font-body text-[13px] text-ink-2">
              <span className="font-extrabold text-ink">{p.agentName}</span> paid{" "}
              <span className="font-extrabold text-ink">{p.priceUsdc} tUSDC</span>{" "}
              {p.opponentName
                ? `for a dossier on ${p.opponentName}`
                : p.label
                  ? `for ${p.label}`
                  : "for data"}
            </span>
            <ExplorerLink kind="tx" value={p.txHash} label="verify on 0G" />
          </li>
        ))}
      </ul>
    </StickerCard>
  );
}
