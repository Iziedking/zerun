"use client";

import { useEffect, useRef, useState } from "react";
import type { WsPokerSnapshot, WsX402Payload } from "@/lib/types";
import { agentVariant, Chip, Pager, SkinnedAgent, StickerCard, ThoughtBubble, cx } from "./zerun";
import { ExplorerLink } from "./ExplorerLink";

const RED = new Set(["h", "d"]);
const SUIT: Record<string, string> = { h: "♥", d: "♦", c: "♣", s: "♠" };

function Card({ token, hidden, small }: { token?: string; hidden?: boolean; small?: boolean }) {
  const size = small ? "h-8 w-6" : "h-10 w-8";
  if (hidden || !token) {
    return (
      <span
        className={cx("inline-block rounded-md border-2 border-ink bg-violet/70 shadow-[2px_2px_0_#171449]", size)}
        aria-hidden
      />
    );
  }
  const rank = token.slice(0, -1).replace("T", "10");
  const suit = token.slice(-1);
  return (
    <span
      className={cx(
        "inline-flex flex-col items-center justify-center rounded-md border-2 border-ink bg-white font-body font-extrabold shadow-[2px_2px_0_#171449]",
        size,
        RED.has(suit) ? "text-coral" : "text-ink",
      )}
    >
      <span className={cx("leading-none", small ? "text-[11px]" : "text-[13px]")}>{rank}</span>
      <span className={cx("leading-none", small ? "text-[9px]" : "text-[11px]")}>{SUIT[suit] ?? ""}</span>
    </span>
  );
}

// An agent's latest move as a chunky tag, so every player's action shows right on the
// felt (not just the one acting). Colour reads the move: raise hot, call cool, check
// go, fold muted.
function ActionTag({ action }: { action?: string }) {
  if (!action) return null;
  const tone = /fold/.test(action)
    ? "bg-cloud-2 text-ink-3"
    : /rais|bet|all[- ]?in/.test(action)
      ? "bg-coral text-white"
      : /call/.test(action)
        ? "bg-cyan text-candyink"
        : "bg-mint text-candyink";
  return (
    <span
      className={cx(
        "whitespace-nowrap rounded-pill border-2 border-ink px-2 py-0.5 font-display text-[11px] leading-none shadow-[2px_2px_0_#171449]",
        tone,
      )}
    >
      {action}
    </span>
  );
}

// The chips a seat has pushed out on the current street, sitting between the player and the
// pot the way they would on a real table. Without this the pot grew and nobody could see who
// was paying for it: the number existed in the engine and never reached the felt.
function BetToken({ amount }: { amount: number }) {
  if (!amount) return null;
  return (
    <span className="flex items-center gap-1 whitespace-nowrap rounded-pill border-2 border-ink bg-cloud px-1.5 py-0.5 font-display text-[11px] leading-none text-ink shadow-[2px_2px_0_#171449]">
      <span className="h-2 w-2 rounded-full border border-ink bg-amber" aria-hidden />
      {amount.toLocaleString()}
    </span>
  );
}

// A seat's own money: what is still behind them. A coin leads it so it reads as chips rather
// than as a score badge.
function Stack({ chips, small }: { chips: number; small?: boolean }) {
  return (
    <span
      className={cx(
        "flex items-center gap-1 rounded-pill border-line border-ink bg-amber px-2 py-0.5 font-display text-candyink",
        small ? "text-[12px]" : "text-[13px]",
      )}
    >
      <span className="h-2.5 w-2.5 rounded-full border border-ink bg-cloud" aria-hidden />
      {chips.toLocaleString()}
    </span>
  );
}

