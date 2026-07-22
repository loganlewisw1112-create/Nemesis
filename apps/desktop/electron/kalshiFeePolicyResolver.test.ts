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

  it('resolves quadratic_with_maker_fees, which charges takers identically', async () => {
    // Observed live 2026-07-22 on KXATPMATCH: the series reports this fee type,
    // the resolver failed it closed, and every candidate on such a series was
    // rejected at "account or series fee policy is unknown" before economics
    // were ever evaluated. Only makers are charged differently.
    const resolver = new KalshiFeePolicyResolver(
      () => 'non_direct',
      async (ticker) => ({ ticker, title: 'Test', status: 'open', series_ticker: 'KXATPMATCH' }),
      async (ticker) => ({ ticker, fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 }),
    );
    await expect(resolver.resolve('KXTEST', 1_000)).resolves.toMatchObject({
      known: true,
      role: 'taker',
      multiplier: 1,
      accountPrecision: 'non_direct',
      seriesTicker: 'KXATPMATCH',
      feeType: 'quadratic_with_maker_fees',
      source: 'market-and-series-api',
    });
  });

  it('still fails closed on an unrecognized quadratic-looking fee type', async () => {
    const resolver = new KalshiFeePolicyResolver(
      () => 'non_direct',
      async (ticker) => ({ ticker, title: 'Test', status: 'open', series_ticker: 'KXSERIES' }),
      async (ticker) => ({ ticker, fee_type: 'quadratic_with_something_new', fee_multiplier: 1 }),
    );
    expect((await resolver.resolve('KXTEST')).known).toBe(false);
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
