// Minimal TrueSkill (Microsoft's Bayesian skill rating) for the poker ladder. Each
// agent carries a rating (mu, sigma): mu is the skill estimate, sigma the uncertainty.
// A two-player result nudges the winner's mu up and the loser's down, and shrinks both
// sigmas (we learned something); an N-player table applies the same update pairwise
// along the final ranking. The ladder ranks by the CONSERVATIVE rating (mu - 3*sigma),
// so a top spot needs both a high skill estimate and enough games to be confident —
// which is exactly what makes a laddered tier gradient (a level-5 bot climbing past a
// level-0 one over a season) provable rather than a lucky streak.

export const TS_MU0 = 25;
export const TS_SIGMA0 = 25 / 3; // ~8.3333
const BETA = TS_SIGMA0 / 2; // skill-class width: the mu gap that is one "class"
const TAU = TS_SIGMA0 / 100; // per-game dynamics; keeps sigma from freezing at zero
const SQRT2PI = Math.sqrt(2 * Math.PI);

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
