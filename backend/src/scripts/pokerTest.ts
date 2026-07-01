import { evaluate7, categoryName, shuffle } from "../runners/poker/cards.js";
import {
  startHand,
  applyAction,
  viewFor,
  START_STACK,
  type Table,
  type Action,
  type PlayerView,
  type Seat,
} from "../runners/poker/table.js";
import { parseAction } from "../runners/poker/decide.js";
import {
  startHand as startMulti,
  applyAction as applyMulti,
  viewFor as viewMulti,
  type MultiTable,
  type MultiView,
} from "../runners/poker/multi.js";

// Offline checks for the poker hand evaluator and the seeded shuffle. No chain,
// no network. Run with: npx tsx src/scripts/pokerTest.ts

const C = (r: number, s: number) => r * 4 + s; // rank 0..12 for 2..A, suit 0..3
const A = 12,
  K = 11,
  Q = 10,
  J = 9,
  T = 8;

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

const sf = evaluate7([C(A, 3), C(K, 3), C(Q, 3), C(J, 3), C(T, 3), C(0, 0), C(1, 1)]);
const quads = evaluate7([C(A, 0), C(A, 1), C(A, 2), C(A, 3), C(K, 0), C(2, 1), C(3, 2)]);
const fh = evaluate7([C(A, 0), C(A, 1), C(A, 2), C(K, 0), C(K, 1), C(2, 2), C(3, 3)]);
const fl = evaluate7([C(A, 2), C(J, 2), C(8, 2), C(5, 2), C(2, 2), C(K, 0), C(Q, 1)]);
const wheel = evaluate7([C(A, 0), C(0, 1), C(1, 2), C(2, 3), C(3, 0), C(K, 1), C(Q, 2)]);
const trips = evaluate7([C(9, 0), C(9, 1), C(9, 2), C(A, 0), C(K, 1), C(2, 2), C(3, 3)]);
const tp = evaluate7([C(9, 0), C(9, 1), C(5, 2), C(5, 3), C(A, 0), C(2, 1), C(3, 2)]);
const pair = evaluate7([C(9, 0), C(9, 1), C(A, 2), C(K, 3), C(5, 0), C(2, 1), C(3, 2)]);
const hc = evaluate7([C(A, 0), C(J, 1), C(8, 2), C(5, 3), C(3, 0), C(2, 1), C(0, 2)]);

check("straight flush > quads", sf > quads);
check("quads > full house", quads > fh);
check("full house > flush", fh > fl);
check("flush > straight (wheel)", fl > wheel);
check("straight > trips", wheel > trips);
check("trips > two pair", trips > tp);
check("two pair > pair", tp > pair);
check("pair > high card", pair > hc);
check("straight flush named", categoryName(sf) === "a straight flush");
check("full house named", categoryName(fh) === "a full house");
check("wheel named a straight", categoryName(wheel) === "a straight");

const q1 = evaluate7([C(A, 0), C(A, 1), C(A, 2), C(A, 3), C(K, 0), C(2, 1), C(3, 2)]);
const q2 = evaluate7([C(A, 0), C(A, 1), C(A, 2), C(A, 3), C(Q, 0), C(2, 1), C(3, 2)]);
check("quads kicker K beats Q", q1 > q2);

// Higher two pair beats lower two pair; kicker breaks a tie.
const tpHigh = evaluate7([C(A, 0), C(A, 1), C(2, 2), C(2, 3), C(K, 0), C(5, 1), C(3, 2)]);
const tpLow = evaluate7([C(K, 0), C(K, 1), C(2, 2), C(2, 3), C(A, 0), C(5, 1), C(3, 2)]);
check("aces-up two pair beats kings-up", tpHigh > tpLow);

const d1 = shuffle("0xabc123");
const d2 = shuffle("0xabc123");
const d3 = shuffle("0xdef456");
check("shuffle deterministic", JSON.stringify(d1) === JSON.stringify(d2));
check("shuffle differs by seed", JSON.stringify(d1) !== JSON.stringify(d3));
check("deck is 52 unique cards", new Set(d1).size === 52 && d1.length === 52);

