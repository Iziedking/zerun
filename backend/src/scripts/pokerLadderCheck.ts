import { shuffle } from "../runners/poker/cards.js";
import { startHand, legalActions, applyAction, viewFor, START_STACK, type Seat } from "../runners/poker/table.js";
import {
  startHand as startMultiHand,
  legalActions as multiLegal,
  applyAction as applyMulti,
  viewFor as multiView,
} from "../runners/poker/multi.js";
import { decideStrategy } from "../runners/poker/strategy.js";

// Does the Compute ladder actually make a poker agent stronger?
//
// Poker decisions are NOT 0G calls: the provenance on every action reads
// `provider: deterministic, model: tier-N-policy, latency: 0ms`. The tier gradient lives
// entirely in `POLICIES[tier]` in strategy.ts. So the claim "more Compute plays measurably
// sharper" is a claim about that table, and it is testable offline, for free, with no chain
// and no inference.
//
// This plays every tier against every other tier over many seeded hands, alternating the
// button so position cannot skew it, and reports chips won per 100 hands. A working ladder
// shows a positive row-mean climbing with tier and a mostly positive upper triangle.
//
//   HANDS=2000 npx tsx src/scripts/pokerLadderCheck.ts

const HANDS = Number(process.env.HANDS ?? "1200");
const SEED_OFFSET = Number(process.env.SEED ?? "0");
const TIERS = [0, 1, 2, 3, 4, 5];
// Hands are capped so a pathological line cannot loop forever.
const MAX_ACTIONS = 400;

/** One heads-up hand between two tiers. Returns seat 0's chip delta. */
function playHand(tierA: number, tierB: number, button: Seat, handIndex: number): number {
  const seedHex = `0x${(handIndex * 2654435761).toString(16).padStart(16, "0")}` as `0x${string}`;
  const t = startHand([START_STACK, START_STACK], button, shuffle(seedHex));
  const tierOf = [tierA, tierB];

  let acted = 0;
  while (!t.handOver && acted < MAX_ACTIONS) {
    const seat = t.toAct;
    const view = viewFor(t);
    const legal = legalActions(t);
    const { action } = decideStrategy({
      hole: t.holes[seat],
      board: t.board,
      legal,
      pot: t.handPut[0] + t.handPut[1],
      toCall: view.legal.callAmount,
      street: t.street,
      inPosition: seat === t.button,
      tier: tierOf[seat]!,
      // Deterministic, and different per hand/seat, so the two sides do not share a coin.
      seed: (handIndex * 1_000_003 + seat * 17 + acted) >>> 0,
    });
    applyAction(t, action);
    acted += 1;
  }
  return t.stacks[0] - START_STACK;
}

/** Chips seat-0's tier wins per 100 hands against the other, button alternating. */
function match(tierA: number, tierB: number): number {
  let net = 0;
  for (let h = 0; h < HANDS; h++) {
    net += playHand(tierA, tierB, (h % 2) as Seat, h);
  }
  return (net / HANDS) * 100;
}

// ---------------------------------------------------------------------------
// Six-handed. The heads-up grid says nothing about a full table: multiway, equity is
// judged against everyone still live, so an aggressive tier that prints heads-up can
// bleed chips stacking off into a five-player field. This mirrors the real table runner:
// a CASH GAME (stacks reset to START_STACK each hand, chip profit accumulates) with the
// button rotating, so over any multiple of six hands every tier sits in every position
// an equal number of times and no seat can flatter its occupant.
// ---------------------------------------------------------------------------

