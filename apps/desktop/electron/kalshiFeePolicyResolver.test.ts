import { describe, expect, it } from 'vitest';
import { KalshiFeePolicyResolver } from './kalshiFeePolicyResolver.js';

describe('KalshiFeePolicyResolver', () => {
  it('resolves the market series multiplier with explicit account precision', async () => {
    const resolver = new KalshiFeePolicyResolver(
      () => 'non_direct',
      async (ticker) => ({ ticker, title: 'Test', status: 'open', series_ticker: 'KXSERIES' }),
      async (ticker) => ({ ticker, fee_type: 'quadratic', fee_multiplier: 1.25 }),
    );
    await expect(resolver.resolve('KXTEST', 1_000)).resolves.toMatchObject({
      known: true,
      role: 'taker',
      multiplier: 1.25,
      accountPrecision: 'non_direct',
      seriesTicker: 'KXSERIES',
    });
  });

  it('fails closed for unknown account precision or fee policy', async () => {
    const unknownAccount = new KalshiFeePolicyResolver(
      () => 'unknown',
      async (ticker) => ({ ticker, title: 'Test', status: 'open', series_ticker: 'KXSERIES' }),
      async (ticker) => ({ ticker, fee_type: 'quadratic', fee_multiplier: 1 }),
    );
    expect((await unknownAccount.resolve('KXTEST')).known).toBe(false);

    const unknownSeries = new KalshiFeePolicyResolver(
      () => 'direct',
      async (ticker) => ({ ticker, title: 'Test', status: 'open', series_ticker: 'KXSERIES' }),
      async (ticker) => ({ ticker, fee_type: 'unknown' }),
    );
    expect((await unknownSeries.resolve('KXTEST')).known).toBe(false);
  });

  it('resolves the current API shape through market event and series', async () => {
    const resolver = new KalshiFeePolicyResolver(
      () => 'non_direct',
      async (ticker) => ({
        ticker,
        title: 'Test',
        status: 'open',
        event_ticker: 'KXEVENT-26JUL15',
      }),
      async (ticker) => ({ ticker, fee_type: 'quadratic', fee_multiplier: 1 }),
      60_000,
      async (eventTicker) => ({ event_ticker: eventTicker, series_ticker: 'KXSERIES' }),
    );

    await expect(resolver.resolve('KXTEST', 1_000)).resolves.toMatchObject({
      known: true,
      multiplier: 1,
      accountPrecision: 'non_direct',
      seriesTicker: 'KXSERIES',
      source: 'market-and-series-api',
    });
  });
});
