import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMarkets } from './client.js';
import {
  recordKalshiCircuitFailure,
  resetKalshiProductionRetryCoordinatorForTests,
} from './retryCoordinator.js';

describe('Kalshi REST response provenance', () => {
  beforeEach(() => {
    resetKalshiProductionRetryCoordinatorForTests();
  });

  it('reports the exact successful production alias after fallback', async () => {
    const metadata = vi.fn();
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ markets: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    await fetchMarkets({ limit: 1, fetchFn, onResponseMetadata: metadata });

    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      environment: 'production',
      endpointClass: 'market-data',
      // The leading host rejected, so the alias is what actually answered.
      sourceBaseUrl: 'https://external-api.kalshi.com/trade-api/v2',
      status: 200,
    }));
  });

  it('surfaces a 401 immediately even while the shared circuit breaker is open', async () => {
    const now = Date.now();
    for (let i = 0; i < 8; i++) recordKalshiCircuitFailure('production', 'kalshi-ticker', now + i);

    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const started = Date.now();
    await expect(fetchMarkets({ limit: 1, fetchFn })).rejects.toMatchObject({ status: 401 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('passes series_ticker when seriesTicker is set', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ markets: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await fetchMarkets({ limit: 25, status: 'open', seriesTicker: 'KXBTCD', fetchFn });
    expect(fetchFn).toHaveBeenCalled();
    const url = String(fetchFn.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('series_ticker=KXBTCD');
    expect(url).toContain('status=open');
  });
});
