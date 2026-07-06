import { type Card, rankOf, suitOf, evaluate7 } from "./cards.js";
import type { Action, Legal } from "./table.js";

// Deterministic, tier-scaled heads-up strategy engine. This is the grind half of
// the 0G-hybrid poker: an agent's strategy is authored and proven once on 0G
// Compute, then this engine plays it out over thousands of hands at machine speed,
// so a match always terminates instead of hanging on a per-move model call.
//
// The policy is a set of constants. Tier 4 is the full, disciplined strategy;
// each lower tier degrades it along real poker leaks (noisier equity, no range
// modelling, position-blind, a calling station that pays off -EV and never
// bluffs). Over a long sample a TrueSkill ladder separates the tiers cleanly,
// which is exactly the model-stress-test benchmark Zerun is built to be.
//
// Pure and deterministic: equity is Monte Carlo seeded from the exact cards, so a
// given spot always resolves the same way and a hand is reproducible from its
// replay. No chain, no network, no clock.

// ----------------------------------------------------------------------------
// Deterministic RNG (mulberry32), seeded from the cards plus a salt, so bluff and
// steal frequencies and the Monte Carlo sampling mix the same way every time a
// spot recurs, stable across processes (unlike Math.random or a salted hash).
// ----------------------------------------------------------------------------