function Seat({
  seat,
  action,
  size = 76,
  small = false,
}: {
  seat: WsPokerSnapshot["seats"][number];
  action?: string;
  size?: number;
  small?: boolean;
}) {
  return (
    <div className={cx("flex flex-col items-center gap-1.5", seat.folded && "opacity-50")}>
      <div className="relative">
        <SkinnedAgent
          agentId={seat.agentId}
          variant={agentVariant(seat.agentId)}
          mood={seat.folded ? "lose" : seat.isTurn ? "thinking" : "idle"}
          size={size}
          name={seat.name}
        />
        {seat.isTurn && (
          <span
            className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 animate-pulse rounded-full border-2 border-ink bg-mint"
            aria-hidden
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1">
        <span className={cx("font-display text-ink", small ? "text-[13px]" : "text-[15px]")}>{seat.name}</span>
        <span className="rounded-pill border border-ink/25 bg-cloud-2 px-1.5 font-mono text-[9px] font-bold uppercase text-ink-3">
          {seat.position}
        </span>
        {seat.isHouse && <Chip tone="neutral">house</Chip>}
      </div>

      {/* A folded seat drops its cards entirely rather than dimming them. Six dimmed hands all
          compete for the eye with the two that are still live; an empty slot does not. */}
      {seat.folded ? (
        <span className="py-1 font-body text-[12px] font-extrabold italic text-ink-3">folded</span>
      ) : (
        <div className="flex gap-1">
          <Card token={seat.holeCards[0]} small={small} />
          <Card token={seat.holeCards[1]} small={small} />
        </div>
      )}

      <Stack chips={seat.chips} small={small} />
      <div className="min-h-[20px]">
        <ActionTag action={action} />
      </div>
    </div>
  );
}

// The felt centre: the community board and the pot, the shared focus of the table.
function Felt({ board, pot, hand, street }: { board: string[]; pot: number; hand: number; street: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-chunk-lg border-line border-ink/20 bg-mint/10 px-5 py-3">
      <div className="flex gap-1.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i} token={board[i]} hidden={!board[i]} />
        ))}
      </div>
      {/* The pot, the street and the hand as ONE object. They used to be scattered across the
          card header and the felt, so the number that matters appeared twice, in two styles. */}
      <span className="flex items-center gap-2 rounded-pill border-line border-ink bg-ink px-3 py-1 shadow-pop-press">
        <span className="h-3 w-3 rounded-full border-2 border-cloud bg-amber" aria-hidden />
        <span className="font-display text-[16px] leading-none text-cloud">{pot.toLocaleString()}</span>
        <span className="font-body text-[10px] font-extrabold uppercase tracking-[0.06em] text-cloud/60">
          {street} · hand {hand}
        </span>
      </span>
    </div>
  );
}

