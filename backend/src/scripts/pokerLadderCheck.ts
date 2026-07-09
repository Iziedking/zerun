import { shuffle } from "../runners/poker/cards.js";
import { startHand, legalActions, applyAction, viewFor, START_STACK, type Seat } from "../runners/poker/table.js";
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

function main() {
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
