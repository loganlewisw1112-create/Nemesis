import { getKalshiEndpointPolicy, type KalshiEnvironment, type KalshiMarket } from '@nemesis/core';
import { isTradableMarketAt } from './marketLiveness.js';

/**
 * Sized against the twenty-second re-verification cycle that refreshes these
 * proofs. At 30s it carried only ten seconds of margin, and because a whole
 * tracked set is re-verified in one pass every record shares a verifiedAt and so
 * expires simultaneously: a single slow or failed cycle took verifiedTrackedTickers
 * from 25 to 0 in one step and gapped a readiness hold. 90s tolerates four
 * missed cycles while still proving the market was confirmed live very recently.
 */
export const DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS = 90_000;

export interface ProductionMarketProvenance {
  ticker: string;
  environment: 'production';
  status: string;
  sourceHost: string;
  verifiedAt: number;
  validUntil: number;
}

export interface ProductionMarketVerificationInput {
  market: KalshiMarket;
  environment: KalshiEnvironment;
  sourceBaseUrl: string;
  verifiedAt?: number;
  ttlMs?: number;
}

function normalizedHost(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

function isActiveAt(market: KalshiMarket, verifiedAt: number): boolean {
  // Delegates so discovery and provenance can never drift apart again.
  return isTradableMarketAt(market, verifiedAt);
}

/**
 * Creates a short-lived proof that a ticker came from an approved production
 * REST response and was active when observed. Callers must retain the source
 * base URL returned by the REST transport rather than inferring it from a
 * preferred endpoint.
 */
export function verifyProductionMarket(
  input: ProductionMarketVerificationInput,
): ProductionMarketProvenance | null {
  const ticker = input.market.ticker.trim();
  const verifiedAt = input.verifiedAt ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS;
  if (!ticker || input.environment !== 'production') return null;
  if (!Number.isSafeInteger(verifiedAt) || verifiedAt <= 0) return null;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return null;
  if (!isActiveAt(input.market, verifiedAt)) return null;

  const sourceHost = normalizedHost(input.sourceBaseUrl);
  if (!sourceHost) return null;
  const approvedHosts = new Set(
    getKalshiEndpointPolicy('production').restBaseUrls
      .map(normalizedHost)
      .filter((host): host is string => host != null),
  );
  if (!approvedHosts.has(sourceHost)) return null;

  return {
    ticker,
    environment: 'production',
    status: input.market.status,
    sourceHost,
    verifiedAt,
    validUntil: verifiedAt + ttlMs,
  };
}

export class ProductionMarketProvenanceStore {
  private readonly records = new Map<string, ProductionMarketProvenance>();

  record(input: ProductionMarketVerificationInput): ProductionMarketProvenance | null {
    const provenance = verifyProductionMarket(input);
    if (!provenance) {
      const ticker = input.market.ticker.trim();
      if (ticker) this.records.delete(ticker);
      return null;
    }
    this.records.set(provenance.ticker, provenance);
    return provenance;
  }

  recordMany(
    markets: KalshiMarket[],
    context: Omit<ProductionMarketVerificationInput, 'market'>,
  ): ProductionMarketProvenance[] {
    return markets
      .map((market) => this.record({ ...context, market }))
      .filter((record): record is ProductionMarketProvenance => record != null);
  }

  get(ticker: string, now = Date.now()): ProductionMarketProvenance | null {
    const record = this.records.get(ticker);
    if (!record) return null;
    if (now < record.verifiedAt || now > record.validUntil) return null;
    return record;
  }

  has(ticker: string, now = Date.now()): boolean {
    return this.get(ticker, now) != null;
  }

  selectVerified(tickers: Iterable<string>, limit: number, now = Date.now()): string[] {
    const selected: string[] = [];
    const seen = new Set<string>();
    for (const rawTicker of tickers) {
      const ticker = rawTicker.trim();
      if (!ticker || seen.has(ticker) || !this.has(ticker, now)) continue;
      seen.add(ticker);
      selected.push(ticker);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  delete(ticker: string): void {
    this.records.delete(ticker);
  }

  clear(): void {
    this.records.clear();
  }
}