// A true round table for a 3-to-6-max field: seats sit evenly around an oval felt,
// each showing its cards, chips, and latest move, so the whole table reads at a glance.
function RoundTable({
  seats,
  actions,
  board,
  pot,
  hand,
  street,
}: {
  seats: WsPokerSnapshot["seats"];
  actions: Record<number, string>;
  board: string[];
  pot: number;
  hand: number;
  street: string;
}) {
  const n = seats.length;
  return (
    <div className="relative mx-auto aspect-[3/2] w-full max-w-2xl sm:aspect-[16/9]">
      {/* The oval felt the seats sit around. */}
      <div className="absolute inset-[15%] rounded-[50%] border-line border-ink/20 bg-mint/[0.07]" aria-hidden />
      {/* The board and pot at the centre of the felt. */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <Felt board={board} pot={pot} hand={hand} street={street} />
      </div>
      {seats.map((seat, i) => {
        // Evenly spaced around the ellipse, first seat at the top.
        const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
        const x = 50 + 43 * Math.cos(angle);
        const y = 50 + 41 * Math.sin(angle);
        return (
          <div
            key={seat.agentId}
            className="absolute w-[76px] -translate-x-1/2 -translate-y-1/2 sm:w-24"
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            <Seat seat={seat} action={actions[seat.agentId]} size={52} small />
          </div>
        );
      })}

      {/* Each seat's live bet, parked on the felt between that seat and the pot: same angle,
          shorter radius. The pot in the middle is the sum of these plus what earlier streets
          already swept in, so the felt now shows where the money came from, not just how much. */}
      {seats.map((seat, i) => {
        if (!seat.bet) return null;
        const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
        const x = 50 + 26 * Math.cos(angle);
        const y = 50 + 25 * Math.sin(angle);
        return (
          <div
            key={`bet-${seat.agentId}`}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            <BetToken amount={seat.bet} />
          </div>
        );
      })}
    </div>
  );
}

// Heads-up reads best as a simple face-off: the two agents above and below the board.
function HeadsUp({
  seats,
  actions,
  board,
  pot,
  hand,
  street,
}: {
  seats: WsPokerSnapshot["seats"];
  actions: Record<number, string>;
  board: string[];
  pot: number;
  hand: number;
  street: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      {seats[0] && <Seat seat={seats[0]} action={actions[seats[0].agentId]} />}
      {/* The two bets face each other across the board, exactly as they sit on a real table. */}
      <div className="flex h-6 items-center">{seats[0] && <BetToken amount={seats[0].bet} />}</div>
      <Felt board={board} pot={pot} hand={hand} street={street} />
      <div className="flex h-6 items-center">{seats[1] && <BetToken amount={seats[1].bet} />}</div>
      {seats[1] && <Seat seat={seats[1]} action={actions[seats[1].agentId]} />}
    </div>
  );
}

// The live poker table: the agents around the felt (heads-up or up to 6-max), the board
// and pot at the centre, every seat's latest move on the table, and the acting agent's
// 0G reasoning below. Each player's move is remembered for the current hand, so the
// table shows what everyone did, not only the seat on the clock.
export function PokerTable({ snapshot }: { snapshot: WsPokerSnapshot }) {
  const s = snapshot;
  const [actions, setActions] = useState<Record<number, string>>({});
  const handRef = useRef<number>(-1);

  useEffect(() => {
    const la = s.lastAction;
    // A new hand wipes the table and seeds it with the first move; within a hand each
    // move is folded in, keyed by agent, so every seat shows its most recent action.
    if (s.handIndex !== handRef.current) {
      handRef.current = s.handIndex;
      setActions(la ? { [la.agentId]: la.action } : {});
      return;
    }
    if (la) setActions((prev) => ({ ...prev, [la.agentId]: la.action }));
  }, [s]);

  const last = s.lastAction;
  // What the player on the clock owes. The one number a spectator needs to judge the decision
  // they are about to watch, and it was nowhere on the table before.
  const toCallNow = s.seats.find((x) => x.isTurn)?.toCall ?? 0;
  return (
    <StickerCard className="p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <span className="font-display text-lg text-ink">Table</span>
        <div className="flex items-center gap-2">
          {s.seats.length > 2 && <Chip tone="neutral">{s.seats.length}-max</Chip>}
          {/* The pot and the street live on the felt now. Repeating them here made the reader
              check two places for one number. */}
          {toCallNow > 0 && <Chip tone="won">to call {toCallNow.toLocaleString()}</Chip>}
        </div>
      </div>

      {s.seats.length > 2 ? (
        <RoundTable seats={s.seats} actions={actions} board={s.board} pot={s.pot} hand={s.handIndex} street={s.street} />
      ) : (
        <HeadsUp seats={s.seats} actions={actions} board={s.board} pot={s.pot} hand={s.handIndex} street={s.street} />
      )}

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
// A World Cup contest buys intel on every market, twice over, so this list runs to dozens of
// rows and pushed the rest of the page off the screen. Six at a time, newest first.
const X402_PER_PAGE = 6;

export function X402Feed({ payments }: { payments: WsX402Payload[] }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(payments.length / X402_PER_PAGE));

  // This is a LIVE feed: new payments arrive at the head while somebody is reading page three.
  // Snap back to the first page when that happens, rather than leaving them staring at rows
  // that have quietly shifted under them. Page one is where the new row is anyway.
  const seen = useRef(payments.length);
  useEffect(() => {
    if (payments.length > seen.current) setPage(0);
    seen.current = payments.length;
  }, [payments.length]);

  if (!payments.length) return null;
  const start = Math.min(page, totalPages - 1) * X402_PER_PAGE;
  const rows = payments.slice(start, start + X402_PER_PAGE);

  return (
    <StickerCard className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-display text-[15px] text-ink">Paid data</span>
        <Chip tone="won">x402</Chip>
      </div>
      <ul className="space-y-2">
        {rows.map((p, i) => (
          <li
            key={`${p.txHash}-${start + i}`}
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
      <Pager
        page={Math.min(page, totalPages - 1)}
        total={totalPages}
        onGo={(d) => setPage((x) => Math.min(totalPages - 1, Math.max(0, x + d)))}
        noun="payment"
        count={payments.length}
      />
    </StickerCard>
  );
}
