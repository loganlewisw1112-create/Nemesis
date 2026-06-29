import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KalshiTrade } from '@nemesis/core';
import { tradeToThesis } from '@nemesis/pods';
import { FeedHub } from './FeedHub.js';
import { ConnectorRegistry } from './registry.js';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeHub(fetchFn: typeof fetch) {
  const registry = new ConnectorRegistry();
  const hub = new FeedHub(registry, { fetchFn });
  hub.stopBackgroundPolling();
  return { hub, registry };
}

async function refreshTrades(hub: FeedHub) {
  await (hub as unknown as { refreshTrades(): Promise<void> }).refreshTrades();
}

describe('FeedHub trade tape degradation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-27T12:00:00.000Z'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not open Binance websocket during construction', () => {
    const openedUrls: string[] = [];
    class FakeWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(url: string) {
        openedUrls.push(url);
      }

      send() {}
      close() {
        this.onclose?.();
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const hub = new FeedHub(new ConnectorRegistry(), { fetchFn: vi.fn<typeof fetch>() });
    hub.stopBackgroundPolling();

    expect(openedUrls).toEqual([]);
  });

  it('backs off optional trade failures and exposes degraded state without repeated warnings', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('fetch failed: /markets/trades'));
    const { hub, registry } = makeHub(fetchFn);

    await refreshTrades(hub);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(hub.getTradeFeedState()).toMatchObject({
      status: 'degraded',
      failureCount: 1,
      lastError: 'fetch failed: /markets/trades',
      cachedTradeCount: 0,
    });
    expect(hub.getTradeFeedState().nextRetryAt).toBeGreaterThan(Date.now());
    expect(registry.get('kalshi-trades')).toMatchObject({
      status: 'warn',
      lastError: expect.stringContaining('Trade tape degraded'),
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await refreshTrades(hub);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps cached trade-derived theses usable after a later trade fetch failure', async () => {
    const whaleTrade: KalshiTrade = {
      trade_id: 'tr-1',
      ticker: 'KXDEMO',
      yes_price: 64,
      no_price: 36,
      count: 100,
      taker_side: 'yes',
      created_time: '2026-06-27T11:59:00.000Z',
    };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ trades: [whaleTrade] }))
      .mockRejectedValue(new Error('fetch failed: trade endpoint timeout'));
    const { hub } = makeHub(fetchFn);

    await refreshTrades(hub);
    expect(tradeToThesis(hub.getTradesForTicker('KXDEMO')[0], {
      ticker: 'KXDEMO',
      title: 'Demo market',
      status: 'open',
      yes_ask: 64,
    })).toMatchObject({
      id: 'flow-tr-1',
      playbook: 'flow-hunter',
    });

    vi.setSystemTime(new Date('2026-06-27T12:01:00.000Z'));
    await refreshTrades(hub);

    expect(hub.getTradesForTicker('KXDEMO')).toEqual([whaleTrade]);
    expect(hub.getTradeFeedState()).toMatchObject({
      status: 'degraded',
      cachedTradeCount: 1,
      lastError: 'fetch failed: trade endpoint timeout',
    });
  });

  it('coalesces overlapping market refreshes so background polling does not duplicate trade fetches', async () => {
    let releaseTradeFetch: (() => void) | undefined;
    const tradeResponse = new Promise<Response>((resolve) => {
      releaseTradeFetch = () => resolve(response({ trades: [] }));
    });
    const fetchFn = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.includes('/markets/trades')) return tradeResponse;
      return Promise.resolve(response({}));
    });
    const { hub } = makeHub(fetchFn);
    const now = Date.now();
    Object.assign(hub as unknown as {
      weather: unknown;
      macro: unknown;
      infra: unknown;
      nhc: unknown;
      industrial: unknown;
      sports: unknown;
      kalshiWsAt: number;
      portfolioPingAt: number;
      gdeltCache: Map<string, unknown>;
      worldNewsAt: number;
      eiaAt: number;
      secEdgarAt: number;
    }, {
      weather: { nws: null, openMeteo: null, lat: 0, lon: 0, fetchedAt: now },
      macro: { releaseName: 'CPI', consensus: 3.2, minutesToRelease: 60, fetchedAt: now },
      infra: { provider: 'AWS', status: 'operational', summary: 'ok', fetchedAt: now },
      nhc: { active: false, summary: 'quiet', fetchedAt: now },
      industrial: { headline: 'quiet', url: '', fetchedAt: now },
      sports: { homeScore: 0, awayScore: 0, impliedWinProb: 0.5, eventName: 'none', fetchedAt: now },
      kalshiWsAt: now,
      portfolioPingAt: now,
      worldNewsAt: now,
      eiaAt: now,
      secEdgarAt: now,
    });
    (hub as unknown as { gdeltCache: Map<string, unknown> }).gdeltCache.set(
      'united states economy politics',
      { news: { title: 'quiet', url: '', category: 'macro', severity: 0.1 }, fetchedAt: now },
    );
    const markets = [{ ticker: 'KXDEMO', title: 'Demo market', status: 'open' }];

    const first = hub.refreshForMarkets(markets);
    const second = hub.refreshForMarkets(markets);

    await Promise.resolve();
    expect(fetchFn.mock.calls.filter(([input]) => String(input).includes('/markets/trades'))).toHaveLength(1);

    releaseTradeFetch?.();
    await Promise.all([first, second]);
  });
});
