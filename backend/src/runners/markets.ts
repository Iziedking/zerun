// Resolved prediction markets for the Analyst runner. We pull binary (Yes/No)
// markets that have already settled on Polymarket, strip the result, and ask
// agents to predict it. Because the outcome is already fixed, grading is
// objective: the winning side is the one Polymarket priced at 1.

export interface Market {
  idx: number;
  question: string;
  description: string;
  outcomes: [string, string]; // [Yes, No]
  winnerIndex: 0 | 1; // 0 = first outcome (Yes) won, 1 = second (No) won
  winnerLabel: string;
}

interface RawMarket {
  question?: string;
  description?: string;
  outcomes?: string; // JSON string, e.g. '["Yes","No"]'
  outcomePrices?: string; // JSON string, e.g. '["1","0"]'
  umaResolutionStatus?: string;
  closed?: boolean;
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

// Fetch a set of resolved binary markets. Asks for more than needed and filters
// down to the clean ones (exactly two outcomes, one priced 1 and one priced 0).
export async function fetchMarkets(count: number): Promise<Market[]> {
  const limit = Math.max(count * 6, 30);
  const url = `https://gamma-api.polymarket.com/markets?closed=true&limit=${limit}&order=closedTime&ascending=false`;

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

  const out: Market[] = [];
  for (const m of raw) {
    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices);
    if (outcomes.length !== 2 || prices.length !== 2) continue;
    if (m.umaResolutionStatus && m.umaResolutionStatus !== "resolved") continue;
    // Need a clear winner: exactly one price at 1 and one at 0.
    const yesWon = prices[0] === "1" && prices[1] === "0";
    const noWon = prices[0] === "0" && prices[1] === "1";
    if (!yesWon && !noWon) continue;
    const question = (m.question ?? "").trim();
    if (!question) continue;

    const winnerIndex: 0 | 1 = yesWon ? 0 : 1;
    out.push({
      idx: out.length,
      question,
      description: (m.description ?? "").slice(0, 600),
      outcomes: [outcomes[0]!, outcomes[1]!],
      winnerIndex,
      winnerLabel: outcomes[winnerIndex]!,
    });
    if (out.length >= count) break;
  }

  return out;
}

// Pull the agent's probability that the FIRST outcome (Yes) happens, from a
// reply we asked to end with "PROB: <0-100>". Falls back to the last percentage
// or integer in the text. Returns a value in [0, 1], or null if none found.
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
