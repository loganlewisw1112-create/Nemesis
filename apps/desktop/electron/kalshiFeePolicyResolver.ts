import {
  UNKNOWN_KALSHI_FEE_POLICY,
  buildKalshiFeePolicy,
  fetchMarket,
  fetchSeries,
  type KalshiAccountPrecision,
  type KalshiFeePolicy,
  type KalshiMarket,
  type KalshiSeries,
} from '@nemesis/core';

type MarketFetcher = (ticker: string) => Promise<KalshiMarket>;
type SeriesFetcher = (seriesTicker: string) => Promise<KalshiSeries>;

interface CacheEntry {
  policy: KalshiFeePolicy;
  expiresAt: number;
}

export class KalshiFeePolicyResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly accountPrecision: () => KalshiAccountPrecision,
    private readonly marketFetcher: MarketFetcher = fetchMarket,
    private readonly seriesFetcher: SeriesFetcher = fetchSeries,
    private readonly cacheTtlMs = 5 * 60_000,
  ) {}

  clear(): void {
    this.cache.clear();
  }

  async resolve(ticker: string, now = Date.now()): Promise<KalshiFeePolicy> {
    const cached = this.cache.get(ticker);
    if (cached && cached.expiresAt > now) return cached.policy;
    try {
      const market = await this.marketFetcher(ticker);
      const seriesTicker = market.series_ticker;
      if (!seriesTicker) return this.remember(ticker, UNKNOWN_KALSHI_FEE_POLICY, now);
      const series = await this.seriesFetcher(seriesTicker);
      const feeType = market.fee_type_override ?? market.fee_type ?? series.fee_type;
      const waiverEndsAt = market.fee_waiver_expiration_time
        ? Date.parse(market.fee_waiver_expiration_time)
        : Number.NaN;
      const multiplier = Number.isFinite(waiverEndsAt) && waiverEndsAt > now
        ? 0
        : market.fee_multiplier_override ?? market.fee_multiplier ?? series.fee_multiplier;
      if (feeType !== 'quadratic' || !Number.isFinite(multiplier)) {
        return this.remember(ticker, {
          ...UNKNOWN_KALSHI_FEE_POLICY,
          seriesTicker,
          feeType,
          source: 'market-and-series-api-unresolved',
        }, now);
      }
      return this.remember(ticker, buildKalshiFeePolicy({
        role: 'taker',
        multiplier,
        accountPrecision: this.accountPrecision(),
        seriesTicker,
        feeType,
        source: 'market-and-series-api',
      }), now);
    } catch {
      return this.remember(ticker, { ...UNKNOWN_KALSHI_FEE_POLICY }, now);
    }
  }

  private remember(ticker: string, policy: KalshiFeePolicy, now: number): KalshiFeePolicy {
    this.cache.set(ticker, { policy, expiresAt: now + this.cacheTtlMs });
    return policy;
  }
}
