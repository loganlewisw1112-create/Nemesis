import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryOrchestrator } from './discoveryOrchestrator.js';
import { ConnectorRegistry } from './registry.js';
import type { KalshiMarket, KalshiOrderbook } from '@nemesis/core';

const { fetchMarketsMock, fetchOrderbookMock } = vi.hoisted(() => ({
  fetchMarketsMock: vi.fn(),
  fetchOrderbookMock: vi.fn(),
}));

vi.mock('@nemesis/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nemesis/core')>();
  return {
    ...actual,
    fetchMarkets: fetchMarketsMock,
    fetchOrderbook: fetchOrderbookMock,
  };
});

const fixtures: KalshiMarket[] = [
  {
    ticker: 'KXFIXTURE-1',
    title: 'Fixture one',
    status: 'open',
    yes_bid: 44,
    yes_ask: 46,
    volume: 1000,
  },
  {
    ticker: 'KXFIXTURE-2',
    title: 'Fixture two',
    status: 'open',
    yes_bid: 50,
    yes_ask: 52,
    volume: 800,
  },
];

describe('DiscoveryOrchestrator fixture fallback', () => {
  beforeEach(() => {
    fetchOrderbookMock.mockReset();
    fetchMarketsMock.mockReset();
  });

  it('seeds the universe and depth metrics together so UI does not report zero markets', () => {
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());

    discovery.seedFixtureDepth(fixtures);

    expect(discovery.getUniverse()).toEqual(fixtures);
    expect(discovery.hasLiveUniverse()).toBe(false);
    expect(discovery.getState().metrics).toMatchObject({
      trackedTickers: 2,
      scoutCount: 2,
      depthPending: 0,
    });
  });

  it('distinguishes a successful live universe from fixture fallback data', async () => {
    fetchMarketsMock.mockResolvedValue({ markets: fixtures });
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    discovery.seedFixtureDepth(fixtures);

    await discovery.refreshUniverse();

    expect(discovery.hasLiveUniverse()).toBe(true);
  });

  it('pre-filters zero-volume and unquoted markets before depth requests', async () => {
    fetchMarketsMock.mockResolvedValue({
      markets: [
        {
          ticker: 'KXMVE-DEAD',
          title: 'Unquoted combination',
          status: 'active',
          yes_bid_dollars: '0.0000',
          yes_ask_dollars: '0.0000',
          volume: 0,
          volume_24h: 0,
        },
        {
          ticker: 'KXLIQUID-LOW',
          title: 'Lower-volume market',
          status: 'active',
          yes_bid_dollars: '0.4000',
          yes_ask_dollars: '0.4100',
          volume: 500,
          volume_24h: 100,
        },
        {
          ticker: 'KXLIQUID-HIGH',
          title: 'Higher-volume market',
          status: 'active',
          yes_bid_dollars: '0.6200',
          yes_ask_dollars: '0.6300',
          volume: 5_000,
          volume_24h: 2_000,
        },
      ],
    });
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());

    await discovery.refreshUniverse();

    expect(discovery.getUniverse().map((market) => market.ticker)).toEqual([
      'KXLIQUID-HIGH',
      'KXLIQUID-LOW',
    ]);
  });

  it('continues past sparse zero-volume pages until the 25-market live minimum is available', async () => {
    const sparse = Array.from({ length: 100 }, (_, index) => ({
      ticker: `KXEMPTY-${index}`,
      title: `Empty market ${index}`,
      status: 'active',
      yes_bid_dollars: '0.0000',
      yes_ask_dollars: '0.0000',
      volume: 0,
      volume_24h: 0,
    } satisfies KalshiMarket));
    const executable = Array.from({ length: 25 }, (_, index) => ({
      ticker: `KXLIVE-${index}`,
      title: `Live market ${index}`,
      status: 'active',
      yes_bid_dollars: '0.4000',
      yes_ask_dollars: '0.4100',
      volume: 1_000 + index,
      volume_24h: 100 + index,
    } satisfies KalshiMarket));
    fetchMarketsMock
      .mockResolvedValueOnce({ markets: sparse, cursor: 'page-2' })
      .mockResolvedValueOnce({ markets: executable });
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    discovery.updateSettings({ maxTrackedTickers: 25, universePageSize: 100 });

    await discovery.refreshUniverse();

    expect(fetchMarketsMock).toHaveBeenCalledTimes(2);
    expect(discovery.getUniverse()).toHaveLength(25);
    expect(discovery.getUniverse()[0]?.ticker).toBe('KXLIVE-24');
    expect(discovery.hasLiveUniverse()).toBe(true);
  });

  it('retains the actual successful production REST host for each admitted market', async () => {
    fetchMarketsMock.mockImplementation(async (options: { onResponseMetadata?: (metadata: unknown) => void }) => {
      options.onResponseMetadata?.({
        environment: 'production',
        endpointClass: 'market-data',
        sourceBaseUrl: 'https://api.elections.kalshi.com/trade-api/v2',
        status: 200,
        verifiedAt: 1_800_000_000_000,
      });
      return { markets: fixtures };
    });
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());

    await discovery.refreshUniverse();

    expect(discovery.getProductionUniverseRecords()).toEqual(fixtures.map((market) => ({
      market,
      sourceBaseUrl: 'https://api.elections.kalshi.com/trade-api/v2',
      verifiedAt: 1_800_000_000_000,
    })));
  });

  it('does not treat fixtures as a stale live snapshot after a failed refresh', async () => {
    fetchMarketsMock.mockRejectedValue(new Error('rate limited'));
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    discovery.seedFixtureDepth(fixtures);

    await expect(discovery.refreshUniverse()).rejects.toThrow('rate limited');

    expect(discovery.hasLiveUniverse()).toBe(false);
  });

  it('prioritizes active trade-tape markets for the next depth pass', () => {
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    discovery.seedFixtureDepth(fixtures);
    const active = {
      ticker: 'KXACTIVE-TRADE',
      title: 'Active trade market',
      status: 'active',
      yes_bid: 40,
      yes_ask: 41,
      volume: 2_000,
    } satisfies KalshiMarket;

    discovery.prioritizeMarkets([active]);

    expect(discovery.getUniverse().map((market) => market.ticker)).toEqual([
      'KXACTIVE-TRADE',
      'KXFIXTURE-1',
      'KXFIXTURE-2',
    ]);
  });

  it('coalesces overlapping depth passes so market refreshes do not duplicate orderbook scans', async () => {
    let releaseOrderbooks: (() => void) | undefined;
    const book: KalshiOrderbook = {
      ticker: 'KXFIXTURE',
      yes: [{ price: 0.45, quantity: 100 }],
      no: [{ price: 0.54, quantity: 100 }],
      yesAsk: 0.46,
      noAsk: 0.55,
      spread: 0.01,
    };
    const orderbookResponse = new Promise<KalshiOrderbook>((resolve) => {
      releaseOrderbooks = () => resolve(book);
    });
    fetchOrderbookMock.mockReturnValue(orderbookResponse);
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    discovery.updateSettings({ depthChecksPerCycle: 2 });
    discovery.seedFixtureDepth(fixtures);

    const first = discovery.runDepthPass();
    const second = discovery.runDepthPass();

    expect(fetchOrderbookMock).toHaveBeenCalledTimes(2);

    releaseOrderbooks?.();
    await Promise.all([first, second]);
  });

  it('bounds REST depth fallback and reuses streamed order books', async () => {
    const markets = Array.from({ length: 20 }, (_, index) => ({
      ticker: `KXDEPTH-${index}`,
      title: `Depth market ${index}`,
      status: 'open',
      yes_bid: 40,
      yes_ask: 42,
      volume: 1_000 + index,
    } satisfies KalshiMarket));
    const book: KalshiOrderbook = {
      ticker: '',
      yes: [{ price: 0.4, quantity: 100 }],
      no: [{ price: 0.58, quantity: 100 }],
      yesAsk: 0.42,
      noAsk: 0.6,
      spread: 0.02,
    };
    fetchMarketsMock.mockResolvedValue({ markets });
    fetchOrderbookMock.mockImplementation(async (ticker: string) => ({ ...book, ticker }));
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    discovery.updateSettings({ depthChecksPerCycle: 20 });
    await discovery.refreshUniverse();

    await discovery.runDepthPass();
    expect(fetchOrderbookMock).toHaveBeenCalledTimes(8);

    fetchOrderbookMock.mockClear();
    const ninthTicker = discovery.getUniverse()[8]!.ticker;
    discovery.ingestOrderbook({ ...book, ticker: ninthTicker, sequence: 1, sourceTimestamp: Date.now() });
    discovery.updateSettings({ depthChecksPerCycle: 9 });
    await discovery.runDepthPass();
    expect(fetchOrderbookMock).not.toHaveBeenCalled();
    expect(discovery.getDepth(ninthTicker)).toBeDefined();
  });
});

