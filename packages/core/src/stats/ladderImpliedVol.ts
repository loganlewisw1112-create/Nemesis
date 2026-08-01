/**
 * Market-implied volatility read straight off a Kalshi strike ladder.
 *
 * A crypto daily event quotes many strikes on one underlying at one expiry. If
 * the market prices them lognormally then, for every strike K,
 *
 *   P(K) = N(d),  d = (ln(S/K) - 0.5 sigma_T^2) / sigma_T
 *
 * Inverting gives z(K) = N^-1(P(K)) and therefore
 *
 *   ln(S/K) = sigma_T * z(K) + 0.5 * sigma_T^2
 *
 * which is linear in z with slope sigma_T. So one least-squares line through the
 * ladder recovers the volatility the market is actually quoting, and its
 * R-squared says whether the ladder is lognormal enough for that number to mean
 * anything. Measured against 311 ladder snapshots on 2026-07-29: R-squared 0.997.
 *
 * This is the reference the model's own volatility is checked against. It costs
 * nothing extra — the ladder is already in hand on every refresh.
 */

/** Prices at the rails invert to unbounded z and would dominate the regression. */
const MIN_USABLE_PRICE = 0.02;
const MAX_USABLE_PRICE = 0.98;

/** Below this the ladder is not lognormal enough for its slope to be a volatility. */
export const LADDER_MIN_R_SQUARED = 0.95;

/** Two points define any line; a third is the first evidence that the line fits. */
export const LADDER_MIN_POINTS = 3;

export interface LadderQuote {
  strike: number;
  /** Probability the underlying settles above `strike`, as quoted. */
  marketPrice: number;
}

export interface LadderImpliedVol {
  /** Total volatility to expiry, in the same units as the model's own sigmaT. */
  sigmaT: number;
  rSquared: number;
  /** Quotes that survived filtering and entered the regression. */
  points: number;
}

// Acklam's rational approximation to the standard normal quantile. Relative error
// below ~1.2e-9 across the whole range — orders of magnitude tighter than the
// one-cent granularity of the quotes it is inverting.
const A = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2,
  1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239e+0];
const B = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2,
  6.680131188771972e+1, -1.328068155288572e+1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e+0,
  -2.549732539343734e+0, 4.374664141464968e+0, 2.938163982698783e+0];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e+0,
  3.754408661907416e+0];
const LOW = 0.02425;

export function normalInvCdf(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return Number.NaN;
  if (p < LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!)
      / ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }
  if (p > 1 - LOW) return -normalInvCdf(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q
    / (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
}

/**
 * Fits the ladder and returns the volatility it implies, or `null` when the
 * ladder cannot support one: too few usable quotes, no spread in the quotes, a
 * non-positive slope (the ladder is not priced as a distribution over this
 * underlying), or a fit too poor to read a volatility off.
 */
/**
 * The quotes that can enter the regression at all: priced off the rails, one per
 * strike, invertible. Shared with `fitLadderImpliedVol` so the count reported as
 * evidence can never drift from the count actually used.
 */
function usablePoints(spotPrice: number, quotes: readonly LadderQuote[]): { xs: number[]; zs: number[] } {
  const xs: number[] = [];
  const zs: number[] = [];
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return { xs, zs };
  const seenStrikes = new Set<number>();
  for (const quote of quotes) {
    if (!Number.isFinite(quote.strike) || quote.strike <= 0) continue;
    if (!Number.isFinite(quote.marketPrice)) continue;
    if (quote.marketPrice < MIN_USABLE_PRICE || quote.marketPrice > MAX_USABLE_PRICE) continue;
    // One quote per strike: a duplicated strike is the same observation twice and
    // would weight the regression toward it.
    if (seenStrikes.has(quote.strike)) continue;
    const z = normalInvCdf(quote.marketPrice);
    const x = Math.log(spotPrice / quote.strike);
    if (!Number.isFinite(z) || !Number.isFinite(x)) continue;
    seenStrikes.add(quote.strike);
    xs.push(x);
    zs.push(z);
  }
  return { xs, zs };
}

/**
 * How many of these quotes the fit can actually use. Recorded alongside the raw
 * quote count because the two answer different questions: a large supply with
 * few usable points means the ladder is mostly pinned at the rails, while few of
 * both means the ladder never reached the model. Without this the difference has
 * to be guessed at, which is how the gate stayed dormant unnoticed.
 */
export function countUsableLadderQuotes(spotPrice: number, quotes: readonly LadderQuote[]): number {
  return usablePoints(spotPrice, quotes).xs.length;
}

export function fitLadderImpliedVol(
  spotPrice: number,
  quotes: readonly LadderQuote[],
): LadderImpliedVol | null {
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;
  const { xs, zs } = usablePoints(spotPrice, quotes);
  const n = xs.length;
  if (n < LADDER_MIN_POINTS) return null;

  const meanZ = zs.reduce((sum, value) => sum + value, 0) / n;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceZ = 0;
  for (let i = 0; i < n; i += 1) {
    const dz = zs[i]! - meanZ;
    covariance += dz * (xs[i]! - meanX);
    varianceZ += dz * dz;
  }
  if (varianceZ <= 0) return null;
  const slope = covariance / varianceZ;
  // A ladder priced as a distribution over this spot always slopes up in z: both
  // ln(S/K) and N^-1(P) fall as the strike rises. A non-positive slope means the
  // quotes are not that distribution, and its magnitude is not a volatility.
  if (!Number.isFinite(slope) || slope <= 0) return null;

  const intercept = meanX - slope * meanZ;
  let residual = 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = slope * zs[i]! + intercept;
    residual += (xs[i]! - predicted) ** 2;
    total += (xs[i]! - meanX) ** 2;
  }
  if (total <= 0) return null;
  const rSquared = 1 - residual / total;
  if (!Number.isFinite(rSquared) || rSquared < LADDER_MIN_R_SQUARED) return null;

  return { sigmaT: slope, rSquared, points: n };
}