// ---- betting engine ----

type Strat = (v: PlayerView) => Action;
const checkCall: Strat = (v) => (v.legal.canCheck ? { type: "check" } : { type: "call" });
const foldAny: Strat = (v) => (v.legal.canCheck ? { type: "check" } : { type: "fold" });
const shove: Strat = (v) =>
  v.legal.canRaise ? { type: "raise", to: v.legal.maxRaiseTo } : v.legal.canCall ? { type: "call" } : { type: "check" };

function playHand(
  stacks: [number, number],
  button: Seat,
  seed: `0x${string}`,
  strat: [Strat, Strat],
): Table {
  const t = startHand(stacks, button, shuffle(seed));
  let guard = 0;
  while (!t.handOver && guard++ < 500) {
    const p = t.toAct;
    applyAction(t, strat[p]!(viewFor(t)));
  }
  return t;
}

const total = (t: Table) => t.stacks[0] + t.stacks[1];

// Both call down: goes to showdown, chips conserved, full board dealt.
const h1 = playHand([START_STACK, START_STACK], 0, "0x01", [checkCall, checkCall]);
check("call-down ends", h1.handOver);
check("call-down conserves chips", total(h1) === 2 * START_STACK);
check("call-down reaches showdown", h1.result?.showdown === true && h1.board.length === 5);
check("no negative stacks", h1.stacks[0] >= 0 && h1.stacks[1] >= 0);

// Small blind (button, seat 0) folds preflop: big blind wins the blinds.
const h2 = playHand([START_STACK, START_STACK], 0, "0x02", [foldAny, checkCall]);
check("fold ends without showdown", h2.handOver && h2.result?.showdown === false);
check("fold gives pot to seat 1", h2.result?.winner === 1);
check("fold conserves chips", total(h2) === 2 * START_STACK);
check("folder lost the small blind", h2.stacks[0] === START_STACK - 10 && h2.stacks[1] === START_STACK + 10);

// Both jam all-in: one seat ends with everything (or an exact split), chips conserved.
const h3 = playHand([START_STACK, START_STACK], 0, "0x03", [shove, shove]);
check("all-in ends", h3.handOver);
check("all-in conserves chips", total(h3) === 2 * START_STACK);
check(
  "all-in resolves to a stack or a split",
  h3.result?.winner === null
    ? h3.stacks[0] === START_STACK && h3.stacks[1] === START_STACK
    : Math.max(h3.stacks[0], h3.stacks[1]) === 2 * START_STACK,
);

// Play a short match of several hands, alternating the button, and assert the
// chip total never drifts and no stack goes negative.
let stacks: [number, number] = [START_STACK, START_STACK];
let button: Seat = 0;
let drift = false;
for (let i = 0; i < 12 && stacks[0] > 0 && stacks[1] > 0; i++) {
  const h = playHand(stacks, button, `0x1${i}` as `0x${string}`, [checkCall, shove]);
  if (h.stacks[0] < 0 || h.stacks[1] < 0 || h.stacks[0] + h.stacks[1] !== 2 * START_STACK) drift = true;
  stacks = [h.stacks[0], h.stacks[1]];
  button = button === 0 ? 1 : 0;
}
check("multi-hand match never drifts chips", !drift);

// ---- decision parsing ----
const legal = {
  canFold: true,
  canCheck: true,
  canCall: true,
  callAmount: 20,
  canRaise: true,
  minRaiseTo: 40,
  maxRaiseTo: 1000,
};
const pa = (text: string) => parseAction(text, legal);
check("parses tagged FOLD", pa("I have nothing. ACTION: FOLD").type === "fold");
check("parses tagged CHECK", pa("ACTION: CHECK").type === "check");
check("parses tagged CALL", pa("pot odds are fine. ACTION: CALL").type === "call");
const r = pa("value bet here. ACTION: RAISE 120");
check("parses tagged RAISE amount", r.type === "raise" && (r as { to: number }).to === 120);
const allin = pa("stack is short, ACTION: ALLIN");
check("parses ALLIN to max", allin.type === "raise" && (allin as { to: number }).to === 1000);
const bet = pa("ACTION: bet 40");
check("parses BET as raise", bet.type === "raise" && (bet as { to: number }).to === 40);
const untagged = pa("I think I should raise to 200 here");
check("parses untagged raise", untagged.type === "raise" && (untagged as { to: number }).to === 200);
check("garbage falls back to check", pa("hmm, not sure what to do").type === "check");

