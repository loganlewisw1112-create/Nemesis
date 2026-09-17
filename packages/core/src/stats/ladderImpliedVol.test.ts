import { describe, expect, it } from 'vitest';
import { normalCdf } from './normalCdf.js';
import {
  countUsableLadderQuotes,
  fitLadderImpliedVol,
  normalInvCdf,
  LADDER_MIN_R_SQUARED,
  type LadderQuote,
} from './ladderImpliedVol.js';

const SPOT = 118_000;

/** Prices a ladder exactly as a lognormal with the given total volatility would. */
function lognormalLadder(sigmaT: number, strikes: readonly number[], spot = SPOT): LadderQuote[] {
  return strikes.map((strike) => ({
    strike,
    marketPrice: normalCdf((Math.log(spot / strike) - 0.5 * sigmaT * sigmaT) / sigmaT),
  }));
}

const STRIKES = [112_000, 114_000, 116_000, 118_000, 120_000, 122_000, 124_000];

/**
 * A ladder that actually spans the distribution, the way a venue lists strikes.
 * A fixed-width ladder against a very small sigma pins every quote at 0 or 1 and
 * legitimately has nothing to fit.
 */
function spanningStrikes(sigmaT: number, spot = SPOT): number[] {
  return [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((k) => spot * Math.exp(k * sigmaT));
}

describe('normalInvCdf', () => {
  it('inverts normalCdf across the usable range', () => {
    for (const z of [-3, -2.5, -1.96, -1, -0.25, 0, 0.25, 1, 1.96, 2.5, 3]) {
      expect(normalInvCdf(normalCdf(z))).toBeCloseTo(z, 4);
    }
  });

  it('is undefined outside the open unit interval', () => {
    for (const p of [0, 1, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isNaN(normalInvCdf(p))).toBe(true);
    }
  });
});

describe('fitLadderImpliedVol', () => {
  it('recovers the volatility a lognormal ladder was generated from', () => {
    for (const sigmaT of [0.004, 0.01, 0.03, 0.08, 0.2]) {
      const strikes = spanningStrikes(sigmaT);
      const fit = fitLadderImpliedVol(SPOT, lognormalLadder(sigmaT, strikes));
      expect(fit).not.toBeNull();
      expect(fit!.sigmaT).toBeCloseTo(sigmaT, 6);
      expect(fit!.rSquared).toBeGreaterThan(0.999);
    }
  });

  it('starves on a thin sample of a wide ladder that fits whole [production dormancy]', () => {
    // The defect measured 2026-07-31: the caller passed the depth-filtered signal
    // slice instead of the market set, so the model saw 8 strikes of an 80-strike
    // ladder and produced 0 fits across 23 confirmations — every one of which HAD
    // reached the model. The gate was not mis-tuned, it was starved.
    //
    // The mechanism is the interaction of ladder width with sigma, not the raw
    // count. A venue lists strikes far past the distribution: at the measured
    // sigmaT of 0.0095 on spot 62,998, one sigma is ~$600, so a ladder spanning
    // 53k-73k is +/-16 sigma and only ~11 of its 80 quotes sit off the rails.
    // Sample 8 of those 80 and you almost surely draw fewer than the 3 the
    // regression needs.
    const sigmaT = 0.009542;
    const spot = 62_998;
    const strikes = Array.from({ length: 80 }, (_unused, i) => 53_000 + i * 250);
    const whole = lognormalLadder(sigmaT, strikes, spot);

    const usableWhole = whole.filter((q) => q.marketPrice >= 0.02 && q.marketPrice <= 0.98);
    // Matches the live ladder: 80 quotes, a small minority of them informative.
    expect(usableWhole.length).toBeLessThan(20);
    const fitWhole = fitLadderImpliedVol(spot, whole);
    expect(fitWhole).not.toBeNull();
    expect(fitWhole!.sigmaT).toBeCloseTo(sigmaT, 4);

    // Every evenly-spaced 8-strike sample of that same ladder starves.
    let starved = 0;
    for (let offset = 0; offset < 10; offset += 1) {
      const sample = whole.filter((_unused, i) => i % 10 === offset);
      expect(sample).toHaveLength(8);
      if (fitLadderImpliedVol(spot, sample) === null) starved += 1;
    }
    expect(starved).toBe(10);
  });

  it('cannot fit a mixture of expiries, however many quotes it holds', () => {
    // Measured 2026-07-31: the caller keyed ladders on `close_time ?? ''`, and
    // `close_time` is optional, so every market lacking one collapsed into a single
    // bucket -- 189 quotes drawn from three different expiries. Supply looked
    // healthy and the fit still refused, because a mixture of expiries is not a
    // lognormal at any one volatility. Quote count alone cannot detect this; the
    // R-squared floor is what catches it.
    const spot = 62_998;
    const mixture = [
      ...lognormalLadder(0.0095, spanningStrikes(0.0095, spot), spot),
      ...lognormalLadder(0.0530, spanningStrikes(0.0530, spot), spot),
      ...lognormalLadder(0.1200, spanningStrikes(0.1200, spot), spot),
    ];
    expect(mixture.length).toBeGreaterThan(20);
    expect(countUsableLadderQuotes(spot, mixture)).toBeGreaterThan(10);
    expect(fitLadderImpliedVol(spot, mixture)).toBeNull();

    // Each expiry on its own fits cleanly.
    for (const sigmaT of [0.0095, 0.0530, 0.1200]) {
      const fit = fitLadderImpliedVol(spot, lognormalLadder(sigmaT, spanningStrikes(sigmaT, spot), spot));
      expect(fit).not.toBeNull();
      expect(fit.sigmaT).toBeCloseTo(sigmaT, 5);
    }
  });

  it('separates a starved ladder from a pinned one', () => {
    const spot = 62_998;
    const pinned = lognormalLadder(0.004, STRIKES, spot);
    // Plenty supplied, almost none usable: pinned at the rails.
    expect(pinned.length).toBe(STRIKES.length);
    expect(countUsableLadderQuotes(spot, pinned)).toBeLessThan(3);
    // Nothing supplied at all is a different problem with the same fit outcome.
    expect(countUsableLadderQuotes(spot, [])).toBe(0);
  });

  it('reports no fit when a fixed-width ladder pins at the rails', () => {
    // Near expiry the distribution collapses inside one strike increment, so the
    // ladder carries no information about volatility. Saying so beats inventing a
    // number from the two quotes that happen to survive.
    expect(fitLadderImpliedVol(SPOT, lognormalLadder(0.004, STRIKES))).toBeNull();
  });

  it('survives one-cent quote granularity', () => {
    const sigmaT = 0.03;
    const rounded = lognormalLadder(sigmaT, STRIKES)
      .map((quote) => ({ ...quote, marketPrice: Math.round(quote.marketPrice * 100) / 100 }));
    const fit = fitLadderImpliedVol(SPOT, rounded);
    expect(fit).not.toBeNull();
    expect(fit!.sigmaT / sigmaT).toBeGreaterThan(0.9);
    expect(fit!.sigmaT / sigmaT).toBeLessThan(1.1);
    expect(fit!.rSquared).toBeGreaterThan(LADDER_MIN_R_SQUARED);
  });

  it('drops quotes pinned at the rails rather than letting them dominate', () => {
    const sigmaT = 0.03;
    const withRails: LadderQuote[] = [
      { strike: 60_000, marketPrice: 1 },
      { strike: 80_000, marketPrice: 0.995 },
      ...lognormalLadder(sigmaT, STRIKES),
      { strike: 200_000, marketPrice: 0 },
    ];
    const fit = fitLadderImpliedVol(SPOT, withRails);
    expect(fit).not.toBeNull();
    expect(fit!.points).toBe(STRIKES.length);
    expect(fit!.sigmaT).toBeCloseTo(sigmaT, 6);
  });

  it('counts a repeated strike once', () => {
    const ladder = lognormalLadder(0.03, STRIKES);
    const fit = fitLadderImpliedVol(SPOT, [...ladder, ...ladder]);
    expect(fit?.points).toBe(STRIKES.length);
  });

  it('returns null rather than a number it cannot support', () => {
    const ladder = lognormalLadder(0.03, STRIKES);
    // Too few usable quotes.
    expect(fitLadderImpliedVol(SPOT, ladder.slice(0, 2))).toBeNull();
    expect(fitLadderImpliedVol(SPOT, [])).toBeNull();
    // No spread in the quotes: every strike at the same price carries no slope.
    expect(fitLadderImpliedVol(SPOT, STRIKES.map((strike) => ({ strike, marketPrice: 0.5 })))).toBeNull();
    // Unusable spot.
    expect(fitLadderImpliedVol(0, ladder)).toBeNull();
    expect(fitLadderImpliedVol(Number.NaN, ladder)).toBeNull();
  });

  it('rejects a ladder priced backwards instead of reporting a negative volatility', () => {
    const inverted = lognormalLadder(0.03, STRIKES)
      .map((quote, index, all) => ({ ...quote, marketPrice: all[all.length - 1 - index]!.marketPrice }));
    expect(fitLadderImpliedVol(SPOT, inverted)).toBeNull();
  });

  it('rejects a ladder too noisy to read a volatility off', () => {
    const noisy = lognormalLadder(0.03, STRIKES).map((quote, index) => ({
      ...quote,
      // Alternating ±0.15 swamps a 0.03 ladder's own price range.
      marketPrice: Math.min(0.97, Math.max(0.03, quote.marketPrice + (index % 2 === 0 ? 0.15 : -0.15))),
    }));
    const fit = fitLadderImpliedVol(SPOT, noisy);
    if (fit) expect(fit.rSquared).toBeGreaterThanOrEqual(LADDER_MIN_R_SQUARED);
    else expect(fit).toBeNull();
  });
});
