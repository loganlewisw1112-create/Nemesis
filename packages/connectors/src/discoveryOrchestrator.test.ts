import { beforeEach, describe, expect, it, vi } from 'vitest';
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
