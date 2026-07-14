import { describe, expect, it, vi } from 'vitest';
import type { KalshiMarket, KalshiTrade } from '@nemesis/core';
import { ActiveTradeMarketResolver } from './activeTradeMarkets.js';

function trade(
  trade_id: string,
  ticker: string,
  count: number,
  yes_price: number,
  taker_side: 'yes' | 'no' = 'yes',
): KalshiTrade {
  return {
    trade_id,
    ticker,
    count,
    yes_price,
    no_price: 100 - yes_price,
    taker_side,
    created_time: '2026-07-13T23:00:00Z',
  };
}

function market(ticker: string, overrides: Partial<KalshiMarket> = {}): KalshiMarket {
  return {
    ticker,
    title: ticker,
    status: 'active',
    yes_bid: 48,
    yes_ask: 50,
    volume: 1_000,
    ...overrides,
  };
}

describe('ActiveTradeMarketResolver', () => {
  it('hydrates only the bounded highest-notional trade tickers in priority order', async () => {
    const fetchMarketFn = vi.fn(async (ticker: string) => market(ticker));
    const resolver = new ActiveTradeMarketResolver({
      fetchMarketFn,
      maxMarkets: 2,
      concurrency: 1,
      now: () => Date.parse('2026-07-13T23:00:30Z'),
    });

    const resolved = await resolver.resolve([
      { ...trade('stale', 'KXSTALE', 2_000, 50), created_time: '2026-07-13T22:00:00Z' },
      trade('medium', 'KXMEDIUM', 200, 50),
      trade('largest', 'KXLARGEST', 400, 50),
      trade('small', 'KXSMALL', 10, 50),
    ], []);

    expect(resolved.map((item) => item.ticker)).toEqual(['KXLARGEST', 'KXMEDIUM']);
    expect(fetchMarketFn.mock.calls.map(([ticker]) => ticker)).toEqual(['KXLARGEST', 'KXMEDIUM']);
  });

  it('reuses existing and cached metadata while filtering closed markets', async () => {
    let now = Date.parse('2026-07-13T23:00:30Z');
    const fetchMarketFn = vi.fn(async (ticker: string) => (
      ticker === 'KXCLOSED'
        ? market(ticker, { status: 'closed' })
        : market(ticker)
    ));
    const resolver = new ActiveTradeMarketResolver({
      fetchMarketFn,
      maxMarkets: 3,
      cacheTtlMs: 30_000,
      now: () => now,
    });
    const trades = [
      trade('existing', 'KXEXISTING', 500, 50),
      trade('fresh', 'KXFRESH', 400, 50),
      trade('closed', 'KXCLOSED', 300, 50),
    ];
    const existing = market('KXEXISTING');

    const first = await resolver.resolve(trades, [existing]);
    now += 5_000;
    const second = await resolver.resolve(trades, [existing]);

    expect(first.map((item) => item.ticker)).toEqual(['KXEXISTING', 'KXFRESH']);
    expect(second.map((item) => item.ticker)).toEqual(['KXEXISTING', 'KXFRESH']);
    expect(fetchMarketFn).toHaveBeenCalledTimes(2);
  });
});
