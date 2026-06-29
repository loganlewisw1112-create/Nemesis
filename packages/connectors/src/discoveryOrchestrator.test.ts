import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryOrchestrator } from './discoveryOrchestrator.js';
import { ConnectorRegistry } from './registry.js';
import type { KalshiMarket, KalshiOrderbook } from '@nemesis/core';

const fetchOrderbookMock = vi.hoisted(() => vi.fn());

vi.mock('@nemesis/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nemesis/core')>();
  return {
    ...actual,
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
  });

  it('seeds the universe and depth metrics together so UI does not report zero markets', () => {
    const discovery = new DiscoveryOrchestrator(new ConnectorRegistry());

    discovery.seedFixtureDepth(fixtures);

    expect(discovery.getUniverse()).toEqual(fixtures);
    expect(discovery.getState().metrics).toMatchObject({
      trackedTickers: 2,
      scoutCount: 2,
      depthPending: 0,
    });
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
});
