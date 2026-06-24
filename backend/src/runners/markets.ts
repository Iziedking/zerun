// Real prediction markets for the Analyst runner. We pull the highest-volume
// binary (Yes/No) markets that have already settled on Polymarket, strip the
// result, and ask agents to forecast it. Ordering by volume (not by close time)
// gives the big, meaningful, varied markets a forecaster should reason about
// (elections, rate decisions, sports finals, crypto milestones), not the trivial
// near-identical micro-markets the recently-closed feed returns. Grading is
// objective: the winning side is the one Polymarket settled at 1.

export interface Market {
  idx: number;
  question: string;
  description: string;
  outcomes: [string, string]; // [Yes, No]
  winnerIndex: 0 | 1; // 0 = the first outcome (Yes) settled true, 1 = No
  winnerLabel: string;
}

interface RawMarket {
  question?: string;
  description?: string;
  outcomes?: string; // JSON string, e.g. '["Yes","No"]'
  outcomePrices?: string; // JSON string, e.g. '["1","0"]'
  umaResolutionStatus?: string;
  volumeNum?: number;
  volume?: string;
}

function parseJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// Seedable PRNG so a contest picks a reproducible but varied slice of the pool.
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

function shuffled<T>(rng: () => number, xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Collapse a question to a stem so near-identical series ("...be 29C", "...be
// 30C") dedupe to one, while genuinely different questions stay distinct.
function stem(q: string): string {
  return q
    .toLowerCase()
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g, "#")
    .replace(/[^a-z# ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
}

// Low-signal markets a model cannot reason about (exact weather, etc.).
const JUNK = /temperature|°\s*[cf]|degrees|\bweather\b|rainfall|\bsnow\b/i;

// Fetch a varied set of resolved binary markets, seeded by contest id so each
// contest draws a different reproducible slice and no question repeats within it.
export async function fetchMarkets(contestId: number, count: number): Promise<Market[]> {
  const url = `https://gamma-api.polymarket.com/markets?closed=true&limit=250&order=volumeNum&ascending=false`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let raw: RawMarket[];
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Polymarket responded ${res.status}`);
    raw = (await res.json()) as RawMarket[];
  } finally {
    clearTimeout(timer);
  }

  const seen = new Set<string>();
  const pool: { question: string; description: string; outcomes: [string, string]; winnerIndex: 0 | 1 }[] = [];
  for (const m of raw) {
    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices);
    if (outcomes.length !== 2 || prices.length !== 2) continue;
    if (m.umaResolutionStatus && m.umaResolutionStatus !== "resolved") continue;
    const yesWon = prices[0] === "1" && prices[1] === "0";
    const noWon = prices[0] === "0" && prices[1] === "1";
    if (!yesWon && !noWon) continue;
    const question = (m.question ?? "").trim();
    if (question.length < 18 || JUNK.test(question)) continue;
    const key = stem(question);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({
      question,
      description: (m.description ?? "").slice(0, 600),
      outcomes: [outcomes[0]!, outcomes[1]!],
      winnerIndex: yesWon ? 0 : 1,
    });
  }

  // Balance the set: real high-volume markets skew heavily to No (longshot "will
  // X win" questions), so a blind draw could be nearly all No and let a constant
  // answer sweep. Take roughly half from each side, then shuffle the order.
  const rng = mulberry32(0x9e37 ^ (contestId * 2654435761));
  const yesPool = shuffled(rng, pool.filter((p) => p.winnerIndex === 0));
  const noPool = shuffled(rng, pool.filter((p) => p.winnerIndex === 1));
  const wantYes = Math.min(yesPool.length, Math.ceil(count / 2));
  const wantNo = Math.min(noPool.length, count - wantYes);
  let chosen = [...yesPool.slice(0, wantYes), ...noPool.slice(0, wantNo)];
  if (chosen.length < count) {
    const leftover = [...yesPool.slice(wantYes), ...noPool.slice(wantNo)];
    chosen = chosen.concat(leftover.slice(0, count - chosen.length));
  }

  return shuffled(rng, chosen).map((p, i) => ({
    idx: i,
    question: p.question,
    description: p.description,
    outcomes: p.outcomes,
    winnerIndex: p.winnerIndex,
    winnerLabel: p.outcomes[p.winnerIndex],
  }));
}

// Pull the agent's probability that the market resolves Yes, from a reply we
// asked to end with "PROB: <0-100>". Falls back to the last percentage or integer
// in the text. Returns a value in [0, 1], or null if none found.
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
