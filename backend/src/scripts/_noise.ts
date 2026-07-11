// How often does a level-0 agent lead a six-handed table after N hands, purely by luck?
// Same engine, same seeding scheme as pokerLadderCheck. Chips are cumulative across hands.
import { startHand, applyAction as applyMulti, viewFor, type MultiTable } from "../runners/poker/multi.js";
import { shuffle } from "../runners/poker/cards.js";
import { decideStrategy } from "../runners/poker/strategy.js";
const START = 1000;
const tiers = [0, 1, 2, 3, 4, 5];

function session(hands: number, seedOffset: number): number[] {
  const net = new Array(6).fill(0);
  let button = 0;
  for (let handIndex = 0; handIndex < hands; handIndex++) {
    const h = handIndex + seedOffset;
    const seedHex = `0x${(h * 2654435761 + 12345).toString(16).padStart(16, "0")}` as `0x${string}`;
    const t: MultiTable = startHand(new Array(6).fill(START), button, shuffle(seedHex));
    const dseq = new Array(6).fill(0);
    let guard = 0;
    while (!t.handOver && guard++ < 2000) {
      const seat = t.toAct;
      const view = viewFor(t);
      const { action } = decideStrategy({
        hole: t.holes[seat]!, board: t.board, legal: view.legal, pot: view.pot,
        toCall: view.legal.callAmount, street: t.street, inPosition: seat === t.button,
        tier: tiers[seat]!, opponents: Math.max(1, t.folded.filter((f) => !f).length - 1),
        seed: (handIndex * 1_000_003 + seat * 17 + dseq[seat]++) >>> 0,
      });
      applyMulti(t, action);
    }
    for (let s = 0; s < 6; s++) net[s] += t.stacks[s]! - START;
    button = (button + 1) % 6;
  }
  return net;
}

const REPS = 40;
console.log(`\nsix-handed, one agent per tier, ${REPS} independent sessions per row`);
console.log(`how often does each tier finish the session with the most chips?\n`);
console.log(`  hands   L0 leads   L5 leads   L0 beats L5`);
for (const hands of [33, 100, 500, 2000]) {
  let l0 = 0, l5 = 0, l0OverL5 = 0;
  for (let r = 0; r < REPS; r++) {
    const net = session(hands, r * 1_000_003);
    const best = net.indexOf(Math.max(...net));
    if (best === 0) l0++;
    if (best === 5) l5++;
    if (net[0]! > net[5]!) l0OverL5++;
  }
  console.log(`  ${String(hands).padStart(5)}   ${String(l0).padStart(8)}   ${String(l5).padStart(8)}   ${String(l0OverL5).padStart(11)}  (of ${REPS})`);
}
