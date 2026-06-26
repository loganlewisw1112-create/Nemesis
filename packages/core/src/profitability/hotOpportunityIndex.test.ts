import { describe, expect, it } from 'vitest';
import type { ThesisCard } from '../types.js';
import { HotOpportunityIndex } from './hotOpportunityIndex.js';

function card(ticker: string, netEdge: number, freshnessMs = 100): ThesisCard {
  return {
    id: ticker,
    ticker,
    title: ticker,
    category: 'macro',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.42,
    impliedPrice: 0.52,
    grossEdge: 0.1,
    netEdge,
    spread: 0.02,
    depthUsd: 500,
    predictability: 80,
    feeEstimate: 0.02,
    signalReason: 'GEA fast lane',
    externalSummary: '',
    createdAt: 1,
    updatedAt: 1,
    freshnessMs,
    edgeHistory: [netEdge],
    drivers: [],
    invalidations: [],
    executableTier: 'solid',
    fillableUsd: 250,
    slippagePp: 0.01,
    depthLevels: 2,
  };
}

describe('HotOpportunityIndex', () => {
  it('reranks changed tickers incrementally inside the local decision budget', () => {
    const index = new HotOpportunityIndex({ maxRows: 5, targetDecisionMs: 3 });
    index.replaceAll([card('A', 0.04), card('B', 0.03)]);

    const result = index.upsert(card('B', 0.09));

    expect(index.top(1)[0]?.ticker).toBe('B');
    expect(result.localDecisionMs).toBeLessThan(3);
    expect(result.changed).toBe(true);
  });

  it('removes stale rows without rescoring the whole universe', () => {
    const index = new HotOpportunityIndex({ maxRows: 5, targetDecisionMs: 3 });
    index.replaceAll([card('A', 0.04), card('B', 0.08)]);

    index.remove('B');

    expect(index.top(5).map((r) => r.ticker)).toEqual(['A']);
  });
});
