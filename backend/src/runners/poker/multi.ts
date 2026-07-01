import { type Card, evaluate7, cardLabel, handLabels } from "./cards.js";
import type { Action, Legal, Seat } from "./table.js";
import { SMALL_BLIND, BIG_BLIND } from "./table.js";

// Multi-player (up to 6-max) No-Limit Hold'em with correct side pots. Pure and
// synchronous like the heads-up engine; the runner drives the loop and supplies
// each decision. Kept separate from the heads-up engine so the proven 1v1 path is
// untouched. Seats are 0..n-1. A folded player forfeits; an all-in player is in for
// what they committed. At showdown the pot is split into layers by commitment level
// so a short all-in can only win the chips it covered.

export interface MultiTable {
  n: number;
  stacks: number[]; // chips behind per seat
  committed: number[]; // total chips in this hand per seat (drives side pots)
  streetBet: number[]; // chips in this street per seat
  folded: boolean[];
  allIn: boolean[];
  acted: boolean[]; // acted this street
  holes: [Card, Card][];
  board: Card[];
  deck: Card[];
  deckPos: number;
  button: number;
  toAct: number;
  street: number; // 0 preflop, 1 flop, 2 turn, 3 river
  lastRaiseSize: number;
  handOver: boolean;
  log: string[];
  pots?: PotResult[]; // set at resolution
}

export interface PotResult {
  amount: number;
  eligible: number[]; // seats that could win this pot
  winners: number[]; // seats awarded a share
}

const highBet = (t: MultiTable): number => Math.max(0, ...t.streetBet);
const roundActive = (t: MultiTable, s: number): boolean => !t.folded[s] && !t.allIn[s];
const inHand = (t: MultiTable, s: number): boolean => !t.folded[s];

// Next seat after `from` (exclusive) that can still act, or -1 if none.
function nextActive(t: MultiTable, from: number): number {
  for (let i = 1; i <= t.n; i++) {
    const s = (from + i) % t.n;
    if (roundActive(t, s)) return s;
  }
  return -1;
}

export function startHand(stacks: number[], button: number, deck: Card[]): MultiTable {
  const n = stacks.length;
  const t: MultiTable = {
    n,
    stacks: [...stacks],
    committed: new Array(n).fill(0),
    streetBet: new Array(n).fill(0),
    folded: new Array(n).fill(false),
    allIn: new Array(n).fill(false),
    acted: new Array(n).fill(false),
    holes: [],
    board: [],
    deck,
    deckPos: 0,
    button,
    toAct: 0,
    street: 0,
    lastRaiseSize: BIG_BLIND,
    handOver: false,
    log: [],
  };
  // Any seat that starts with no chips sits the hand out (already all-in / busted).
  for (let s = 0; s < n; s++) if (t.stacks[s]! <= 0) t.folded[s] = true;

  // Deal two cards per live seat.
  for (let s = 0; s < n; s++) t.holes[s] = [deck[t.deckPos++]!, deck[t.deckPos++]!];

  // Blinds. Heads-up: the button posts the small blind. Otherwise SB is left of the
  // button, BB two left.
  const sbSeat = n === 2 ? button : (button + 1) % n;
  const bbSeat = n === 2 ? (button + 1) % n : (button + 2) % n;
  postBlind(t, sbSeat, SMALL_BLIND);
  postBlind(t, bbSeat, BIG_BLIND);
  t.log.push(`blinds ${SMALL_BLIND}/${BIG_BLIND}, button seat ${button}`);

  // First to act: heads-up the button, otherwise the seat left of the big blind.
  t.toAct = n === 2 ? nextActiveOrSelf(t, button) : nextActive(t, bbSeat);
  return t;
}

function nextActiveOrSelf(t: MultiTable, s: number): number {
  return roundActive(t, s) ? s : nextActive(t, s);
}

function postBlind(t: MultiTable, seat: number, amount: number): void {
  const a = Math.min(amount, t.stacks[seat]!);
  t.stacks[seat]! -= a;
  t.streetBet[seat]! += a;
  t.committed[seat]! += a;
  if (t.stacks[seat] === 0) t.allIn[seat] = true;
}

export function legalActions(t: MultiTable): Legal {
  const p = t.toAct;
  const toCall = highBet(t) - t.streetBet[p]!;
  const callAmount = Math.min(toCall, t.stacks[p]!);
  const canCheck = toCall === 0;
  const canCall = toCall > 0 && t.stacks[p]! > 0;
  // Someone else must still be able to act for a raise to mean anything.
  const othersLive = t.stacks.some((st, i) => i !== p && roundActive(t, i) && st > 0);
  const canRaise = t.stacks[p]! - toCall > 0 && othersLive;
  const minRaiseTo = highBet(t) + t.lastRaiseSize;
  const maxRaiseTo = t.streetBet[p]! + t.stacks[p]!;
  return { canFold: true, canCheck, canCall, callAmount, canRaise, minRaiseTo, maxRaiseTo };
}