function seedFrom(cards: Card[], salt: number): number {
  let h = (2166136261 ^ (salt >>> 0)) >>> 0;
  for (const c of cards) {
    h = Math.imul(h, 16777619) >>> 0;
    h = (h ^ (rankOf(c) * 37 + suitOf(c))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample k distinct cards from a pool without replacement (partial Fisher-Yates).
function sample(pool: Card[], k: number, rng: () => number): Card[] {
  const a = [...pool];
  const n = a.length;
  const take = Math.min(k, n);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a.slice(0, take);
}

const FULL_DECK: Card[] = Array.from({ length: 52 }, (_, i) => i);

// ----------------------------------------------------------------------------
// Hand strength
// ----------------------------------------------------------------------------

// A quick 0..1 read of a two-card starting hand, no board. Chen formula,
// normalized. Good enough to gate preflop aggression before Monte Carlo takes
// over postflop.
export function preflopStrength(hole: Card[]): number {
  if (hole.length < 2) return 0;
  const v1 = rankOf(hole[0]!) + 2;
  const v2 = rankOf(hole[1]!) + 2;
  const suited = suitOf(hole[0]!) === suitOf(hole[1]!);
  const high = Math.max(v1, v2);
  const low = Math.min(v1, v2);

  const base = ({ 14: 10, 13: 8, 12: 7, 11: 6 } as Record<number, number>)[high] ?? high / 2;
  let score = base;
  if (high === low) score = Math.max(base * 2, 5); // a pair
  if (suited) score += 2;
  if (high !== low) {
    const gap = high - low;
    if (gap === 1) score += 1;
    else if (gap === 2) score -= 1;
    else if (gap === 3) score -= 2;
    else if (gap >= 4) score -= 4;
    if (gap <= 1 && high < 12) score += 1; // connected, room to make straights
  }
  // Chen runs about -1..20; normalize to 0..1.
  return Math.max(0, Math.min(1, (score + 1) / 21));
}

// Win probability of hole against one random hand on the given board, ties count
// as half. Iterations trade accuracy for speed and are set per tier.
export function equity(hole: Card[], board: Card[], iterations: number, rng: () => number): number {
  if (hole.length < 2) return 0;
  const known = new Set([...hole, ...board]);
  const deck = FULL_DECK.filter((c) => !known.has(c));
  const needBoard = Math.max(0, 5 - board.length);

  let wins = 0;
  let trials = 0;
  for (let i = 0; i < iterations; i++) {
    if (deck.length < needBoard + 2) break;
    const draw = sample(deck, needBoard + 2, rng);
    const opp = draw.slice(0, 2);
    const extra = draw.slice(2);
    const full = [...board, ...extra];
    const mine = evaluate7([...hole, ...full]);
    const theirs = evaluate7([...opp, ...full]);
    if (mine > theirs) wins += 1;
    else if (mine === theirs) wins += 0.5;
    trials += 1;
  }
  return trials === 0 ? 0 : wins / trials;
}

// Win probability against an opponent whose two cards fall in the top rangeFrac
// of starting hands. Equity versus a fully random hand overstates us when the
// opponent has shown strength by betting, because a betting range is stronger
// than random; gating calls on this removes that bias. rangeFrac of 1 reduces to
// the plain random-hand estimate.
export function equityVsRange(
  hole: Card[],
  board: Card[],
  rangeFrac: number,
  iterations: number,
  rng: () => number,
): number {
  if (hole.length < 2) return 0;
  const known = new Set([...hole, ...board]);
  const deck = FULL_DECK.filter((c) => !known.has(c));
  const needBoard = Math.max(0, 5 - board.length);

  // Build the opponent's range once: all remaining two-card combos ranked by
  // preflop strength, keep the top fraction.
  let range: [Card, Card][] | null = null;
  if (rangeFrac < 0.999) {
    const combos: [Card, Card][] = [];
    for (let i = 0; i < deck.length; i++)
      for (let j = i + 1; j < deck.length; j++) combos.push([deck[i]!, deck[j]!]);
    combos.sort((a, b) => preflopStrength(b) - preflopStrength(a));
    const keep = Math.max(1, Math.floor(combos.length * rangeFrac));
    range = combos.slice(0, keep);
  }

  let wins = 0;
  let trials = 0;
  for (let i = 0; i < iterations; i++) {
    let opp: Card[];
    let rest: Card[];
    if (range) {
      opp = range[Math.floor(rng() * range.length)]!;
      const oppSet = new Set(opp);
      rest = deck.filter((c) => !oppSet.has(c));
    } else {
      if (deck.length < needBoard + 2) break;
      const draw = sample(deck, 2, rng);
      opp = draw;
      const oppSet = new Set(opp);
      rest = deck.filter((c) => !oppSet.has(c));
    }
    if (rest.length < needBoard) continue;
    const extra = needBoard ? sample(rest, needBoard, rng) : [];
    const full = [...board, ...extra];
    const mine = evaluate7([...hole, ...full]);
    const theirs = evaluate7([...opp, ...full]);
    if (mine > theirs) wins += 1;
    else if (mine === theirs) wins += 0.5;
    trials += 1;
  }
  return trials === 0 ? 0 : wins / trials;
}

// Rough read of a drawing hand on the flop or turn, 0..1. Flags flush draws and
// open-ended straight draws our hole cards take part in, so the policy can
// semibluff hands with little showdown value now but good equity to improve.
// Returns 0 on the river or when nothing is drawing.
export function drawStrength(hole: Card[], board: Card[]): number {
  if (board.length < 3 || board.length >= 5 || hole.length < 2) return 0;
  const cards = [...hole, ...board];
  let best = 0;

  // Flush draw: four of one suit, at least one of them ours.
  const suitCount = new Map<number, number>();
  for (const c of cards) suitCount.set(suitOf(c), (suitCount.get(suitOf(c)) ?? 0) + 1);
  for (const [suit, count] of suitCount) {
    if (count === 4 && hole.some((c) => suitOf(c) === suit)) best = Math.max(best, 0.9);
  }

  // Open-ended straight draw: four consecutive ranks, both ends live, at least
  // one of the four ours. Ace plays high (14) and low (1).
  const lowSet = (cs: Card[]): Set<number> => {
    const s = new Set<number>();
    for (const c of cs) {
      const v = rankOf(c) + 2;
      s.add(v);
      if (v === 14) s.add(1);
    }
    return s;
  };
  const vals = lowSet(cards);
  const holeVals = lowSet(hole);
  for (let low = 2; low <= 10; low++) {
    const window = [low, low + 1, low + 2, low + 3];
    if (window.every((v) => vals.has(v))) {
      const alreadyMade = vals.has(low - 1) || vals.has(low + 4);
      const ours = window.some((v) => holeVals.has(v));
      if (!alreadyMade && ours) best = Math.max(best, 0.8);
    }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Policy: the tunable constants. Tier 4 is the full strategy; lower tiers
// degrade it. Every field is a lever the 0G-authored strategy can later perturb
// through policyOverride, which is where tier -> model routing earns its keep:
// a better model tunes a better policy, and the ladder proves it.
// ----------------------------------------------------------------------------

export interface Policy {
  mcIters: number; // Monte Carlo samples for our own equity read
  rangeIters: number; // samples for equity against a modelled range
  rangeFrac: number | null; // opponent range as a top fraction, null = versus random
  positionAware: boolean; // widen in position, tighten out of position

  pfCheapRatio: number; // price at or under which continuing is cheap
  pfOpenRaise: number; // open-raise a cheap spot at or above this strength
  pfOpenCall: number; // else call a cheap price at or above this
  pfOptionRaise: number; // raise the free option (big blind, limped pot)
  pfBigRaise: number; // re-raise a premium into real pressure
  pfBigCall: number; // flat a decent hand when the price works
  pfJamRatio: number; // above this price, judge the call on equity

  valueBet: number; // bet for value at or above this equity when checked to
  valueRaise: number; // raise for value at or above this range equity
  shoveEq: number; // jam a monster when raise is not offered
  cbetBluff: number; // bluff frequency with air when checked to
  semibluffBet: number; // frequency to bet a strong draw when checked to
  semibluffRaise: number; // frequency to raise a strong draw facing a bet
  drawBar: number; // drawStrength at or above this counts as strong

  callMarginBase: number; // equity edge over pot odds required to call
  callMarginScale: number; // extra margin scaled by bet size (bet-size respect)
  betFraction: number; // standard bet/raise size as a fraction of the pot
}

// Ordered rookie (0) -> apex (5), matching the six compute levels. The gradient
// climbs in skill: sharper equity, range awareness, position, disciplined calls,
// and a measured bluff frequency. The top of the ladder (apex, 5) is the
// value-disciplined reference bot, which is TIGHTER than the master (4) below it,
// because thin value and light 3-bets bleed chips over a match.
const POLICIES: Policy[] = [
  {
    // 0 rookie: a calling station. Noisy equity, no range or position sense,
    // pays off well below pot odds, and never bluffs.
    mcIters: 12,
    rangeIters: 0,
    rangeFrac: null,
    positionAware: false,
    pfCheapRatio: 0.34,
    pfOpenRaise: 0.55,
    pfOpenCall: 0.1,
    pfOptionRaise: 0.65,
    pfBigRaise: 0.75,
    pfBigCall: 0.2,
    pfJamRatio: 0.4,
    valueBet: 0.7,
    valueRaise: 0.8,
    shoveEq: 0.82,
    cbetBluff: 0,
    semibluffBet: 0,
    semibluffRaise: 0,
    drawBar: 0.75,
    callMarginBase: -0.12,
    callMarginScale: 0,
    betFraction: 0.5,
  },
  {
    // 1 scrappy: still no range or position read, calls a touch too much, only
    // raises strong hands, no bluffs.
    mcIters: 30,
    rangeIters: 0,
    rangeFrac: null,
    positionAware: false,
    pfCheapRatio: 0.34,
    pfOpenRaise: 0.48,
    pfOpenCall: 0.16,
    pfOptionRaise: 0.58,
    pfBigRaise: 0.68,
    pfBigCall: 0.28,
    pfJamRatio: 0.4,
    valueBet: 0.64,
    valueRaise: 0.74,
    shoveEq: 0.82,
    cbetBluff: 0.02,
    semibluffBet: 0,
    semibluffRaise: 0,
    drawBar: 0.75,
    callMarginBase: -0.05,
    callMarginScale: 0.03,
    betFraction: 0.6,
  },
  {
    // 2 sharp: position-aware and a small bluff, but reads equity versus a random
    // hand (which flatters us), so it overcalls against real strength.
    mcIters: 80,
    rangeIters: 0,
    rangeFrac: null,
    positionAware: true,
    pfCheapRatio: 0.34,
    pfOpenRaise: 0.44,
    pfOpenCall: 0.22,
    pfOptionRaise: 0.52,
    pfBigRaise: 0.62,
    pfBigCall: 0.36,
    pfJamRatio: 0.4,
    valueBet: 0.6,
    valueRaise: 0.7,
    shoveEq: 0.82,
    cbetBluff: 0.05,
    semibluffBet: 0.3,
    semibluffRaise: 0.1,
    drawBar: 0.75,
    callMarginBase: 0,
    callMarginScale: 0.05,
    betFraction: 0.66,
  },
  {
    // 3 expert: models a betting range, mostly disciplined, near-full aggression.
    mcIters: 140,
    rangeIters: 120,
    rangeFrac: 0.72,
    positionAware: true,
    pfCheapRatio: 0.34,
    pfOpenRaise: 0.42,
    pfOpenCall: 0.24,
    pfOptionRaise: 0.5,
    pfBigRaise: 0.6,
    pfBigCall: 0.38,
    pfJamRatio: 0.4,
    valueBet: 0.57,
    valueRaise: 0.68,
    shoveEq: 0.82,
    cbetBluff: 0.07,
    semibluffBet: 0.45,
    semibluffRaise: 0.2,
    drawBar: 0.75,
    callMarginBase: 0.01,
    callMarginScale: 0.06,
    betFraction: 0.66,
  },
  {
    // 4 master: the full strategy. Tightest range read, thin value, full semibluff
    // and disciplined pot-odds calls.
    mcIters: 200,
    rangeIters: 160,
    rangeFrac: 0.65,
    positionAware: true,
    pfCheapRatio: 0.34,
    pfOpenRaise: 0.4,
    pfOpenCall: 0.24,
    pfOptionRaise: 0.5,
    pfBigRaise: 0.6,
    pfBigCall: 0.38,
    pfJamRatio: 0.4,
    valueBet: 0.56,
    valueRaise: 0.66,
    shoveEq: 0.82,
    cbetBluff: 0.08,
    semibluffBet: 0.55,
    semibluffRaise: 0.28,
    drawBar: 0.75,
    callMarginBase: 0.02,
    callMarginScale: 0.06,
    betFraction: 0.66,
  },
  {
    // 5 apex: mirrors the value-disciplined reference bot (dev_fun rab-bot). Its
    // tuning encodes that thin value bets, light 3-bets and narrow call margins all
    // quietly bleed chips, so the top tier is TIGHTER than the master below it, not
    // looser: higher value bars, no light 3-bets, and a call margin that scales hard
    // with bet size. That discipline is the edge that makes apex beat the
    // aggressive-but-leaky tier 4 over a match. Values map 1:1 to the reference
    // POLICY (value_bet, value_raise, value_3bet, call_margin/size_penalty,
    // range_frac_bet, cbet_bluff, semibluff_*, bet_frac).
    mcIters: 240,
    rangeIters: 200,
    rangeFrac: 0.6, // range_frac_bet: tightest read of the opponent's betting range
    positionAware: true,
    pfCheapRatio: 0.34,
    pfOpenRaise: 0.47, // open_ip 0.42 / open_oop 0.52, centred (position shifts ±0.04)
    pfOpenCall: 0.34, // call_ip 0.30 / call_oop 0.38, centred
    pfOptionRaise: 0.6, // free_raise: only strong hands raise a free option
    pfBigRaise: 0.8, // value_3bet: no light 3-bets, only premiums reraise into pressure
    pfBigCall: 0.38, // call_oop
    pfJamRatio: 0.4,
    valueBet: 0.62, // value_bet: disciplined, no thin value that gets raised off
    valueRaise: 0.72, // value_raise
    shoveEq: 0.82,
    cbetBluff: 0.08, // cbet_bluff: a thin air c-bet, rarely
    semibluffBet: 0.55, // semibluff_bet
    semibluffRaise: 0.2, // semibluff_raise
    drawBar: 0.75,
    callMarginBase: 0.04, // call_margin: base equity edge over pot odds to call
    callMarginScale: 0.1, // size_penalty: respect bet size, fold more to big bets
    betFraction: 0.6, // bet_frac
  },
];

export function policyForTier(tier: number, override?: Partial<Policy>): Policy {
  const t = Math.max(0, Math.min(POLICIES.length - 1, Math.floor(tier)));
  return { ...POLICIES[t]!, ...(override ?? {}) };
}

// ----------------------------------------------------------------------------
// Decision
// ----------------------------------------------------------------------------

export interface StrategyInput {
  hole: Card[];
  board: Card[];
  legal: Legal;
  pot: number; // total chips in the pot right now
  toCall: number; // extra chips a call costs (not the to-amount)
  street: number; // 0 preflop, 1 flop, 2 turn, 3 river
  inPosition: boolean | null; // heads-up the button has position postflop
  tier: number;
  seed?: number; // deterministic salt, e.g. contestId and hand index mixed in
  policyOverride?: Partial<Policy>; // the 0G-authored tuning, when present
}

export interface StrategyDecision {
  action: Action;
  reason: string; // a short line for the live feed and the replay
}

// Clamp a raise target into the legal window. The engine also clamps, this is a
// second guard so the feed never shows an out-of-range size.
function clampRaise(to: number, legal: Legal): number {
  const lo = legal.minRaiseTo > 0 ? legal.minRaiseTo : to;
  const hi = legal.maxRaiseTo;
  return Math.max(lo, Math.min(hi, Math.round(to)));
}

function raiseTo(input: StrategyInput, p: Policy): number {
  const target = input.pot * p.betFraction + input.toCall;
  return clampRaise(Math.max(target, input.legal.minRaiseTo), input.legal);
}

// Cheapest legal way to stay out of trouble: check if it is free, else fold.
function giveUp(legal: Legal, why: string): StrategyDecision {
  if (legal.canCheck) return { action: { type: "check" }, reason: `check ${why}` };
  return { action: { type: "fold" }, reason: `fold ${why}` };
}

export function decideStrategy(input: StrategyInput): StrategyDecision {
  const p = policyForTier(input.tier, input.policyOverride);
  const { hole, board, legal } = input;
  const rng = mulberry32(seedFrom([...hole, ...board], (input.seed ?? 0) | 0));
  const pot = input.pot;
  const toCall = Math.max(0, input.toCall);
  const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;

  if (input.street === 0) return decidePreflop(input, p, rng, toCall, potOdds);
  return decidePostflop(input, p, rng, toCall, potOdds);
}

function decidePreflop(
  input: StrategyInput,
  p: Policy,
  rng: () => number,
  toCall: number,
  potOdds: number,
): StrategyDecision {
  const { hole, legal } = input;
  const s = preflopStrength(hole);

  // Position shifts the ranges: the button opens wider, out of position tightens.
  let openLine = p.pfOpenRaise;
  let callLine = p.pfOpenCall;
  if (p.positionAware && input.inPosition === true) {
    openLine -= 0.04;
    callLine -= 0.04;
  } else if (p.positionAware && input.inPosition === false) {
    openLine += 0.04;
    callLine += 0.02;
  }

  if (toCall <= 0) {
    // We can check: the big-blind option, or a limped pot. Raise the better hands
    // for value, take a free flop with the rest.
    if (s >= p.pfOptionRaise && legal.canRaise)
      return { action: { type: "raise", to: raiseTo(input, p) }, reason: `pf option s=${s.toFixed(2)}` };
    if (legal.canCheck) return { action: { type: "check" }, reason: "pf free look" };
    return giveUp(legal, "pf no check");
  }

  if (potOdds <= p.pfCheapRatio) {
    // Cheap: a button open or defending a small raise. Play wide.
    if (s >= openLine && legal.canRaise)
      return { action: { type: "raise", to: raiseTo(input, p) }, reason: `pf open s=${s.toFixed(2)}` };
    if (s >= callLine && legal.canCall) return { action: { type: "call" }, reason: `pf cheap s=${s.toFixed(2)}` };
    return giveUp(legal, `pf trash s=${s.toFixed(2)}`);
  }

  // Real pressure: a 3-bet or a big open. Tighten up.
  if (s >= p.pfBigRaise && legal.canRaise)
    return { action: { type: "raise", to: raiseTo(input, p) }, reason: `pf premium s=${s.toFixed(2)}` };
  if (potOdds >= p.pfJamRatio) {
    // Jam territory: playability no longer matters, only showdown equity, so judge
    // the call on equity against a raising range instead of Chen.
    const eq =
      p.rangeFrac !== null
        ? equityVsRange(hole, [], p.rangeFrac, p.rangeIters, rng)
        : equity(hole, [], p.mcIters, rng);
    if (eq >= potOdds + p.callMarginBase && legal.canCall)
      return { action: { type: "call" }, reason: `pf jam call eq=${eq.toFixed(2)} po=${potOdds.toFixed(2)}` };
    return giveUp(legal, `pf jam fold eq=${eq.toFixed(2)}`);
  }
  if (s >= p.pfBigCall && legal.canCall)
    return { action: { type: "call" }, reason: `pf stand s=${s.toFixed(2)}` };
  return giveUp(legal, `pf fold s=${s.toFixed(2)}`);
}

function decidePostflop(
  input: StrategyInput,
  p: Policy,
  rng: () => number,
  toCall: number,
  potOdds: number,
): StrategyDecision {
  const { hole, board, legal } = input;
  const draw = drawStrength(hole, board);

  if (toCall <= 0) {
    // Checked to us. Value bet the strong, semibluff strong draws, fire a measured
    // bluff at some air, otherwise take the free card.
    const eq = equity(hole, board, p.mcIters, rng);
    if (eq >= p.valueBet && legal.canRaise)
      return { action: { type: "raise", to: raiseTo(input, p) }, reason: `value eq=${eq.toFixed(2)}` };
    if (legal.canRaise) {
      if (draw >= p.drawBar && rng() < p.semibluffBet)
        return { action: { type: "raise", to: raiseTo(input, p) }, reason: `semibluff draw=${draw.toFixed(2)}` };
      if (eq < 0.45 && rng() < p.cbetBluff)
        return { action: { type: "raise", to: raiseTo(input, p) }, reason: `bluff eq=${eq.toFixed(2)}` };
    }
    if (legal.canCheck) return { action: { type: "check" }, reason: `check back eq=${eq.toFixed(2)}` };
    return giveUp(legal, `no check eq=${eq.toFixed(2)}`);
  }

  // Facing a bet. Judge it against a betting range, which is stronger than random,
  // so we do not overcall. Lower tiers skip the range model and pay it off.
  const eqr =
    p.rangeFrac !== null
      ? equityVsRange(hole, board, p.rangeFrac, p.rangeIters, rng)
      : equity(hole, board, p.mcIters, rng);
  if (eqr >= p.valueRaise && legal.canRaise)
    return { action: { type: "raise", to: raiseTo(input, p) }, reason: `value raise eq=${eqr.toFixed(2)}` };
  if (eqr >= p.shoveEq && !legal.canRaise && legal.canCall)
    return { action: { type: "call" }, reason: `stuck jam eq=${eqr.toFixed(2)}` };
  if (draw >= p.drawBar && legal.canRaise && rng() < p.semibluffRaise)
    return { action: { type: "raise", to: raiseTo(input, p) }, reason: `semibluff raise draw=${draw.toFixed(2)}` };

  const margin =
    p.callMarginBase + p.callMarginScale * Math.min(1.5, input.pot > 0 ? toCall / input.pot : 1.5);
  if (eqr >= potOdds + margin && legal.canCall)
    return { action: { type: "call" }, reason: `call eq=${eqr.toFixed(2)} po=${potOdds.toFixed(2)}` };

  // A strong draw realizes more than the range estimate credits, so it can still
  // call on raw equity when the price is right.
  if (draw >= p.drawBar && legal.canCall) {
    const eq = equity(hole, board, p.mcIters, rng);
    if (eq >= potOdds + p.callMarginBase)
      return { action: { type: "call" }, reason: `draw call eq=${eq.toFixed(2)} po=${potOdds.toFixed(2)}` };
  }
  return giveUp(legal, `no price eq=${eqr.toFixed(2)} po=${potOdds.toFixed(2)}`);
}
