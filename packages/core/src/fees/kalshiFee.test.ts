import { describe, expect, it, vi } from 'vitest';
import { kalshiFeePerContract, computeNetEdge, walkBookFill } from './kalshiFee.js';
import {
  isExecutablePrice,
  fetchMarkets,
  fetchTrades,
  normalizeExecutablePrice,
  parseOrderbook,
  normalizeMarketPrice,
  sanitizeExecutableBook,
} from '../kalshi/client.js';
import { qualifyThesis, detectSourceDisagreement } from '../thesis/qualification.js';
import type { KalshiMarket, KalshiOrderbook } from '../types.js';

describe('kalshiFee', () => {
  it('computes fee at 50c', () => {
    expect(kalshiFeePerContract(0.5)).toBe(0.02);
  });

  it('computes net edge with costs', () => {
    const r = computeNetEdge(0.4, 0.3, 0.04);
    expect(r.grossEdge).toBeCloseTo(0.1);
    expect(r.netEdge).toBeLessThan(r.grossEdge);
  });

  it('walks book for fill', () => {
    const r = walkBookFill(
      [
        { price: 0.3, quantity: 10 },
        { price: 0.32, quantity: 10 },
      ],
      15,
    );
    expect(r?.filled).toBe(15);
    expect(r!.slippage).toBeGreaterThan(0);
  });
});

describe('kalshi client', () => {
  it('parses bid-only orderbook with derived asks', () => {
    const ob = parseOrderbook('TEST', {
      orderbook: { yes: [[54, 100]], no: [[40, 50]] },
    });
    expect(ob.yesAsk).toBeCloseTo(0.6);
    expect(ob.spread).toBeDefined();
  });

  it('parses orderbook_fp dollar-string levels as executable depth', () => {
    const ob = parseOrderbook('TEST', {
      orderbook_fp: {
        no_dollars: [['0.9790', '5000.00'], ['0.9880', '92.00']],
        yes_dollars: [],
      },
    });

    expect(ob.no).toEqual([
      { price: 0.988, quantity: 92 },
      { price: 0.979, quantity: 5000 },
    ]);
    expect(ob.yesAsk).toBeCloseTo(0.012);
    expect(sanitizeExecutableBook(ob).no).toHaveLength(2);
  });

  it('normalizes cent market prices', () => {
    const m: KalshiMarket = { ticker: 'T', title: 'T', status: 'open', yes_ask: 34 };
    expect(normalizeMarketPrice(m)).toBeCloseTo(0.34);
  });

  it('normalizes current fixed-point market liquidity at the REST boundary', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      markets: [{
        ticker: 'KXBTC15M-26JUL131915-15',
        title: 'Bitcoin price in fifteen minutes',
        status: 'active',
        yes_bid_dollars: '0.8300',
        yes_ask_dollars: '0.8400',
        volume_fp: '896616.69',
        volume_24h_fp: '157179.24',
        open_interest_fp: '12450.50',
      }],
      cursor: 'next-page',
    }), { status: 200 }));

    await expect(fetchMarkets({ fetchFn, limit: 1 })).resolves.toMatchObject({
      markets: [{
        ticker: 'KXBTC15M-26JUL131915-15',
        volume: 896616.69,
        volume_24h: 157179.24,
        open_interest: 12450.5,
      }],
      cursor: 'next-page',
    });
  });

  it('rejects non-executable prices instead of treating zero as tradable', () => {
    expect(isExecutablePrice(0)).toBe(false);
    expect(isExecutablePrice(1)).toBe(false);
    expect(isExecutablePrice(Number.NaN)).toBe(false);
    expect(isExecutablePrice(0.34)).toBe(true);

    const zeroAsk: KalshiMarket = { ticker: 'T', title: 'T', status: 'open', yes_ask: 0 };
    expect(normalizeExecutablePrice(zeroAsk)).toBeNull();
  });

  it('sanitizes executable books and removes invalid synthetic levels', () => {
    const book: KalshiOrderbook = {
      ticker: 'T',
      yes: [
        { price: 0, quantity: 100 },
        { price: 0.42, quantity: 25 },
        { price: 1, quantity: 10 },
      ],
      no: [
        { price: 0.58, quantity: 0 },
        { price: 0.57, quantity: 30 },
      ],
      yesAsk: 0,
      noAsk: 0.57,
      spread: 0.02,
    };

    const sanitized = sanitizeExecutableBook(book);
    expect(sanitized.yes).toEqual([{ price: 0.42, quantity: 25 }]);
    expect(sanitized.no).toEqual([{ price: 0.57, quantity: 30 }]);
    expect(sanitized.yesAsk).toBeUndefined();
    expect(sanitized.noAsk).toBe(0.57);
  });

  it('does not multiply a 429 across fallback API hosts', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));

    await expect(fetchTrades({ fetchFn })).rejects.toThrow('Kalshi API 429');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('normalizes the current fixed-point trade response into cent-based internal trades', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      trades: [{
        trade_id: 'tr-current',
        ticker: 'KXBTC15M-26JUL131315-15',
        count_fp: '5.37',
        yes_price_dollars: '0.9540',
        no_price_dollars: '0.0460',
        taker_outcome_side: 'yes',
        taker_book_side: 'bid',
        created_time: '2026-07-13T17:10:24Z',
      }],
      cursor: 'next-page',
    }), { status: 200 }));

    await expect(fetchTrades({ fetchFn, limit: 1 })).resolves.toEqual({
      trades: [{
        trade_id: 'tr-current',
        ticker: 'KXBTC15M-26JUL131315-15',
        yes_price: 95.4,
        no_price: 4.6,
        count: 5.37,
        taker_side: 'yes',
        created_time: '2026-07-13T17:10:24Z',
      }],
      cursor: 'next-page',
    });
  });

  it('keeps legacy cent-based trade responses compatible', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      trades: [{
        trade_id: 'tr-legacy',
        ticker: 'KXLEGACY',
        count: 12,
        yes_price: 47,
        no_price: 53,
        taker_side: 'no',
        created_time: '2026-06-25T12:00:00Z',
      }],
    }), { status: 200 }));

    await expect(fetchTrades({ fetchFn })).resolves.toMatchObject({
      trades: [{ yes_price: 47, no_price: 53, count: 12, taker_side: 'no' }],
    });
  });

  it('rejects an unsupported non-empty trade payload instead of reporting a healthy empty tape', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      trades: [{ ticker: 'KXBROKEN', count_fp: '10.00' }],
    }), { status: 200 }));

    await expect(fetchTrades({ fetchFn })).rejects.toThrow('Kalshi trade payload contained no valid records');
  });
});

describe('qualification', () => {
  it('marks tradeable when all gates pass', () => {
    const r = qualifyThesis({
      impliedPrice: 0.45,
      marketPrice: 0.3,
      spread: 0.04,
      depthUsd: 500,
      predictability: 75,
      freshnessMs: 5000,
      sourceAgreement: 0.9,
      regimeBlocked: false,
      concentrationBlocked: false,
      executionHealthy: true,
    });
    expect(r.status).toBe('tradeable');
  });

  it('downgrades on disagreement', () => {
    const d = detectSourceDisagreement(
      [{ value: 91 }, { value: 95 }],
      2,
    );
    expect(d.disagree).toBe(true);
  });
});