function tableSession(tiers: number[], hands: number, seedOffset = SEED_OFFSET): number[] {
  const n = tiers.length;
  const net = new Array<number>(n).fill(0);
  let button = 0;

  for (let handIndex = 0; handIndex < hands; handIndex++) {
    // SEED shifts the whole deck sequence, so a second run is an independent sample rather
    // than a longer look at the same cards. Replication beats one long run for spotting a
    // result that only one deal order supports.
    const h = handIndex + seedOffset;
    const seedHex = `0x${(h * 2654435761 + 12345).toString(16).padStart(16, "0")}` as `0x${string}`;
    const t = startMultiHand(new Array(n).fill(START_STACK), button, shuffle(seedHex));
    const decisionSeq = new Array<number>(n).fill(0);

    let guard = 0;
    while (!t.handOver && guard++ < 2000) {
      const seat = t.toAct;
      const view = multiView(t);
      const legal = multiLegal(t);
      const dseq = decisionSeq[seat]!;
      decisionSeq[seat] = dseq + 1;

      const { action } = decideStrategy({
        hole: t.holes[seat]!,
        board: t.board,
        legal,
        pot: view.pot,
        toCall: view.legal.callAmount,
        street: t.street,
        inPosition: seat === t.button,
        tier: tiers[seat]!,
        // Exactly what runPokerTable passes: equity against everyone still in the hand.
        opponents: Math.max(1, t.folded.filter((f) => !f).length - 1),
        seed: (handIndex * 1_000_003 + seat * 17 + dseq) >>> 0,
      });
      applyMulti(t, action);
    }

    for (let s = 0; s < n; s++) net[s] = net[s]! + (t.stacks[s]! - START_STACK);
    button = (button + 1) % n;
  }
  return net;
}

function sixHanded(hands: number, reps: number) {
  const tiers = [0, 1, 2, 3, 4, 5];
  console.log(`\nsix-handed table: one agent per tier, cash game, button rotating`);
  console.log(`${reps} independent session(s) of ${hands} hands (a multiple of 6 keeps positions equal)\n`);

  // Independent sessions, not one long one. A single six-handed session at a few thousand
  // hands does NOT resolve the ordering: L4 and L5 trade first place between deck orders.
  // Reporting the spread across sessions is the difference between a measurement and a
  // number that happens to be true of one shuffle.
  const samples: number[][] = [];
  for (let r = 0; r < reps; r++) {
    // SEED shifts the whole block of sessions, so two invocations with different SEEDs are
    // independent samples. Without it every run replayed the same decks and looked reproducible
    // when it was merely identical -- three "different" seeds returned byte-identical tables.
    const net = tableSession(tiers, hands, SEED_OFFSET + r * 1_000_003);
    samples.push(net.map((c) => (c / hands) * 100));
    process.stdout.write(`  session ${r + 1}/${reps} done\n`);
  }

  const stat = (i: number) => {
    const xs = samples.map((s) => s[i]!);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : NaN;
    const se = xs.length > 1 ? sd / Math.sqrt(xs.length) : NaN;
    return { mean, se, lo: Math.min(...xs), hi: Math.max(...xs) };
  };

  console.log(`\n  tier   chips/100      +/- se        min        max`);
  const ranked = tiers.map((t) => ({ t, ...stat(t) })).sort((a, b) => b.mean - a.mean);
  for (const r of ranked) {
    const se = Number.isNaN(r.se) ? "     n/a" : r.se.toFixed(1).padStart(8);
    console.log(`  L${r.t}   ${r.mean.toFixed(1).padStart(10)}  ${se}  ${r.lo.toFixed(1).padStart(9)}  ${r.hi.toFixed(1).padStart(9)}`);
  }

  console.log(`\nordering check (is each tier's mean above every lower tier's?):`);
  let inversions = 0;
  for (let a = 0; a < tiers.length; a++) {
    for (let b = 0; b < a; b++) {
      const A = stat(a);
      const B = stat(b);
      if (A.mean <= B.mean) {
        // Only call it a finding if the gap clears the noise of both estimates.
        const noisy = Number.isNaN(A.se) || B.mean - A.mean < 2 * (A.se + B.se);
        console.log(
          `  L${a} earns less than L${b}: ${A.mean.toFixed(1)} vs ${B.mean.toFixed(1)}` +
            (noisy ? "   (within noise; more sessions needed)" : "   <-- outside noise"),
        );
        inversions += 1;
      }
    }
  }
  if (inversions === 0) console.log(`  ok — mean chip rate rises monotonically with tier`);
  if (reps < 5) console.log(`\n  ${reps} session(s) is too few to trust the ordering. Try REPS=8.`);
}

