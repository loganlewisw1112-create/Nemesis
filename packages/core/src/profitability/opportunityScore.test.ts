import { describe, expect, it } from 'vitest';
import { scoreOpportunity, scoreOpportunityForCard } from './opportunityScore.js';
import type { ThesisCard } from '../types.js';

describe('OpportunityScore', () => {
  it('rejects stale, thin, wide-spread, and low-clarity tickets', () => {
    const result = scoreOpportunity({
      ticker: 'WEAK-1',
      netEdge: 0.01,
      probabilityGap: 0.01,
      fillableUsd: 20,
      depthUsd: 35,
      slippagePp: 0.09,
      spread: 0.12,
      freshnessMs: 95_000,
      confidence: 0.44,
      settlementClarity: 0.3,
      bridgeLatencyMs: 4_000,
    });

    expect(result.rejectReasons).toEqual(expect.arrayContaining([
      'stale signal',
      'thin book',
      'wide spread/slippage',
      'low settlement clarity',
      'slow GEA bridge',
    ]));
    expect(result.score).toBeLessThan(40);
  });

  it('scores executable high-confidence edge above weak heuristic edge', () => {
    const strong = scoreOpportunity({
      ticker: 'STRONG-1',
      netEdge: 0.06,
      probabilityGap: 0.09,
      fillableUsd: 700,
      depthUsd: 900,
      slippagePp: 0.01,
      spread: 0.02,
      freshnessMs: 1_000,
      confidence: 0.86,
      settlementClarity: 0.88,
      executableTier: 'whale',
      bridgeLatencyMs: 60,
      recentPerformance: 0.65,
    });
    const weak = scoreOpportunity({
      ticker: 'WEAK-2',
      netEdge: 0.035,
      probabilityGap: 0.02,
      fillableUsd: 75,
      depthUsd: 80,
      slippagePp: 0.045,
      spread: 0.06,
      freshnessMs: 35_000,
      confidence: 0.58,
      settlementClarity: 0.56,
      executableTier: null,
      bridgeLatencyMs: 1_800,
      recentPerformance: -0.2,
    });

    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.rejectReasons).toEqual([]);
  });

  it('maps a thesis card into an opportunity score contract', () => {
    const card: ThesisCard = {
      id: 't1',
      ticker: 'CARD-1',
      title: 'Card market',
      category: 'test',
      playbook: 'flow-hunter',
      status: 'tradeable',
      side: 'yes',
      marketPrice: 0.42,
      impliedPrice: 0.52,
      grossEdge: 0.1,
      netEdge: 0.055,
      spread: 0.02,
      depthUsd: 500,
      predictability: 0.8,
      feeEstimate: 0.01,
      signalReason: 'GEA primary probability gap',
      externalSummary: '',
      createdAt: Date.now() - 500,
      updatedAt: Date.now() - 500,
      freshnessMs: 500,
      edgeHistory: [0.04, 0.05, 0.055],
      drivers: [],
      invalidations: [],
      executableTier: 'solid',
      fillableUsd: 350,
      slippagePp: 0.01,
    };

    const score = scoreOpportunityForCard(card, { bridgeLatencyMs: 75 });

    expect(score.ticker).toBe('CARD-1');
    expect(score.probabilityGap).toBeCloseTo(0.1, 3);
    expect(score.fillableUsd).toBe(350);
    expect(score.confidence).toBeGreaterThan(0.75);
  });
});
