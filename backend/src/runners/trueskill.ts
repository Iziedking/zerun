// Minimal TrueSkill (Microsoft's Bayesian skill rating), shared by the poker ladder and the chess
// competition ladder. Each agent carries a rating (mu, sigma): mu is the skill estimate, sigma the
// uncertainty. A two-player result nudges the winner's mu up and the loser's down, and shrinks both
// sigmas (we learned something). Chess also draws, which pulls the two ratings toward each other and
// still shrinks sigma. The ladder ranks by the CONSERVATIVE rating (mu - 3*sigma), so a top spot
// needs both a high skill estimate and enough games to be confident.

export const TS_MU0 = 25;
export const TS_SIGMA0 = 25 / 3; // ~8.3333
const BETA = TS_SIGMA0 / 2; // skill-class width: the mu gap that is one "class"
const TAU = TS_SIGMA0 / 100; // per-game dynamics; keeps sigma from freezing at zero
const SQRT2PI = Math.sqrt(2 * Math.PI);

// The draw margin, as a performance gap inside which a game is "too close to call". Chess between
// comparable agents draws often, so this is deliberately non-trivial (~20% draw prior). Tunable.
const DRAW_MARGIN = Number(process.env.CHESS_TS_DRAW_MARGIN ?? String(TS_SIGMA0 / 6)); // ~1.39

export interface Rating {
  mu: number;
  sigma: number;
}

export function defaultRating(): Rating {
  return { mu: TS_MU0, sigma: TS_SIGMA0 };
}

// The ladder-ranking number: a lower-bound on skill at ~99.7% confidence.
export function conservative(r: Rating): number {
  return r.mu - 3 * r.sigma;
}

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

function cdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Abramowitz-Stegun erf approximation (max error ~1.5e-7), so we need no dependency.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-ax * ax);
  return sign * y;
}

// The win/no-draw correction terms. Guard the extreme tail where cdf underflows so a
// blowout does not produce NaN.
function vWin(t: number): number {
  const denom = cdf(t);
  return denom > 1e-9 ? pdf(t) / denom : -t;
}

// Update a decisive two-player result (winner beats loser, no draw). Pure: returns the
// new ratings, leaving the inputs untouched.
export function updateOneVsOne(winner: Rating, loser: Rating): { winner: Rating; loser: Rating } {
  const sw2 = winner.sigma * winner.sigma + TAU * TAU;
  const sl2 = loser.sigma * loser.sigma + TAU * TAU;
  const c = Math.sqrt(2 * BETA * BETA + sw2 + sl2);
  const t = (winner.mu - loser.mu) / c;
  const v = vWin(t);
  const w = v * (v + t);

  const muW = winner.mu + (sw2 / c) * v;
  const muL = loser.mu - (sl2 / c) * v;
  // sigma^2 shrinks by the information gained; floor it so it never hits zero.
  const sigW = Math.sqrt(Math.max(1e-4, sw2 * (1 - (sw2 / (c * c)) * w)));
  const sigL = Math.sqrt(Math.max(1e-4, sl2 * (1 - (sl2 / (c * c)) * w)));
  return { winner: { mu: muW, sigma: sigW }, loser: { mu: muL, sigma: sigL } };
}

// The draw correction terms (Moserware two-player form). t is the normalized mean gap, eps the
// normalized draw margin. vDraw is signed by t so a draw pulls the favourite down and the
// underdog up; wDraw is the variance-shrink multiplier.
function vDraw(t: number, eps: number): number {
  const a = eps - Math.abs(t);
  const b = -eps - Math.abs(t);
  const denom = cdf(a) - cdf(b);
  if (denom < 1e-9) return t < 0 ? -a : a; // extreme tail fallback
  const num = pdf(b) - pdf(a);
  const mag = num / denom;
  return t < 0 ? -mag : mag;
}

function wDraw(t: number, eps: number): number {
  const a = eps - Math.abs(t);
  const b = -eps - Math.abs(t);
  const denom = cdf(a) - cdf(b);
  if (denom < 1e-9) return 1.0;
  const mag = (pdf(b) - pdf(a)) / denom;
  return mag * mag + (a * pdf(a) - b * pdf(b)) / denom;
}

// Update a drawn two-player result. Symmetric in intent, but the higher-rated player loses a
// little rating (a draw underperforms their expectation) and the lower-rated gains a little.
export function updateDraw(a: Rating, b: Rating): { a: Rating; b: Rating } {
  const sa2 = a.sigma * a.sigma + TAU * TAU;
  const sb2 = b.sigma * b.sigma + TAU * TAU;
  const c = Math.sqrt(2 * BETA * BETA + sa2 + sb2);
  const t = (a.mu - b.mu) / c;
  const eps = DRAW_MARGIN / c;
  const v = vDraw(t, eps);
  const w = wDraw(t, eps);

  const muA = a.mu + (sa2 / c) * v;
  const muB = b.mu - (sb2 / c) * v;
  const sigA = Math.sqrt(Math.max(1e-4, sa2 * (1 - (sa2 / (c * c)) * w)));
  const sigB = Math.sqrt(Math.max(1e-4, sb2 * (1 - (sb2 / (c * c)) * w)));
  return { a: { mu: muA, sigma: sigA }, b: { mu: muB, sigma: sigB } };
}
