// Markets for the Analyst runner. Each market is a binary (Yes/No) claim with a
// definite, checkable answer, generated deterministically from the contest id.
// This is a reasoning arena: real closed prediction markets are unforecastable by
// a model with no live data and a training cutoff (and the public feeds return
// clusters of near-identical, biased questions a constant answer sweeps), so we
// generate balanced claims an agent can actually reason about. Roughly half
// resolve Yes and half No, so answering one side blindly scores about 50% while a
// strong, well-reasoned agent pulls clear.

export interface Market {
  idx: number;
  question: string;
  description: string;
  outcomes: [string, string]; // [Yes, No]
  winnerIndex: 0 | 1; // 0 = Yes is the true answer, 1 = No
  winnerLabel: string;
}

// Small, fast, seedable PRNG (mulberry32), seeded by contest id so a contest is
// reproducible and the whole field faces the same questions.
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

function shuffled<T>(rng: () => number, xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// A builder returns a claim and whether the true answer is Yes. Each builder
// decides Yes/No from the actual maths or a coin flip, so the set stays balanced.
type MarketBuilder = (rng: () => number) => { question: string; yes: boolean };

// Single-step claims most agents can settle.
const EASY_MARKETS: MarketBuilder[] = [
  (rng) => {
    const a = intBetween(rng, 20, 99);
    const b = intBetween(rng, 20, 99);
    return { question: `Is ${a} greater than ${b}?`, yes: a > b };
  },
  (rng) => {
    const n = intBetween(rng, 10, 99);
    return { question: `Is ${n} an even number?`, yes: n % 2 === 0 };
  },
  (rng) => {
    const n = intBetween(rng, 12, 96);
    const d = pick(rng, [3, 4, 6]);
    return { question: `Is ${n} divisible by ${d}?`, yes: n % d === 0 };
  },
  (rng) => {
    const a = intBetween(rng, 15, 60);
    const b = intBetween(rng, 15, 60);
    const t = intBetween(rng, 45, 100);
    return { question: `Is ${a} plus ${b} greater than ${t}?`, yes: a + b > t };
  },
  (rng) => {
    const a = intBetween(rng, 6, 15);
    const b = intBetween(rng, 6, 15);
    const p = a * b;
    const lie = rng() < 0.5;
    const shown = lie ? p + pick(rng, [-3, -2, 2, 3]) : p;
    return { question: `Does ${a} times ${b} equal ${shown}?`, yes: shown === p };
  },
];

// Two-step claims: a careless agent slips, a focused one holds.
const MEDIUM_MARKETS: MarketBuilder[] = [
  (rng) => {
    const p = pick(rng, [10, 20, 25, 50]);
    const n = intBetween(rng, 2, 20) * 10;
    const m = intBetween(rng, 5, 90);
    return { question: `Is ${p}% of ${n} greater than ${m}?`, yes: (p * n) / 100 > m };
  },
  (rng) => {
    const a = intBetween(rng, 5, 20);
    const b = intBetween(rng, 5, 20);
    const c = intBetween(rng, 2, 6);
    const t = intBetween(rng, 40, 200);
    return { question: `Is (${a} + ${b}) times ${c} greater than ${t}?`, yes: (a + b) * c > t };
  },
  (rng) => {
    const primes = [11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
    const comps = [15, 21, 25, 27, 33, 35, 39, 49, 51, 55, 57];
    const usePrime = rng() < 0.5;
    const n = usePrime ? pick(rng, primes) : pick(rng, comps);
    return { question: `Is ${n} a prime number?`, yes: usePrime };
  },
];

// Multi-step reasoning and 0G knowledge, where a bigger Compute budget pays off.
const HARD_MARKETS: MarketBuilder[] = [
  (rng) => {
    const d1 = intBetween(rng, 40, 120);
    const d2 = intBetween(rng, 40, 120);
    const t1 = intBetween(rng, 1, 3);
    const t2 = intBetween(rng, 1, 3);
    const t = intBetween(rng, 30, 75);
    const avg = (d1 + d2) / (t1 + t2);
    return {
      question: `A courier drives ${d1} km in ${t1}h, then ${d2} km in ${t2}h. Is the average speed over the whole trip greater than ${t} km/h?`,
      yes: avg > t,
    };
  },
  (rng) => {
    const lie = rng() < 0.5;
    const shown = lie ? pick(rng, [80085, 16601, 1337, 42161]) : 16602;
    return { question: `Is the EVM chain id of the 0G Galileo testnet ${shown}?`, yes: shown === 16602 };
  },
  (rng) => {
    const lie = rng() < 0.5;
    const shown = lie ? pick(rng, [6, 8, 9, 12]) : 18;
    return {
      question: `Does the 0G native gas token use ${shown} decimals, the same as ETH?`,
      yes: shown === 18,
    };
  },
  (rng) => {
    const lie = rng() < 0.5;
    const shown = lie ? pick(rng, [2, 3, 5, 6]) : 4;
    return {
      question: `Does the 0G stack have ${shown} core layers: Chain, Compute, Storage, and Data Availability?`,
      yes: shown === 4,
    };
  },
];

// Build a contest's markets as a difficulty gradient, each band drawn without
// replacement so no claim repeats within a contest. Seeded by contest id.
export function generateMarkets(contestId: number, count: number): Market[] {
  const rng = mulberry32(0x3b9a ^ (contestId * 2654435761));
  const easy = shuffled(rng, EASY_MARKETS);
  const medium = shuffled(rng, MEDIUM_MARKETS);
  const hard = shuffled(rng, HARD_MARKETS);

  const out: Market[] = [];
  const at = { easy: 0, medium: 0, hard: 0 };
  for (let i = 0; i < count; i++) {
    const frac = count <= 1 ? 0 : i / (count - 1);
    const build =
      frac < 0.4
        ? easy[at.easy++ % easy.length]!
        : frac < 0.7
          ? medium[at.medium++ % medium.length]!
          : hard[at.hard++ % hard.length]!;
    const { question, yes } = build(rng);
    out.push({
      idx: i,
      question,
      description: "",
      outcomes: ["Yes", "No"],
      winnerIndex: yes ? 0 : 1,
      winnerLabel: yes ? "Yes" : "No",
    });
  }
  return out;
}

// Pull the agent's probability that the answer is Yes, from a reply we asked to
// end with "PROB: <0-100>". Falls back to the last percentage or integer in the
// text. Returns a value in [0, 1], or null if none found.
export function extractProbability(text: string): number | null {
  const clean = text.replace(/,/g, "");
  const tagged = clean.match(/prob\s*[:=]\s*(\d{1,3}(?:\.\d+)?)/i);
  const pct = tagged ? tagged[1] : null;
  let n: number | null = null;
  if (pct !== null) {
    n = Number(pct);
  } else {
    const all = clean.match(/\d{1,3}(?:\.\d+)?/g);
    if (all && all.length) n = Number(all[all.length - 1]);
  }
  if (n === null || !Number.isFinite(n)) return null;
  if (n > 1) n = n / 100; // a percentage
  return Math.max(0, Math.min(1, n));
}

// Brier score for a probability against the resolved outcome. Lower is better.
export function brier(probYes: number, winnerIndex: 0 | 1): number {
  const actualYes = winnerIndex === 0 ? 1 : 0;
  return (probYes - actualYes) ** 2;
}
