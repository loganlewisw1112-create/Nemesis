import { describe, expect, it } from 'vitest';
import { getKalshiEndpointPolicy, type KalshiMarket } from '@nemesis/core';
import { ProductionMarketProvenanceStore, verifyProductionMarket } from './productionMarketProvenance.js';

const market = (ticker: string, overrides: Partial<KalshiMarket> = {}): KalshiMarket => ({
  ticker,
  title: ticker,
  status: 'active',
  ...overrides,
});

describe('production market provenance', () => {
  const sourceBaseUrl = getKalshiEndpointPolicy('production').restBaseUrls[0]!;

  it('accepts only active markets observed from approved production REST hosts', () => {
    const verifiedAt = 1_700_000_000_000;
    expect(verifyProductionMarket({
      market: market('KX-LIVE'), environment: 'production', sourceBaseUrl, verifiedAt,
    })).toMatchObject({
      ticker: 'KX-LIVE',
      environment: 'production',
      sourceHost: new URL(sourceBaseUrl).host,
      verifiedAt,
    });
    expect(verifyProductionMarket({
      market: market('KX-DEMO'), environment: 'demo', sourceBaseUrl, verifiedAt,
    })).toBeNull();
    expect(verifyProductionMarket({
      market: market('KX-CLOSED', { status: 'closed' }), environment: 'production', sourceBaseUrl, verifiedAt,
    })).toBeNull();
    expect(verifyProductionMarket({
      market: market('KX-FIXTURE'), environment: 'production', sourceBaseUrl: 'https://fixture.invalid', verifiedAt,
    })).toBeNull();
  });

  it('rejects expired markets and expires cached provenance without treating it as fresh', () => {
    const verifiedAt = 1_700_000_000_000;
    const store = new ProductionMarketProvenanceStore();
    expect(store.record({
      market: market('KX-EXPIRED', { close_time: new Date(verifiedAt - 1).toISOString() }),
      environment: 'production', sourceBaseUrl, verifiedAt,
    })).toBeNull();
    store.record({ market: market('KX-LIVE'), environment: 'production', sourceBaseUrl, verifiedAt, ttlMs: 1_000 });
    expect(store.has('KX-LIVE', verifiedAt + 1_000)).toBe(true);
    expect(store.has('KX-LIVE', verifiedAt + 1_001)).toBe(false);
  });

  it('selects a bounded unique set and removes a prior proof after failed re-verification', () => {
    const verifiedAt = 1_700_000_000_000;
    const store = new ProductionMarketProvenanceStore();
    store.recordMany([market('KX-A'), market('KX-B'), market('KX-C')], {
      environment: 'production', sourceBaseUrl, verifiedAt,
    });
    expect(store.selectVerified(['KX-A', 'KX-A', 'KX-B', 'KX-C'], 2, verifiedAt)).toEqual(['KX-A', 'KX-B']);
    store.record({
      market: market('KX-A', { status: 'closed' }), environment: 'production', sourceBaseUrl, verifiedAt: verifiedAt + 1,
    });
    expect(store.has('KX-A', verifiedAt + 1)).toBe(false);
  });
});
