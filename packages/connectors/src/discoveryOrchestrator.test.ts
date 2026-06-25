import { describe, expect, it } from 'vitest';
import { DiscoveryOrchestrator } from './discoveryOrchestrator.js';
import { ConnectorRegistry } from './registry.js';
import type { KalshiMarket } from '@nemesis/core';

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
});