export function applyAction(t: MultiTable, action: Action): void {
  if (t.handOver) return;
  const p = t.toAct;
  const legal = legalActions(t);
  let act = action;
  if (act.type === "check" && !legal.canCheck) act = legal.canCall ? { type: "call" } : { type: "fold" };
  if (act.type === "call" && !legal.canCall) act = legal.canCheck ? { type: "check" } : { type: "fold" };
  if (act.type === "raise" && !legal.canRaise) act = legal.canCall ? { type: "call" } : { type: "check" };

  if (act.type === "fold") {
    t.folded[p] = true;
    t.acted[p] = true;
    t.log.push(`seat ${p} folds`);
  } else if (act.type === "check") {
    t.acted[p] = true;
    t.log.push(`seat ${p} checks`);
  } else if (act.type === "call") {
    commit(t, p, highBet(t) - t.streetBet[p]!);
    t.acted[p] = true;
    t.log.push(`seat ${p} calls`);
  } else {
    let target = Math.min(Math.round(act.to), legal.maxRaiseTo);
    if (target < legal.minRaiseTo) target = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
    const before = highBet(t);
    commit(t, p, target - t.streetBet[p]!);
    const increment = t.streetBet[p]! - before;
    if (increment >= t.lastRaiseSize) {
      t.lastRaiseSize = increment;
      // A full raise reopens the action for everyone still live.
      for (let s = 0; s < t.n; s++) if (s !== p && roundActive(t, s)) t.acted[s] = false;
    }
    t.acted[p] = true;
    t.log.push(`seat ${p} raises to ${t.streetBet[p]}`);
  }

  advance(t);
}

function commit(t: MultiTable, p: number, amt: number): void {
  const a = Math.max(0, Math.min(amt, t.stacks[p]!));
  t.stacks[p]! -= a;
  t.streetBet[p]! += a;
  t.committed[p]! += a;
  if (t.stacks[p] === 0) t.allIn[p] = true;
}

function advance(t: MultiTable): void {
  // Only one player left in the hand: they win, no showdown.
  if (t.folded.filter((f) => !f).length === 1) {
    resolve(t);
    return;
  }
  // Is the betting round closed? Every round-active player has acted and matched.
  const hb = highBet(t);
  let owe = -1;
  for (let i = 1; i <= t.n; i++) {
    const s = (t.toAct + i) % t.n;
    if (roundActive(t, s) && (!t.acted[s] || t.streetBet[s]! < hb)) {
      owe = s;
      break;
    }
  }
  if (owe !== -1) {
    t.toAct = owe;
    return;
  }
  closeStreet(t);
}

function closeStreet(t: MultiTable): void {
  // If at most one player can still act, run the board out with no more betting.
  const canAct = t.stacks.filter((_, s) => roundActive(t, s)).length;
  if (t.street >= 3 || canAct <= 1) {
    while (t.board.length < 5) dealBoard(t);
    resolve(t);
    return;
  }
  dealBoard(t);
  t.street += 1;
  t.streetBet = new Array(t.n).fill(0);
  t.acted = new Array(t.n).fill(false);
  t.lastRaiseSize = BIG_BLIND;
  t.toAct = nextActive(t, t.button); // first active seat left of the button
  t.log.push(`street ${t.street}: board ${handLabels(t.board)}`);
}

function dealBoard(t: MultiTable): void {
  const need = t.board.length === 0 ? 3 : 1;
  for (let i = 0; i < need; i++) t.board.push(t.deck[t.deckPos++]!);
}

// Split the committed chips into pots by commitment level and award each to the best
// eligible hand. Folded players' chips stay in the pots but cannot win.
function resolve(t: MultiTable): void {
  const contrib = [...t.committed];
  const pots: PotResult[] = [];
  for (;;) {
    const positives = contrib.filter((c) => c > 0);
    if (positives.length === 0) break;
    const level = Math.min(...positives);
    let amount = 0;
    const eligible: number[] = [];
    for (let s = 0; s < t.n; s++) {
      if (contrib[s]! > 0) {
        amount += level;
        contrib[s]! -= level;
        if (inHand(t, s)) eligible.push(s);
      }
    }
    if (amount > 0) pots.push({ amount, eligible, winners: [] });
  }

  // Score every player still in the hand once.
  const score = new Map<number, number>();
  for (let s = 0; s < t.n; s++) if (inHand(t, s)) score.set(s, evaluate7([...t.holes[s]!, ...t.board]));

  for (const pot of pots) {
    if (pot.eligible.length === 0) continue;
    let best = -1;
    for (const s of pot.eligible) best = Math.max(best, score.get(s) ?? -1);
    const winners = pot.eligible.filter((s) => (score.get(s) ?? -1) === best);
    pot.winners = winners;
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    // Award the odd chip to the first winner left of the button, deterministically.
    const ordered = [...winners].sort((a, b) => ((a - t.button + t.n) % t.n) - ((b - t.button + t.n) % t.n));
    for (const s of ordered) {
      t.stacks[s]! += share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
  }

  t.pots = pots;
  t.handOver = true;
  const shown = pots
    .map((p) => `pot ${p.amount} -> ${p.winners.map((w) => `seat ${w}`).join(", ")}`)
    .join("; ");
  t.log.push(`showdown: ${shown}`);
}

export interface MultiView {
  seat: number;
  holeCards: string;
  board: string;
  street: string;
  myStack: number;
  pot: number;
  toCall: number;
  activePlayers: number;
  legal: Legal;
  history: string[];
}

const STREET_NAMES = ["preflop", "flop", "turn", "river"];

export function viewFor(t: MultiTable): MultiView {
  const p = t.toAct;
  return {
    seat: p,
    holeCards: t.holes[p]!.map(cardLabel).join(" "),
    board: handLabels(t.board),
    street: STREET_NAMES[t.street] ?? "preflop",
    myStack: t.stacks[p]!,
    pot: t.committed.reduce((a, b) => a + b, 0),
    toCall: highBet(t) - t.streetBet[p]!,
    activePlayers: t.folded.filter((f) => !f).length,
    legal: legalActions(t),
    history: t.log,
  };
}

// Seats still in the hand, for the runner to know who is live.
export function liveSeats(t: MultiTable): Seat[] {
  const out: Seat[] = [];
  for (let s = 0; s < t.n; s++) if (!t.folded[s]) out.push(s as Seat);
  return out;
}