describe('series allowlist env', () => {
  const original = process.env.NEMESIS_SERIES_ALLOWLIST;
  const originalDeny = process.env.NEMESIS_SERIES_DENYLIST;

  afterEach(() => {
    if (original === undefined) delete process.env.NEMESIS_SERIES_ALLOWLIST;
    else process.env.NEMESIS_SERIES_ALLOWLIST = original;
    if (originalDeny === undefined) delete process.env.NEMESIS_SERIES_DENYLIST;
    else process.env.NEMESIS_SERIES_DENYLIST = originalDeny;
  });

  it('reads NEMESIS_SERIES_ALLOWLIST dynamically (not frozen at module load)', async () => {
    const {
      tickerWithinSeriesAllowlist,
      seriesAllowlistConfigured,
    } = await import('./discoveryOrchestrator.js');

    delete process.env.NEMESIS_SERIES_ALLOWLIST;
    expect(seriesAllowlistConfigured()).toBe(false);
    expect(tickerWithinSeriesAllowlist('KXMLBGAME-1')).toBe(true);

    process.env.NEMESIS_SERIES_ALLOWLIST = 'KXINXHUD,KXBTCD';
    expect(seriesAllowlistConfigured()).toBe(true);
    expect(tickerWithinSeriesAllowlist('KXBTCD-26JUL2412-T63999.99')).toBe(true);
    expect(tickerWithinSeriesAllowlist('KXMLBGAME-1')).toBe(false);
    expect(tickerWithinSeriesAllowlist('KXINXHUD-1')).toBe(true);
  });

  it('honors NEMESIS_SERIES_DENYLIST even without an allowlist', async () => {
    const {
      tickerWithinSeriesAllowlist,
      seriesDenylistConfigured,
    } = await import('./discoveryOrchestrator.js');

    delete process.env.NEMESIS_SERIES_ALLOWLIST;
    process.env.NEMESIS_SERIES_DENYLIST = 'KXETHD';
    expect(seriesDenylistConfigured()).toBe(true);
    expect(tickerWithinSeriesAllowlist('KXETHD-26JUL2512-T1859.99')).toBe(false);
    expect(tickerWithinSeriesAllowlist('KXBTCD-26JUL2512-T64099.99')).toBe(true);
  });

  it('keeps zero-volume quoted allowlisted markets so force-fill has inventory', async () => {
    process.env.NEMESIS_SERIES_ALLOWLIST = 'KXBTCD,KXETHD';
    fetchMarketsMock.mockImplementation(async (options: { seriesTicker?: string }) => {
      const all = [
        {
          ticker: 'KXBTCD-26JUL2421-T64099.99',
          title: 'BTC daily',
          status: 'open',
          yes_bid_dollars: '0.4000',
          yes_ask_dollars: '0.4100',
          volume: 0,
          volume_24h: 0,
        },
        {
          ticker: 'KXETHD-26JUL2421-T2499.99',
          title: 'ETH daily',
          status: 'open',
          yes_bid_dollars: '0.5500',
          yes_ask_dollars: '0.5600',
          volume: 0,
          volume_24h: 0,
        },
        {
          ticker: 'KXMLBGAME-1',
          title: 'Sports (must not enter allowlisted universe)',
          status: 'open',
          yes_bid_dollars: '0.5000',
          yes_ask_dollars: '0.5100',
          volume: 9_000,
          volume_24h: 4_000,
        },
      ];
      const series = options.seriesTicker?.toUpperCase();
      return {
        markets: series
          ? all.filter((market) => market.ticker.toUpperCase().startsWith(series))
          : all,
      };
    });
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    await discovery.refreshUniverse();
    expect(discovery.getUniverse().map((market) => market.ticker).sort()).toEqual([
      'KXBTCD-26JUL2421-T64099.99',
      'KXETHD-26JUL2421-T2499.99',
    ]);
    expect(fetchMarketsMock).toHaveBeenCalledWith(expect.objectContaining({ seriesTicker: 'KXBTCD' }));
    expect(fetchMarketsMock).toHaveBeenCalledWith(expect.objectContaining({ seriesTicker: 'KXETHD' }));
  });

  it('queries each allowlist series directly instead of paging the global open book', async () => {
    process.env.NEMESIS_SERIES_ALLOWLIST = 'KXINXHUD,KXBTCD';
    fetchMarketsMock.mockReset();
    fetchMarketsMock.mockImplementation(async (options: { seriesTicker?: string }) => ({
      markets: options.seriesTicker === 'KXBTCD'
        ? [{
            ticker: 'KXBTCD-26JUL2421-T64099.99',
            title: 'BTC daily',
            status: 'open',
            yes_bid_dollars: '0.4000',
            yes_ask_dollars: '0.4100',
            volume: 0,
            volume_24h: 0,
          }]
        : options.seriesTicker === 'KXINXHUD'
          ? [{
              ticker: 'KXINXHUD-26JUL2418-B7000',
              title: 'INX HUD',
              status: 'open',
              yes_bid_dollars: '0.4800',
              yes_ask_dollars: '0.4900',
              volume: 0,
              volume_24h: 0,
            }]
          : [],
    }));
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    await discovery.refreshUniverse();
    expect(discovery.getUniverse().map((market) => market.ticker).sort()).toEqual([
      'KXBTCD-26JUL2421-T64099.99',
      'KXINXHUD-26JUL2418-B7000',
    ]);
    const seriesArgs = fetchMarketsMock.mock.calls.map((call) => call[0]?.seriesTicker).sort();
    expect(seriesArgs).toEqual(['KXBTCD', 'KXINXHUD']);
  });
});

