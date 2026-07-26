import { describe, expect, it } from 'vitest';
import type { ThesisCard } from '@nemesis/core';
import { requalifyThesisCard } from './thesisRequalification.js';

function card(overrides: Partial<ThesisCard> = {}): ThesisCard {
  return {
    id: 'crypto-KXBTCD-TEST',
    ticker: 'KXBTCD-TEST',
    title: 'BTC test',
    category: 'crypto',
    playbook: 'crypto-lead',
    status: 'watch-only',
    side: 'yes',
    marketPrice: 0.6,
    impliedPrice: 0.66,
    grossEdge: 0.06,
    netEdge: 0.005,
    spread: 0.01,
    depthUsd: 500,
    predictability: 72,
    feeEstimate: 0.01,
    signalReason: 'Binance live flow',
    externalSummary: 'BTC spot lead',
    createdAt: 1,
    updatedAt: 1,
    freshnessMs: 500,
    edgeHistory: [0.005],
    drivers: [],
    invalidations: ['netEdge'],
    sourceMove: 'flow-driven',
    ...overrides,
  };
}

describe('thesis requalification', () => {
  it('promotes a stale net-edge watch card after live pricing clears the gate', () => {
    const updated = requalifyThesisCard(card());

    expect(updated.status).toBe('tradeable');
    expect(updated.invalidations).not.toContain('netEdge');
    expect(updated.netEdge).toBeGreaterThanOrEqual(0.02);
  });

  it('uses verified depth to clear a stale liquidity gate', () => {
    const updated = requalifyThesisCard(card({
      status: 'watch-only',
      depthUsd: 0,
      invalidations: ['liquidity'],
    }), { depthUsd: 250 });

    expect(updated.status).toBe('tradeable');
    expect(updated.depthUsd).toBe(250);
    expect(updated.invalidations).not.toContain('liquidity');
  });

  it('retains model invalidations even when price and depth are otherwise tradeable', () => {
    const updated = requalifyThesisCard(card({
      status: 'uncertain',
      invalidations: ['netEdge', 'crypto-volatility-unavailable'],
    }));

    expect(updated.status).toBe('uncertain');
    expect(updated.invalidations).toContain('crypto-volatility-unavailable');
  });

  it('respects paper review-only mode', () => {
    const updated = requalifyThesisCard(card(), { reviewOnly: true, demoMode: false });

    expect(updated.status).toBe('observe');
  });
});
