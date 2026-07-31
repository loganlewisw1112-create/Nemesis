import { describe, expect, it } from 'vitest';
import { deriveBinanceQuote, realizedVolPerRootSec } from './binanceStream.js';

interface Sample { price: number; fetchedAt: number }

/**
 * A deterministic random walk with a known volatility per square-root second,
 * sampled on whatever gaps are asked for. Deterministic so the assertions are
 * about the estimator rather than about a seed.
 */
function walk(sigmaPerRootSec: number, gapsMs: readonly number[], startPrice = 100_000): Sample[] {
  let seed = 12_345;
  const next = (): number => {
    // Box-Muller on a small LCG.
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const u1 = (seed + 1) / 2_147_483_649;
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const u2 = (seed + 1) / 2_147_483_649;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const samples: Sample[] = [{ price: startPrice, fetchedAt: 0 }];
  let at = 0;
  let price = startPrice;
  for (const gapMs of gapsMs) {
    at += gapMs;
    price *= Math.exp(sigmaPerRootSec * Math.sqrt(gapMs / 1000) * next());
    samples.push({ price, fetchedAt: at });
  }
  return samples;
}

describe('deriveBinanceQuote', () => {
  it('preserves sub-tenth-bps rolling volatility for probability models', () => {
    const fetchedAt = 1_000;
    const quote = deriveBinanceQuote('BTCUSDT', 100.0006, 0, fetchedAt, [
      { price: 100, fetchedAt: fetchedAt - 3_000 },
      { price: 100.0005, fetchedAt: fetchedAt - 2_000 },
      { price: 100.0002, fetchedAt: fetchedAt - 1_000 },
      { price: 100.0006, fetchedAt },
    ]);

    expect(quote.sampleCount).toBe(4);
    expect(quote.volatilityBps).toBeGreaterThan(0);
    expect(quote.volatilityBps).toBeLessThan(0.1);
    expect(quote.sigmaPerRootSec).toBeGreaterThan(0);
  });
});

describe('realizedVolPerRootSec', () => {
  it('recovers the volatility of a walk sampled on a uniform grid', () => {
    const sigma = 0.0004;
    const estimate = realizedVolPerRootSec(walk(sigma, Array.from({ length: 400 }, () => 5_000)));
    expect(estimate / sigma).toBeGreaterThan(0.85);
    expect(estimate / sigma).toBeLessThan(1.15);
  });

  it('recovers the same volatility when the spacing is wildly irregular', () => {
    // The real window: a sub-second websocket interleaved with a 5s REST poll.
    // Bursts of fast ticks between slow ones, which is what breaks any estimator
    // that assumes uniform spacing.
    const sigma = 0.0004;
    const gaps: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      gaps.push(1_100, 1_200, 1_050, 5_000, 1_400, 5_000);
    }
    const estimate = realizedVolPerRootSec(walk(sigma, gaps));
    expect(estimate / sigma).toBeGreaterThan(0.85);
    expect(estimate / sigma).toBeLessThan(1.15);
  });

  it('gives the same answer for the same process at two different sampling rates', () => {
    // The property the old estimator lacked: its output was a per-sample number,
    // so doubling the sample rate halved it. This one is per unit time.
    const sigma = 0.0004;
    const slow = realizedVolPerRootSec(walk(sigma, Array.from({ length: 300 }, () => 8_000)));
    const fast = realizedVolPerRootSec(walk(sigma, Array.from({ length: 300 }, () => 1_000)));
    expect(slow / fast).toBeGreaterThan(0.75);
    expect(slow / fast).toBeLessThan(1.33);
  });

  it('is not inflated by sub-second bid-ask bounce', () => {
    // A dead-flat underlying quoted with a one-tick bounce every 100ms. Dividing
    // those returns by their own tiny gaps would report enormous volatility;
    // sparse-sampling to a 1s grid sees a flat series instead.
    const samples: Sample[] = Array.from({ length: 600 }, (_unused, index) => ({
      price: 100_000 + (index % 2 === 0 ? 0 : 5),
      fetchedAt: index * 100,
    }));
    const bounced = realizedVolPerRootSec(samples);
    const clean = realizedVolPerRootSec(
      Array.from({ length: 60 }, (_unused, index) => ({ price: 100_000, fetchedAt: index * 1_000 })),
    );
    expect(clean).toBe(0);
    // 10 bps of bounce over 100ms is ~0.0016/sqrt(s) if taken at face value.
    expect(bounced).toBeLessThan(0.0002);
  });

  it('returns zero rather than a guess when the window cannot support an estimate', () => {
    expect(realizedVolPerRootSec([])).toBe(0);
    expect(realizedVolPerRootSec([{ price: 100, fetchedAt: 0 }])).toBe(0);
    // Three samples inside one second collapse to one after sparse-sampling.
    expect(realizedVolPerRootSec([
      { price: 100, fetchedAt: 0 },
      { price: 101, fetchedAt: 100 },
      { price: 102, fetchedAt: 200 },
    ])).toBe(0);
    // Non-positive and non-finite prices are dropped, not logged.
    expect(realizedVolPerRootSec([
      { price: 0, fetchedAt: 0 },
      { price: -1, fetchedAt: 1_000 },
      { price: Number.NaN, fetchedAt: 2_000 },
    ])).toBe(0);
  });

  it('weights a long gap by its own length, not as one more sample', () => {
    // One 60s gap carrying a 1% move, versus the same move over 1s. The
    // per-second volatility must differ by sqrt(60), and a spacing-blind
    // estimator would call them identical.
    const base = { price: 100_000, fetchedAt: 0 };
    const slow = realizedVolPerRootSec([
      base,
      { price: 101_000, fetchedAt: 60_000 },
      { price: 101_000, fetchedAt: 120_000 },
    ]);
    const fast = realizedVolPerRootSec([
      base,
      { price: 101_000, fetchedAt: 1_000 },
      { price: 101_000, fetchedAt: 2_000 },
    ]);
    expect(fast / slow).toBeCloseTo(Math.sqrt(60), 1);
  });
});