describe('DiscoveryOrchestrator closed-contract exclusion', () => {
  beforeEach(() => {
    fetchMarketsMock.mockReset();
    fetchOrderbookMock.mockReset();
    fetchOrderbookMock.mockResolvedValue({ ticker: 'x', yes: [], no: [] } as unknown as KalshiOrderbook);
    vi.useFakeTimers();
    vi.setSystemTime(1_785_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const now = 1_785_000_000_000;
  const quoted = {
    yes_bid_dollars: '0.4800',
    yes_ask_dollars: '0.4900',
    volume: 5_000,
    volume_24h: 5_000,
  };

  it('drops a contract Kalshi still reports as active once its close time has passed', async () => {
    // The 2026-07-28 overnight failure: every candidate ticker was a closed
    // contract that Kalshi still served as `active`, so a status-only filter put
    // it in the universe where it generated cards that could never earn
    // provenance. Entry confirmations went to zero with a healthy socket.
    fetchMarketsMock.mockResolvedValue({
      markets: [
        {
          ticker: 'KXBTCD-CLOSED',
          title: 'Closed an hour ago',
          status: 'active',
          close_time: new Date(now - 60 * 60_000).toISOString(),
          ...quoted,
        },
        {
          ticker: 'KXBTCD-LIVE',
          title: 'Closes in half an hour',
          status: 'active',
          close_time: new Date(now + 30 * 60_000).toISOString(),
          ...quoted,
        },
      ],
    });
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());

    await discovery.refreshUniverse();

    expect(discovery.getUniverse().map((market) => market.ticker)).toEqual(['KXBTCD-LIVE']);
  });

  it('does not promote a just-closed contract off the trade tape', async () => {
    fetchMarketsMock.mockResolvedValue({
      markets: [{
        ticker: 'KXBTCD-LIVE',
        title: 'Live',
        status: 'active',
        close_time: new Date(now + 30 * 60_000).toISOString(),
        ...quoted,
      }],
    });
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());
    await discovery.refreshUniverse();

    // A contract can print trades right up to its close, so the tape keeps
    // offering it for seconds afterwards.
    const prioritized = discovery.prioritizeMarkets([{
      ticker: 'KXBTCD-JUST-CLOSED',
      title: 'Closed a minute ago',
      status: 'active',
      close_time: new Date(now - 60_000).toISOString(),
      ...quoted,
    } as unknown as KalshiMarket]);

    expect(prioritized.map((market) => market.ticker)).not.toContain('KXBTCD-JUST-CLOSED');
  });
});
