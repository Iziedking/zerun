// Deterministic puzzle bank for the Solver runner. Each puzzle has a single
// checkable answer, so grading is objective: an agent is right or wrong, and
// the field is ranked by correct count with speed as the tiebreak. Puzzles are
// seeded by contest id so a contest is reproducible and the same field faces
// the same questions.

export interface Puzzle {
  idx: number;
  prompt: string;
  expected: string;
}

// Small, fast, seedable PRNG (mulberry32). Good enough for puzzle variety.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

type Builder = (rng: () => number) => { prompt: string; expected: string };

// Single-step shapes most agents can handle. Every answer is an integer.
const EASY_BUILDERS: Builder[] = [
  // Multi-term arithmetic.
  (rng) => {
    const a = intBetween(rng, 12, 99);
    const b = intBetween(rng, 12, 99);
    const c = intBetween(rng, 2, 12);
    const expected = a + b * c;
    return { prompt: `Compute ${a} + ${b} * ${c}.`, expected: String(expected) };
  },
  // Word problem.
  (rng) => {
    const crates = intBetween(rng, 5, 20);
    const per = intBetween(rng, 6, 24);
    const removed = intBetween(rng, 1, crates * per - 1);
    const expected = crates * per - removed;
    return {
      prompt: `A warehouse has ${crates} crates with ${per} items each. ${removed} items are shipped out. How many items remain?`,
      expected: String(expected),
    };
  },
  // Arithmetic sequence next term.
  (rng) => {
    const start = intBetween(rng, 2, 20);
    const step = intBetween(rng, 3, 15);
    const terms = [start, start + step, start + 2 * step, start + 3 * step];
    const expected = start + 4 * step;
    return {
      prompt: `What is the next number in this sequence: ${terms.join(", ")}, ?`,
      expected: String(expected),
    };
  },
  // Percentage.
  (rng) => {
    const base = intBetween(rng, 1, 40) * 50; // multiple of 50
    const pct = pick(rng, [10, 20, 25, 40, 50, 75]);
    const expected = Math.round((base * pct) / 100);
    return { prompt: `What is ${pct}% of ${base}?`, expected: String(expected) };
  },
  // Modular clock.
  (rng) => {
    const start = intBetween(rng, 1, 12);
    const add = intBetween(rng, 13, 40);
    const expected = ((start + add - 1) % 12) + 1;
    return {
      prompt: `On a 12-hour clock, ${add} hours after ${start} o'clock, what hour is shown?`,
      expected: String(expected),
    };
  },
  // Counting / divisibility.
  (rng) => {
    const n = intBetween(rng, 30, 90);
    const d = pick(rng, [3, 4, 5, 6]);
    let count = 0;
    for (let i = 1; i <= n; i++) if (i % d === 0) count++;
    return {
      prompt: `How many whole numbers from 1 to ${n} are divisible by ${d}?`,
      expected: String(count),
    };
  },
];

// Multi-step puzzles where a bigger reasoning budget pays off. A low tier agent
// often truncates before reaching the answer; a high tier agent reasons through.
const HARD_BUILDERS: Builder[] = [
  // Hard: average speed over two legs. Needs total distance over total time,
  // not the average of the two speeds, so a quick guess misses it.
  (rng) => {
    const d1 = intBetween(rng, 40, 140);
    const d2 = intBetween(rng, 40, 140);
    const t1 = intBetween(rng, 1, 3);
    const t2 = intBetween(rng, 1, 3);
    const expected = Math.round((d1 + d2) / (t1 + t2));
    const hr = (t: number) => `${t} hour${t === 1 ? "" : "s"}`;
    return {
      prompt: `A courier drives ${d1} km in ${hr(t1)}, then ${d2} km in ${hr(t2)}. What is the average speed for the whole trip in km/h, rounded to the nearest whole number? End with "ANSWER: <number>".`,
      expected: String(expected),
    };
  },
  // Hard: two stacked percentage discounts, which do not simply add.
  (rng) => {
    const item = pick(rng, ["jacket", "desk", "bike", "lamp", "chair"]);
    const base = intBetween(rng, 2, 12) * 100;
    const p1 = pick(rng, [10, 20, 25, 40]);
    const p2 = pick(rng, [10, 15, 20, 50]);
    const expected = Math.round((base * (100 - p1) * (100 - p2)) / 10000);
    return {
      prompt: `A ${item} costs ${base} dollars. Take ${p1}% off, then take ${p2}% off the reduced price. What is the final price in whole dollars? End with "ANSWER: <number>".`,
      expected: String(expected),
    };
  },
  // Hard: a small age word problem that needs setting up and solving an
  // equation, the kind of multi-step reasoning a bigger budget handles better.
  (rng) => {
    const t = intBetween(rng, 2, 9);
    const y = 2 * t; // Mia is 4x Theo now; in y years she is twice as old.
    const names = pick(rng, [["Mia", "Theo"], ["Ada", "Sam"], ["Nia", "Leo"]]);
    return {
      prompt: `${names[0]} is 4 times as old as ${names[1]}. In ${y} years, ${names[0]} will be twice as old as ${names[1]}. How old is ${names[1]} now? End with "ANSWER: <number>".`,
      expected: String(t),
    };
  },
];

// Builds a contest's puzzle set, alternating easy and hard so a reasoning
// budget always has something to bite on. Odd positions are hard, which gives
// roughly half the set to the multi-step problems even on a short contest.
export function generatePuzzles(contestId: number, count: number): Puzzle[] {
  const rng = mulberry32(0x5e21 ^ (contestId * 2654435761));
  const out: Puzzle[] = [];
  let easyIdx = 0;
  let hardIdx = 0;
  for (let i = 0; i < count; i++) {
    const hard = i % 2 === 1;
    const build = hard
      ? HARD_BUILDERS[hardIdx++ % HARD_BUILDERS.length]!
      : EASY_BUILDERS[easyIdx++ % EASY_BUILDERS.length]!;
    const { prompt, expected } = build(rng);
    out.push({ idx: i, prompt, expected });
  }
  return out;
}

// Pull the integer the agent committed to. The solver asks every agent to end
// with a line like "ANSWER: 42", so we read that first. This is what makes the
// grading fair to agents that show their work: a long, correct chain of
// reasoning is not penalized by stray numbers in the middle of it. Only if no
// tagged answer is present do we fall back to the last integer in the text.
export function extractAnswer(text: string): string | null {
  const clean = text.replace(/,/g, "");
  const tagged = clean.match(/answer\s*[:=]\s*(-?\d+)/i);
  if (tagged) return tagged[1]!;
  const matches = clean.match(/-?\d+/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1]!;
}

export function isCorrect(answer: string | null, expected: string): boolean {
  if (answer === null) return false;
  return answer.trim() === expected.trim();
}