// A/B the multiway correction the right way: PAIRED.
//
// Running the two arms separately and comparing their means throws away the fact that both
// saw the identical decks. Card luck dominates six-handed variance, and it cancels exactly
// when you difference the two arms hand-for-hand. So run each session twice, flag off then
// on, and study the per-session DELTA. Its standard error is the honest error bar on "does
// this change help", and it is far smaller than either arm's own.
function abTest(hands: number, reps: number) {
  const tiers = [0, 1, 2, 3, 4, 5];
  console.log(`\npaired A/B of POKER_MULTIWAY, six-handed`);
  console.log(`${reps} session(s) x ${hands} hands, each played twice on identical decks\n`);

  const deltas: number[][] = [];
  for (let r = 0; r < reps; r++) {
    const seed = r * 1_000_003;
    process.env.POKER_MULTIWAY = "off";
    const before = tableSession(tiers, hands, seed);
    process.env.POKER_MULTIWAY = "on";
    const after = tableSession(tiers, hands, seed);
    deltas.push(before.map((b, i) => ((after[i]! - b) / hands) * 100));
    console.log(`  session ${r + 1}/${reps} done`);
  }
  process.env.POKER_MULTIWAY = "off";

  console.log(`\n  tier   delta chips/100     +/- se     t      verdict`);
  for (const t of tiers) {
    const xs = deltas.map((d) => d[t]!);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : NaN;
    const se = sd / Math.sqrt(xs.length);
    const tstat = se > 0 ? mean / se : 0;
    // |t| >= 2 is the crude bar for "not noise" at these sample sizes.
    const verdict = !Number.isFinite(tstat) ? "n/a" : Math.abs(tstat) >= 2 ? (mean > 0 ? "HELPS" : "HURTS") : "noise";
    console.log(
      `  L${t}   ${mean.toFixed(1).padStart(14)}  ${se.toFixed(1).padStart(9)}  ${tstat.toFixed(2).padStart(6)}   ${verdict}`,
    );
  }
  console.log(`\n  A positive delta on the aware tiers (3,4,5) and a negative one on the unaware`);
  console.log(`  tiers (0,1) is the change working as designed. Anything marked "noise" is not evidence.`);
}

function main() {
  // AB=1 runs the paired before/after of POKER_MULTIWAY.
  if (process.env.AB === "1") {
    abTest(Math.max(6, Math.round(HANDS / 6) * 6), Number(process.env.REPS ?? "4"));
    return;
  }

  // TABLE=1 runs the six-handed check instead of the heads-up grid.
  if (process.env.TABLE === "1") {
    sixHanded(Math.max(6, Math.round(HANDS / 6) * 6), Number(process.env.REPS ?? "1"));
    return;
  }

  // PAIR=a,b runs one pairing at high volume, to check a suspicious cell is not a seed artefact.
  const pair = process.env.PAIR?.split(",").map(Number);
  if (pair && pair.length === 2) {
    const [a, b] = pair as [number, number];
    console.log(`\nL${a} vs L${b} over ${HANDS} hands: ${match(a, b).toFixed(1)} chips/100 for L${a}`);
    return;
  }

  console.log(`\npoker tier ladder: chips won per 100 hands, row tier vs column tier`);
  console.log(`${HANDS} hands per pairing, button alternating, deterministic seeds\n`);

  const grid: number[][] = TIERS.map(() => TIERS.map(() => 0));
  for (const a of TIERS) {
    for (const b of TIERS) {
      if (a === b) continue;
      if (b < a) {
        grid[a]![b] = -grid[b]![a]!; // already played, and it is zero-sum
        continue;
      }
      grid[a]![b] = match(a, b);
    }
  }

  const head = TIERS.map((t) => `L${t}`.padStart(9)).join("");
  console.log(`        ${head}${"mean".padStart(11)}`);
  for (const a of TIERS) {
    const cells = TIERS.map((b) => (a === b ? "·".padStart(9) : grid[a]![b]!.toFixed(1).padStart(9))).join("");
    const opps = TIERS.filter((b) => b !== a);
    const mean = opps.reduce((s, b) => s + grid[a]![b]!, 0) / opps.length;
    console.log(`  L${a}   ${cells}${mean.toFixed(1).padStart(11)}`);
  }

  // The ladder's own promise: a higher tier beats every lower one, and mean win rate rises.
  console.log(`\nmonotonicity check (does each tier beat every tier below it?):`);
  let broken = 0;
  for (const a of TIERS) {
    for (const b of TIERS) {
      if (b >= a) continue;
      if (grid[a]![b]! <= 0) {
        console.log(`  L${a} does NOT beat L${b}: ${grid[a]![b]!.toFixed(1)} chips/100`);
        broken += 1;
      }
    }
  }
  if (broken === 0) console.log(`  ok — every tier beats every tier below it`);
  else console.log(`\n  ${broken} inversions. The Compute ladder does not hold at the table.`);
}

main();