// ---- multi-player engine (side pots) ----

type MStrat = (v: MultiView) => Action;
const mCheckCall: MStrat = (v) => (v.legal.canCheck ? { type: "check" } : { type: "call" });
const mFold: MStrat = (v) => (v.legal.canCheck ? { type: "check" } : { type: "fold" });
const mShove: MStrat = (v) =>
  v.legal.canRaise ? { type: "raise", to: v.legal.maxRaiseTo } : v.legal.canCall ? { type: "call" } : { type: "check" };

function playMulti(stacks: number[], button: number, seed: `0x${string}`, strats: MStrat[]): MultiTable {
  const t = startMulti(stacks, button, shuffle(seed));
  let guard = 0;
  while (!t.handOver && guard++ < 2000) {
    applyMulti(t, strats[t.toAct]!(viewMulti(t)));
  }
  return t;
}
const msum = (t: MultiTable) => t.stacks.reduce((a, b) => a + b, 0);

// Everyone calls to showdown at a 4-handed table: chips conserved, board complete.
const m1 = playMulti([1000, 1000, 1000, 1000], 0, "0xa1", [mCheckCall, mCheckCall, mCheckCall, mCheckCall]);
check("4-way call-down ends", m1.handOver);
check("4-way conserves chips", msum(m1) === 4000);
check("4-way reaches full board", m1.board.length === 5);
check("4-way no negative stacks", m1.stacks.every((s) => s >= 0));

// Everyone folds to one player: that player wins the blinds, chips conserved.
const m2 = playMulti([1000, 1000, 1000], 0, "0xa2", [mFold, mFold, mCheckCall]);
check("fold-around ends", m2.handOver);
check("fold-around conserves chips", msum(m2) === 3000);
check("one live seat wins", m2.pots?.every((p) => p.winners.length >= 1) ?? false);

// The side-pot case: a short stack all-in against two deep stacks. Chips must be
// conserved and the pots must sum to everything committed.
const m3 = playMulti([120, 1000, 1000], 0, "0xa3", [mShove, mShove, mShove]);
check("side-pot hand ends", m3.handOver);
check("side-pot conserves chips", msum(m3) === 2120);
check("side-pot no negative stacks", m3.stacks.every((s) => s >= 0));
const potTotal = (m3.pots ?? []).reduce((a, p) => a + p.amount, 0);
check("pots sum to the chips committed", potTotal === 2120);
// The short stack (seat 0) can never win more than the main pot it covered (3 x 120).
const seat0Won = (m3.pots ?? []).filter((p) => p.winners.includes(0)).reduce((a, p) => a + p.amount, 0);
check("short all-in wins at most the main pot", seat0Won <= 360);

// A 6-max match over several hands, mixed strategies, alternating button: the chip
// total never drifts and no stack goes negative.
let mstacks = [1000, 1000, 1000, 1000, 1000, 1000];
let mbutton = 0;
let mdrift = false;
const mstrats: MStrat[] = [mCheckCall, mShove, mFold, mCheckCall, mShove, mCheckCall];
for (let i = 0; i < 15 && mstacks.filter((s) => s > 0).length > 1; i++) {
  const h = playMulti(mstacks, mbutton, `0xb${i}` as `0x${string}`, mstrats);
  if (h.stacks.some((s) => s < 0) || msum(h) !== 6000) mdrift = true;
  mstacks = [...h.stacks];
  mbutton = (mbutton + 1) % 6;
}
check("6-max match never drifts chips", !mdrift);

console.log(failures === 0 ? "\nall poker checks passed" : `\n${failures} poker checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
