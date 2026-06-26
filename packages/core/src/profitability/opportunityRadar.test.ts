import { describe, expect, it } from 'vitest';
import type { ThesisCard } from '../types.js';
import { rankOpportunityRadar } from './opportunityRadar.js';

function card(overrides: Partial<ThesisCard>): ThesisCard {
  return {
    id: 'base',
    ticker: 'BASE',
    title: 'Base market',
    category: 'macro',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.4,
    impliedPrice: 0.5,
    grossEdge: 0.1,
    netEdge: 0.05,
    spread: 0.02,
    depthUsd: 500,
    predictability: 78,
    feeEstimate: 0.01,
    signalReason: 'GEA primary gap',
    externalSummary: '',
    createdAt: 1,
    updatedAt: 1,
    freshnessMs: 500,
    edgeHistory: [0.035, 0.045, 0.05],
    drivers: [],
    invalidations: [],
    executableTier: 'solid',
    fillableUsd: 300,
    slippagePp: 0.01,
    ...overrides,
  };
}

describe('rankOpportunityRadar', () => {
  it('ranks executable fresh GEA tickets above stale weak tickets', () => {
    const rows = rankOpportunityRadar([
      card({ id: 'weak', ticker: 'WEAK', netEdge: 0.025, freshnessMs: 60_000, executableTier: undefined, signalReason: 'microstructure-only' }),
      card({ id: 'hot', ticker: 'HOT', netEdge: 0.075, executableTier: 'whale', fillableUsd: 900, signalReason: 'GEA elite YES entry' }),
    ], {
      bridgeLatencyByTicker: new Map([['HOT', 50], ['WEAK', 1_900]]),
      playbookPerformance: new Map([['flow-hunter', 0.4]]),
      maxRows: 5,
    });

    expect(rows[0].ticker).toBe('HOT');
    expect(rows[0].urgency).toBe('hot');
    expect(rows[0].reasons.join(' ')).toMatch(/GEA/);
  });
});
