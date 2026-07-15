import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  kalshiFeeForOrder,
  kalshiFeeForFills,
  kalshiFeePerContract,
  buildKalshiFeePolicy,
  computeNetEdge,
  isSupportedQualificationFeeOrder,
  walkBookFill,
} from './kalshiFee.js';
import {
  isExecutablePrice,
  fetchMarkets,
  fetchTrades,
  fetchBalance,
  getKalshiHostHealth,
  getKalshiEndpointPolicy,
  KalshiRequestFailure,
  resetKalshiHostCache,
  normalizeExecutablePrice,
  parseOrderbook,
  normalizeMarketPrice,
  sanitizeExecutableBook,
} from '../kalshi/client.js';
import { qualifyThesis, detectSourceDisagreement } from '../thesis/qualification.js';
import type { KalshiMarket, KalshiOrderbook } from '../types.js';

describe('kalshiFee', () => {
  it('rounds the official trading fee to a centicent', () => {
    expect(kalshiFeePerContract(0.5)).toBe(0.0175);
  });

  it('rounds the aggregate order fee once', () => {
    expect(kalshiFeeForOrder(0.5, 100)).toBe(1.75);
    expect(kalshiFeeForOrder(0.5, 1)).toBe(0.0175);
  });

  it('accepts four-decimal prices and two-decimal quantities', () => {
    expect(isSupportedQualificationFeeOrder(0.5, 100)).toBe(true);
    expect(isSupportedQualificationFeeOrder(0.505, 100)).toBe(true);
    expect(isSupportedQualificationFeeOrder(0.5, 1.5)).toBe(true);
    expect(isSupportedQualificationFeeOrder(0.50555, 100)).toBe(false);
    expect(isSupportedQualificationFeeOrder(0.5, 1.005)).toBe(false);
  });

  it('applies maker/taker multipliers and non-direct balance rounding', () => {
    const taker = buildKalshiFeePolicy({ multiplier: 1, accountPrecision: 'non_direct' });
    const maker = buildKalshiFeePolicy({ role: 'maker', multiplier: 2, accountPrecision: 'direct' });
    expect(kalshiFeeForFills([{ price: 0.05, quantity: 100 }], taker)).toMatchObject({
      tradeFeeUsd: 0.3325,
      balanceRoundingFeeUsd: 0.0075,
      totalFeeUsd: 0.34,
    });
    expect(kalshiFeeForOrder(0.5, 100, maker)).toBe(0.875);
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
  beforeEach(() => {
    resetKalshiHostCache();
  });

  it('keeps production and demo endpoint policies isolated and excludes retired hosts', () => {
    const production = getKalshiEndpointPolicy('production');
    const demo = getKalshiEndpointPolicy('demo');
    expect(production.restBaseUrls[0]).toBe('https://external-api.kalshi.com/trade-api/v2');
    expect(production.websocketUrls[0]).toBe('wss://external-api-ws.kalshi.com/trade-api/ws/v2');
    expect(production.restBaseUrls.join(' ')).not.toContain('trading-api.kalshi.com');
    expect(production.restBaseUrls.some((url) => demo.restBaseUrls.includes(url))).toBe(false);
  });

  it('fails closed before contacting a retired production host', async () => {
    resetKalshiHostCache();
    const fetchFn = vi.fn<typeof fetch>();
    const failure = await fetchMarkets({
      baseUrl: 'https://trading-api.kalshi.com/trade-api/v2',
      fetchFn,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KalshiRequestFailure);
    expect(failure).toMatchObject({ classification: 'authorization', path: '(endpoint-policy)' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('classifies a timeout, evicts that host, and prefers the healthy alias next time', async () => {
    resetKalshiHostCache();
    const firstUrls: string[] = [];
    await fetchMarkets({
      limit: 1,
      fetchFn: vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        firstUrls.push(url);
        if (url.startsWith('https://external-api.kalshi.com')) throw new Error('request timed out');
        return new Response(JSON.stringify({ markets: [] }), { status: 200 });
      }),
    });
    expect(firstUrls).toHaveLength(2);
    expect(getKalshiHostHealth()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        baseUrl: 'https://external-api.kalshi.com/trade-api/v2',
        failureClass: 'timeout',
        failureCount: 1,
      }),
    ]));

    const nextUrls: string[] = [];
    await fetchMarkets({
      limit: 1,
      fetchFn: vi.fn<typeof fetch>(async (input) => {
        nextUrls.push(String(input));
        return new Response(JSON.stringify({ markets: [] }), { status: 200 });
      }),
    });
    expect(nextUrls[0]).toMatch(/^https:\/\/api\.elections\.kalshi\.com/);
  });

  it('learns working hosts per endpoint class instead of poisoning all requests', async () => {
    resetKalshiHostCache();
    const marketUrls: string[] = [];
    const marketFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      marketUrls.push(url);
      if (url.startsWith('https://external-api.kalshi.com')) throw new Error('fetch failed');
      return new Response(JSON.stringify({ markets: [] }), { status: 200 });
    });
    await fetchMarkets({ fetchFn: marketFetch, limit: 1 });

    const portfolioUrls: string[] = [];
    await fetchBalance({
      fetchFn: vi.fn<typeof fetch>(async (input) => {
        portfolioUrls.push(String(input));
        return new Response(JSON.stringify({ balance: 100, payout: 0 }), { status: 200 });
      }),
    });
    expect(marketUrls[1]).toMatch(/^https:\/\/api\.elections\.kalshi\.com/);
    expect(portfolioUrls[0]).toMatch(/^https:\/\/external-api\.kalshi\.com/);
  });

  it('classifies and exposes server-directed 429 backoff without host rotation', async () => {
    resetKalshiHostCache();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', {
      status: 429,
      headers: { 'Retry-After': '12' },
    }));
    const failure = await fetchTrades({ fetchFn }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KalshiRequestFailure);
    expect(failure).toMatchObject({ classification: 'rate_limit', status: 429, retryAfterMs: 12_000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

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
