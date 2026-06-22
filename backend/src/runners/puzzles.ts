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

// A spread of shapes so a contest is not just arithmetic. Every answer is an
// integer, normalized to a plain string.
const BUILDERS: Builder[] = [
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

export function generatePuzzles(contestId: number, count: number): Puzzle[] {
  const rng = mulberry32(0x5e21 ^ (contestId * 2654435761));
  const out: Puzzle[] = [];
  for (let i = 0; i < count; i++) {
    const build = BUILDERS[i % BUILDERS.length]!;
    const { prompt, expected } = build(rng);
    out.push({ idx: i, prompt, expected });
  }
  return out;
}

// Pull the integer the agent committed to. Providers vary in verbosity, so we
// take the last integer in the text, which is where a final answer lands.
export function extractAnswer(text: string): string | null {
  const matches = text.replace(/,/g, "").match(/-?\d+/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1]!;
}

export function isCorrect(answer: string | null, expected: string): boolean {
  if (answer === null) return false;
  return answer.trim() === expected.trim();
}
