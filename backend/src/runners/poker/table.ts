import { type Card, evaluate7, cardLabel, handLabels } from "./cards.js";

// Heads-up No-Limit Hold'em betting state machine. Pure and synchronous: the
// runner drives the loop and supplies each decision (from 0G Compute), so this
// module has no chain, no network, no clock, and is fully testable offline.
//
// Seats are 0 and 1. The button posts the small blind, acts first preflop and last
// postflop (standard heads-up order). Stacks are chips behind; committed chips move
// into the pot. Heads-up means no side pots: at any resolve the matched pot is
// contested and any uncalled excess returns to whoever over-committed.

export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const START_STACK = 1000;

export type Seat = 0 | 1;

export type Action =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "raise"; to: number }; // target total street bet for the actor

export interface Table {
  stacks: [number, number]; // chips behind
  streetPut: [number, number]; // chips in this street from each seat
  handPut: [number, number]; // total chips in this hand from each seat
  acted: [boolean, boolean]; // has each seat acted this street
  button: Seat;
  holes: [[Card, Card], [Card, Card]];
  board: Card[];
  deck: Card[];
  deckPos: number;
  street: number; // 0 preflop, 1 flop, 2 turn, 3 river
  toAct: Seat;
  lastRaiseSize: number; // size of the last bet or raise, for the min-raise
  handOver: boolean;
  log: string[];
  result?: HandResult;
}

export interface HandResult {
  winner: Seat | null; // null on a split pot
  pot: number; // chips contested
  showdown: boolean;
  reason: string; // e.g. "seat 1 folded" or "a flush beats a straight"
}

