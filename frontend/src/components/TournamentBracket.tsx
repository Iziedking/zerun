"use client";

import type { WsBracketSnapshot, WsBracketSeat, WsBracketMatch } from "@/lib/types";
import { agentVariant, Chip, SkinnedAgent, StickerCard, cx } from "./zerun";

// The live chess tournament view: a single-elimination bracket rendered as rounds of
// match cards, with the current match pulsing, winners promoted, and the champion and
// final placements called out at the end. While the room is still filling it shows the
// lobby — the seats taken so far and how many are needed to auto-start. Mirrors the
// poker table's live cartoon feel; the live board for the current match renders below it.

function roundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - 1 - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semis";
  if (fromEnd === 2) return "Quarters";
  return `Round ${round + 1}`;
}

const ORDINAL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 5: "5th" };

function SeatRow({
  seat,
  agentId,
  isWinner,
  decided,
  live,
}: {
  seat: WsBracketSeat | undefined;
  agentId: number | null;
  isWinner: boolean;
  decided: boolean;
  live: boolean;
}) {
  const name = seat?.agentName ?? (agentId == null ? "TBD" : `Agent #${agentId}`);
  // Once the match is decided, dim the side that lost; the winner stays bright.
  const dimmed = decided && !isWinner && agentId != null;
  return (
    <div
      className={cx(
        "flex items-center gap-2 rounded-chunk px-2 py-1.5 transition",
        isWinner && decided ? "bg-mint/25" : "bg-cloud-2",
        dimmed && "opacity-45",
      )}
    >
      {agentId != null ? (
        <SkinnedAgent
          agentId={agentId}
          variant={agentVariant(agentId)}
          mood={live ? "thinking" : isWinner && decided ? "happy" : "idle"}
          size={22}
          name={name}
        />
      ) : (
        <span className="grid h-[22px] w-[22px] place-items-center rounded-chunk border-line border-ink/30 bg-cloud text-ink-3">
          ?
        </span>
      )}
      <span className={cx("min-w-0 flex-1 truncate font-display text-[13px]", isWinner && decided ? "text-ink" : "text-ink-2")}>
        {name}
      </span>
      {seat && <span className="shrink-0 font-mono text-[10px] text-ink-3">#{seat.seed}</span>}
      {isWinner && decided && <span className="shrink-0 text-[12px]" aria-hidden>👑</span>}
    </div>
  );
}

function MatchCard({
  match,
  seatOf,
}: {
  match: WsBracketMatch;
  seatOf: Map<number, WsBracketSeat>;
}) {
  const decided = match.winner != null;
  return (
    <div
      className={cx(
        "w-[184px] shrink-0 rounded-chunk border-line border-ink bg-cloud p-1.5 shadow-pop",
        match.live && "ring-2 ring-amber shadow-pop-press",
      )}
    >
      <div className="space-y-1">
        <SeatRow
          seat={match.a != null ? seatOf.get(match.a) : undefined}
          agentId={match.a}
          isWinner={match.winner === match.a}
          decided={decided}
          live={match.live}
        />
        <SeatRow
          seat={match.b != null ? seatOf.get(match.b) : undefined}
          agentId={match.b}
          isWinner={match.winner === match.b}
          decided={decided}
          live={match.live}
        />
      </div>
      {match.live && (
        <div className="mt-1 text-center">
          <Chip tone="won" pulse>
            playing
          </Chip>
        </div>
      )}
    </div>
  );
}

function Lobby({ snapshot, isChallenge = false }: { snapshot: WsBracketSnapshot; isChallenge?: boolean }) {
  const slots = Array.from({ length: snapshot.capacity }, (_, i) => snapshot.seats[i] ?? null);
  const need = Math.max(0, snapshot.capacity - snapshot.filled);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-display text-lg text-ink">Tournament lobby</h3>
          <Chip tone="thinking" pulse>
            {snapshot.filled}/{snapshot.capacity} seats
          </Chip>
        </div>
        <span className="font-body text-[13px] font-extrabold text-ink-2">
          {need === 0 ? "Bracket full, starting…" : `Auto-starts the moment all ${snapshot.capacity} seats fill`}
        </span>
      </div>

      {/* What happens if the room never fills. The two rules differ, and getting this wrong
          costs an operator a cancelled contest: the house fills a funded contest at the
          deadline, but it cannot pay an entry fee, so it never fills a challenge. */}
      {need > 0 && (
        <p className="mt-2 font-body text-[13px] leading-relaxed text-ink-2">
          {isChallenge ? (
            <>
              This is an entry-fee challenge, so the pot is the entrants&apos; fees and{" "}
              <strong className="text-ink">house agents never join</strong>, since they cannot pay in.
              At the deadline it plays with whoever turned up: two entrants play a duel, three or
              more play a bracket. With only one entrant it cancels and every fee is refunded.
            </>
          ) : (
            <>
              If seats are still empty at the deadline, house agents take them and the tournament
              starts anyway. A house agent can win the bracket, but the pot always goes to the best
              real player.
            </>
          )}
        </p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {slots.map((seat, i) => (
          <div
            key={i}
            className={cx(
              "flex items-center gap-2 rounded-chunk border-line px-2 py-2",
              seat ? "border-ink bg-cloud-2 shadow-pop-press" : "border-dashed border-ink/30 bg-cloud",
            )}
          >
            {seat ? (
              <>
                <SkinnedAgent agentId={seat.agentId} variant={agentVariant(seat.agentId)} size={26} name={seat.agentName} />
                <span className="min-w-0 flex-1 truncate font-display text-[13px] text-ink">{seat.agentName}</span>
              </>
            ) : (
              <span className="w-full py-1 text-center font-body text-[12px] font-extrabold uppercase tracking-[0.04em] text-ink-3">
                open seat
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TournamentBracket({
  snapshot,
  isChallenge = false,
}: {
  snapshot: WsBracketSnapshot;
  /** An entry-fee challenge: the house cannot join, so the lobby fills or it does not. */
  isChallenge?: boolean;
}) {
  const seatOf = new Map(snapshot.seats.map((s) => [s.agentId, s]));

  if (snapshot.status === "lobby") {
    return (
      <StickerCard className="p-4 sm:p-5">
        <Lobby snapshot={snapshot} isChallenge={isChallenge} />
      </StickerCard>
    );
  }

  const totalRounds = snapshot.rounds.length;
  const champSeat = snapshot.champion != null ? seatOf.get(snapshot.champion) : undefined;
  const complete = snapshot.status === "complete";
  const podium = complete
    ? snapshot.placements
        .filter((p) => p.place <= 3)
        .sort((a, b) => a.place - b.place)
    : [];

  return (
    <StickerCard className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-display text-lg text-ink">Knockout bracket</h3>
          <Chip tone={complete ? "won" : "live"} pulse={!complete}>
            {complete ? "complete" : "playing"}
          </Chip>
        </div>
        {snapshot.currentMatch && !complete && (
          <span className="min-w-0 truncate font-body text-[13px] font-extrabold text-ink-2">
            {snapshot.currentMatch.label}
          </span>
        )}
        {complete && champSeat && (
          <span className="font-body text-[13px] font-extrabold text-ink">
            👑 {champSeat.agentName} takes the crown
          </span>
        )}
      </div>

      {/* Rounds, left (first round) to right (final), scrolling sideways on narrow screens. */}
      <div className="mt-4 overflow-x-auto pb-1">
        <div className="flex items-stretch gap-4">
          {snapshot.rounds.map((round, r) => (
            <div key={r} className="flex flex-col justify-around gap-3">
              <div className="text-center font-body text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink-3">
                {roundName(r, totalRounds)}
              </div>
              {round.map((m) => (
                <MatchCard key={`${m.round}-${m.index}`} match={m} seatOf={seatOf} />
              ))}
            </div>
          ))}

          {/* Champion column at the tail. */}
          <div className="flex flex-col justify-center gap-3">
            <div className="text-center font-body text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink-3">
              Champion
            </div>
            <div
              className={cx(
                "grid w-[184px] shrink-0 place-items-center gap-1 rounded-chunk border-line border-ink p-3 shadow-pop",
                champSeat ? "bg-amber/30" : "bg-cloud",
              )}
            >
              {champSeat ? (
                <>
                  <SkinnedAgent
                    agentId={champSeat.agentId}
                    variant={agentVariant(champSeat.agentId)}
                    mood="happy"
                    size={44}
                    name={champSeat.agentName}
                  />
                  <span className="text-center font-display text-[14px] text-ink">{champSeat.agentName}</span>
                  <span className="text-[16px]" aria-hidden>👑</span>
                </>
              ) : (
                <span className="py-6 text-center font-body text-[12px] font-extrabold uppercase tracking-[0.04em] text-ink-3">
                  TBD
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Final placements once the bracket is done. */}
      {podium.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 border-t-line border-ink/15 pt-4">
          {podium.map((p) => {
            const seat = seatOf.get(p.agentId);
            return (
              <div
                key={p.agentId}
                className="flex items-center gap-2 rounded-chunk border-line border-ink bg-cloud-2 px-3 py-1.5 shadow-pop-press"
              >
                <span className="font-display text-[13px] text-ink">{ORDINAL[p.place] ?? `${p.place}th`}</span>
                {seat && (
                  <>
                    <SkinnedAgent agentId={seat.agentId} variant={agentVariant(seat.agentId)} size={20} name={seat.agentName} />
                    <span className="font-body text-[13px] font-extrabold text-ink">{seat.agentName}</span>
                  </>
                )}
                {seat?.isHouse && <Chip tone="neutral">house</Chip>}
              </div>
            );
          })}
        </div>
      )}
    </StickerCard>
  );
}
