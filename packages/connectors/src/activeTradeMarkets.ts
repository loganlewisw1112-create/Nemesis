import {
  fetchMarket,
  type KalshiMarket,
  type KalshiTrade,
} from '@nemesis/core';
import {
  hasExecutableMarketQuote,
  marketLiquidityScore,
  selectKalshiTapeTickers,
} from './kalshiLiquidity.js';

const DEFAULT_MAX_MARKETS = 6;
const DEFAULT_MIN_TRADE_NOTIONAL_USD = 50;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TRADE_AGE_MS = 120_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

export interface ActiveTradeMarketResolverOptions {
  fetchMarketFn?: (ticker: string) => Promise<KalshiMarket>;
  maxMarkets?: number;
  minTradeNotionalUsd?: number;
  cacheTtlMs?: number;
  concurrency?: number;
  fetchTimeoutMs?: number;
  maxTradeAgeMs?: number;
  now?: () => number;
}

interface CachedMarket {
  market: KalshiMarket | null;
  fetchedAt: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function isActiveExecutableMarket(market: KalshiMarket): boolean {
  const status = market.status.toLowerCase();
  return (status === 'active' || status === 'open')
    && marketLiquidityScore(market) > 0
    && hasExecutableMarketQuote(market);
}

/**
 * Hydrates the highest-notional tickers from the global trade tape so NEMESIS
 * can run those exact markets through its existing orderbook/depth pipeline.
 * Successes and failures share a short cache to keep metadata requests paced.
 */
export class ActiveTradeMarketResolver {
  private readonly fetchMarketFn: (ticker: string) => Promise<KalshiMarket>;
  private readonly maxMarkets: number;
  private readonly minTradeNotionalUsd: number;
  private readonly cacheTtlMs: number;
  private readonly concurrency: number;
  private readonly maxTradeAgeMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedMarket>();

  constructor(options: ActiveTradeMarketResolverOptions = {}) {
    const fetchTimeoutMs = positiveInteger(options.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
    this.fetchMarketFn = options.fetchMarketFn ?? ((ticker) => fetchMarket(ticker, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
    }));
    this.maxMarkets = positiveInteger(options.maxMarkets, DEFAULT_MAX_MARKETS);
    this.minTradeNotionalUsd = options.minTradeNotionalUsd ?? DEFAULT_MIN_TRADE_NOTIONAL_USD;
    this.cacheTtlMs = positiveInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
    this.concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY);
    this.maxTradeAgeMs = positiveInteger(options.maxTradeAgeMs, DEFAULT_MAX_TRADE_AGE_MS);
    this.now = options.now ?? Date.now;
  }

  async resolve(trades: KalshiTrade[], existingMarkets: KalshiMarket[]): Promise<KalshiMarket[]> {
    const now = this.now();
    const recentTrades = trades.filter((trade) => {
      const tradedAt = Date.parse(trade.created_time);
      const ageMs = now - tradedAt;
      return Number.isFinite(tradedAt)
        && ageMs >= -MAX_FUTURE_CLOCK_SKEW_MS
        && ageMs <= this.maxTradeAgeMs;
    });
    const selectedTickers = selectKalshiTapeTickers([], recentTrades, {
      trackLimit: this.maxMarkets,
      orderbookLimit: this.maxMarkets,
      minTradeNotionalUsd: this.minTradeNotionalUsd,
    }).trackedTickers;
    if (selectedTickers.length === 0) return [];

    const existingByTicker = new Map(existingMarkets.map((market) => [market.ticker, market]));
    const resolvedByTicker = new Map<string, KalshiMarket>();
    const missing: string[] = [];

    for (const ticker of selectedTickers) {
      const existing = existingByTicker.get(ticker);
      if (existing) {
        resolvedByTicker.set(ticker, existing);
        continue;
      }
      const cached = this.cache.get(ticker);
      if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
        if (cached.market) resolvedByTicker.set(ticker, cached.market);
        continue;
      }
      missing.push(ticker);
    }

    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.concurrency, missing.length) },
      async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= missing.length) return;
          const ticker = missing[index];
          try {
            const market = await this.fetchMarketFn(ticker);
            this.cache.set(ticker, { market, fetchedAt: this.now() });
            resolvedByTicker.set(ticker, market);
          } catch {
            this.cache.set(ticker, { market: null, fetchedAt: this.now() });
          }
        }
      },
    );
    await Promise.all(workers);

    return selectedTickers
      .map((ticker) => resolvedByTicker.get(ticker))
      .filter((market): market is KalshiMarket => market != null && isActiveExecutableMarket(market));
  }
}