export interface Legal {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

const other = (s: Seat): Seat => (s === 0 ? 1 : 0);

// Post the blinds, deal two cards to each seat, and set the button to act first.
export function startHand(stacks: [number, number], button: Seat, deck: Card[]): Table {
  const bb = other(button);
  const sbAmt = Math.min(SMALL_BLIND, stacks[button]);
  const bbAmt = Math.min(BIG_BLIND, stacks[bb]);
  const s: [number, number] = [...stacks];
  s[button] -= sbAmt;
  s[bb] -= bbAmt;
  const streetPut: [number, number] = [0, 0];
  streetPut[button] = sbAmt;
  streetPut[bb] = bbAmt;

  const holes: [[Card, Card], [Card, Card]] = [
    [deck[0]!, deck[1]!],
    [deck[2]!, deck[3]!],
  ];
  const t: Table = {
    stacks: s,
    streetPut,
    handPut: [streetPut[0], streetPut[1]],
    acted: [false, false],
    button,
    holes,
    board: [],
    deck,
    deckPos: 4,
    street: 0,
    toAct: button, // small blind acts first preflop
    lastRaiseSize: BIG_BLIND,
    handOver: false,
    log: [`blinds ${sbAmt}/${bbAmt}, seat ${button} on the button`],
  };
  return t;
}

const highBet = (t: Table): number => Math.max(t.streetPut[0], t.streetPut[1]);

export function legalActions(t: Table): Legal {
  const p = t.toAct;
  const opp = other(p);
  const toCall = highBet(t) - t.streetPut[p];
  const callAmount = Math.min(toCall, t.stacks[p]);
  const canCheck = toCall === 0;
  const canCall = toCall > 0 && t.stacks[p] > 0;
  // Can only raise with chips left beyond the call and an opponent able to respond.
  const canRaise = t.stacks[p] - toCall > 0 && t.stacks[opp] > 0;
  const minRaiseTo = highBet(t) + t.lastRaiseSize;
  const maxRaiseTo = t.streetPut[p] + t.stacks[p]; // all-in
  return { canFold: true, canCheck, canCall, callAmount, canRaise, minRaiseTo, maxRaiseTo };
}

// Apply one action, mutating the table. Advances the street or resolves the hand
// when the betting round closes. Illegal actions are coerced to the safest legal
// one (check if possible, else call, else fold) so a bad agent reply cannot wedge
// the game.
export function applyAction(t: Table, action: Action): void {
  if (t.handOver) return;
  const p = t.toAct;
  const opp = other(p);
  const legal = legalActions(t);
  let act = action;

  // Coerce anything illegal to a safe default.
  if (act.type === "check" && !legal.canCheck) act = legal.canCall ? { type: "call" } : { type: "fold" };
  if (act.type === "call" && !legal.canCall) act = legal.canCheck ? { type: "check" } : { type: "fold" };
  if (act.type === "raise" && !legal.canRaise) act = legal.canCall ? { type: "call" } : { type: "check" };

  if (act.type === "fold") {
    t.log.push(`seat ${p} folds`);
    resolveFold(t, opp);
    return;
  }
  if (act.type === "check") {
    t.acted[p] = true;
    t.log.push(`seat ${p} checks`);
  } else if (act.type === "call") {
    const amt = Math.min(highBet(t) - t.streetPut[p], t.stacks[p]);
    commit(t, p, amt);
    t.acted[p] = true;
    t.log.push(`seat ${p} calls ${amt}`);
  } else {
    // raise: clamp to a legal target, allowing an all-in for less than a full raise.
    let target = Math.round(act.to);
    target = Math.min(target, legal.maxRaiseTo);
    if (target < legal.minRaiseTo) target = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
    const before = highBet(t);
    const amt = target - t.streetPut[p];
    commit(t, p, amt);
    const increment = t.streetPut[p] - before;
    if (increment >= t.lastRaiseSize) t.lastRaiseSize = increment; // a full raise reopens action
    t.acted[p] = true;
    t.acted[opp] = false; // opponent must respond to the raise
    t.log.push(`seat ${p} raises to ${t.streetPut[p]}`);
  }

  advance(t, p);
}

function commit(t: Table, p: Seat, amt: number): void {
  const a = Math.max(0, Math.min(amt, t.stacks[p]));
  t.stacks[p] -= a;
  t.streetPut[p] += a;
  t.handPut[p] += a;
}

// Decide whether the opponent still owes an action; otherwise close the round.
function advance(t: Table, lastActor: Seat): void {
  const opp = other(lastActor);
  const facingBet = t.streetPut[opp] < t.streetPut[lastActor];
  const owesAction = facingBet || !t.acted[opp];
  if (owesAction && t.stacks[opp] > 0) {
    t.toAct = opp;
    return;
  }
  closeStreet(t);
}

function closeStreet(t: Table): void {
  const allIn = t.stacks[0] === 0 || t.stacks[1] === 0;
  if (t.street >= 3 || allIn) {
    // No more betting: run out any remaining board and go to showdown.
    while (t.board.length < 5) dealBoard(t);
    showdown(t);
    return;
  }
  dealBoard(t);
  t.street += 1;
  t.streetPut = [0, 0];
  t.acted = [false, false];
  t.lastRaiseSize = BIG_BLIND;
  t.toAct = other(t.button); // postflop the non-button acts first
  t.log.push(`street ${t.street}: board ${handLabels(t.board)}`);
}

function dealBoard(t: Table): void {
  const need = t.board.length === 0 ? 3 : 1; // flop is three cards, turn and river one
  for (let i = 0; i < need; i++) t.board.push(t.deck[t.deckPos++]!);
}

function resolveFold(t: Table, winner: Seat): void {
  const pot = t.handPut[0] + t.handPut[1];
  t.stacks[winner] += pot;
  t.handOver = true;
  t.result = { winner, pot, showdown: false, reason: `seat ${other(winner)} folded` };
  t.log.push(`seat ${winner} wins ${pot} (fold)`);
}

function showdown(t: Table): void {
  // Return any uncalled excess, then contest the matched pot.
  const matched = 2 * Math.min(t.handPut[0], t.handPut[1]);
  const excess0 = t.handPut[0] - matched / 2;
  const excess1 = t.handPut[1] - matched / 2;
  if (excess0 > 0) t.stacks[0] += excess0;
  if (excess1 > 0) t.stacks[1] += excess1;

  const s0 = evaluate7([...t.holes[0], ...t.board]);
  const s1 = evaluate7([...t.holes[1], ...t.board]);
  const shown = `seat 0 ${handLabels(t.holes[0])} vs seat 1 ${handLabels(t.holes[1])} on ${handLabels(t.board)}`;
  t.handOver = true;
  if (s0 > s1) {
    t.stacks[0] += matched;
    t.result = { winner: 0, pot: matched, showdown: true, reason: "seat 0 wins the showdown" };
  } else if (s1 > s0) {
    t.stacks[1] += matched;
    t.result = { winner: 1, pot: matched, showdown: true, reason: "seat 1 wins the showdown" };
  } else {
    t.stacks[0] += matched / 2;
    t.stacks[1] += matched / 2;
    t.result = { winner: null, pot: matched, showdown: true, reason: "split pot" };
  }
  t.log.push(`showdown: ${shown} -> ${t.result.reason}`);
}

// What the seat to act sees, for building its decision prompt.
export interface PlayerView {
  seat: Seat;
  holeCards: string; // e.g. "As Kd"
  board: string; // e.g. "Th 7c 2s" or "" preflop
  street: string; // "preflop" | "flop" | "turn" | "river"
  myStack: number;
  oppStack: number;
  pot: number;
  toCall: number;
  legal: Legal;
  history: string[]; // action log so far this hand
}

const STREET_NAMES = ["preflop", "flop", "turn", "river"];

export function viewFor(t: Table): PlayerView {
  const p = t.toAct;
  return {
    seat: p,
    holeCards: t.holes[p].map(cardLabel).join(" "),
    board: handLabels(t.board),
    street: STREET_NAMES[t.street] ?? "preflop",
    myStack: t.stacks[p],
    oppStack: t.stacks[other(p)],
    pot: t.handPut[0] + t.handPut[1],
    toCall: highBet(t) - t.streetPut[p],
    legal: legalActions(t),
    history: t.log,
  };
}
