import { describe, expect, it } from 'vitest';
import { deriveBinanceQuote } from './binanceStream.js';

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
  });
});
