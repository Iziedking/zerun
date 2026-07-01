import { keccak256, toHex, concatHex } from "viem";

// Card and deck primitives for the poker duel, plus a 7-card hand evaluator.
// Pure and deterministic: no chain, no 0G, no clock. A card is an integer 0..51,
// encoded as rank * 4 + suit. Rank runs 0..12 for 2..A, suit runs 0..3.

export type Card = number;

const RANK_CHARS = "23456789TJQKA";
const SUIT_CHARS = "cdhs";

export function rankOf(card: Card): number {
  return Math.floor(card / 4);
}
export function suitOf(card: Card): number {
  return card % 4;
}

// Human label like "Ah" or "Tc", for the feed and the stored replay.
export function cardLabel(card: Card): string {
  return `${RANK_CHARS[rankOf(card)]}${SUIT_CHARS[suitOf(card)]}`;
}
export function handLabels(cards: Card[]): string {
  return cards.map(cardLabel).join(" ");
}

// A deterministic Fisher-Yates shuffle seeded from a hex string, so a hand's deal
// is reproducible from (contestId, handIndex) and can be verified from the replay.
// Randomness comes from keccak256(seed || counter), consumed as a big integer.
export function shuffle(seedHex: `0x${string}`): Card[] {
  const deck: Card[] = Array.from({ length: 52 }, (_, i) => i);
  let counter = 0;
  const nextRand = (): bigint => {
    const h = keccak256(concatHex([seedHex, toHex(counter++, { size: 32 })]));
    return BigInt(h);
  };
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Number(nextRand() % BigInt(i + 1));
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

// Rank a 5-card hand into a single comparable score (higher is better). Category
// (straight flush down to high card) lives in the high digits, then up to five
// kicker ranks packed base-15, so a plain numeric compare orders any two hands.
function rank5(cards: Card[]): number {
  const ranks = cards.map(rankOf).sort((a, b) => b - a); // descending, 0..12
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const uniq = [...new Set(ranks)];
  let straightHigh = -1;
  if (uniq.length === 5) {
    if (uniq[0]! - uniq[4]! === 4) straightHigh = uniq[0]!;
    // The wheel A-5-4-3-2 is a 5-high straight (ranks 12,3,2,1,0).
    else if (uniq[0] === 12 && uniq[1] === 3 && uniq[2] === 2 && uniq[3] === 1 && uniq[4] === 0)
      straightHigh = 3;
  }

  const cnt = new Map<number, number>();
  for (const r of ranks) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  // Groups by count first, then by rank, so groups[0] is the strongest set.
  const groups = [...cnt.entries()]
    .map(([r, c]) => ({ r, c }))
    .sort((a, b) => b.c - a.c || b.r - a.r);

  let cat: number;
  let kick: number[];
  if (straightHigh >= 0 && isFlush) {
    cat = 8;
    kick = [straightHigh];
  } else if (groups[0]!.c === 4) {
    cat = 7;
    kick = [groups[0]!.r, groups[1]!.r];
  } else if (groups[0]!.c === 3 && groups[1]?.c === 2) {
    cat = 6;
    kick = [groups[0]!.r, groups[1]!.r];
  } else if (isFlush) {
    cat = 5;
    kick = ranks;
  } else if (straightHigh >= 0) {
    cat = 4;
    kick = [straightHigh];
  } else if (groups[0]!.c === 3) {
    cat = 3;
    kick = [groups[0]!.r, ...ranks.filter((r) => r !== groups[0]!.r)];
  } else if (groups[0]!.c === 2 && groups[1]?.c === 2) {
    cat = 2;
    const pair = [groups[0]!.r, groups[1]!.r].sort((a, b) => b - a);
    const kicker = ranks.find((r) => r !== pair[0] && r !== pair[1])!;
    kick = [...pair, kicker];
  } else if (groups[0]!.c === 2) {
    cat = 1;
    kick = [groups[0]!.r, ...ranks.filter((r) => r !== groups[0]!.r)];
  } else {
    cat = 0;
    kick = ranks;
  }

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (kick[i] ?? 0);
  return score;
}

// Best 5-of-7 score. Enumerates the 21 ways to drop two of the seven cards.
export function evaluate7(cards: Card[]): number {
  let best = -1;
  for (let a = 0; a < 7; a++) {
    for (let b = a + 1; b < 7; b++) {
      const five: Card[] = [];
      for (let k = 0; k < 7; k++) if (k !== a && k !== b) five.push(cards[k]!);
      const s = rank5(five);
      if (s > best) best = s;
    }
  }
  return best;
}

const CATEGORY_NAMES = [
  "high card",
  "a pair",
  "two pair",
  "three of a kind",
  "a straight",
  "a flush",
  "a full house",
  "four of a kind",
  "a straight flush",
];

// The category name for a 7-card score, for the feed and replay ("a flush").
export function categoryName(score: number): string {
  // Undo the base-15 packing to recover the category digit.
  let s = score;
  for (let i = 0; i < 5; i++) s = Math.floor(s / 15);
  return CATEGORY_NAMES[s] ?? "high card";
}
