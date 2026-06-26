import { describe, expect, it } from 'vitest';
import type { KalshiOrderbook, PaperPortfolio, ThesisCard } from '@nemesis/core';
import { DEFAULT_GUARDRAILS } from '@nemesis/core';
import { decideCapitalAllocation } from './allocator.js';

function card(overrides: Partial<ThesisCard> = {}): ThesisCard {
  return {
    id: 'c1',
    ticker: 'KXFAST',
    title: 'Fast market',
    category: 'macro',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.4,
    impliedPrice: 0.55,
    grossEdge: 0.15,
    netEdge: 0.08,
    spread: 0.02,
    depthUsd: 500,
    predictability: 85,
    feeEstimate: 0.02,
    signalReason: 'GEA fast lane',
    externalSummary: '',
    createdAt: 1,
    updatedAt: 1,
    freshnessMs: 100,
    edgeHistory: [0.05, 0.07, 0.08],
    drivers: [],
    invalidations: [],
    executableTier: 'solid',
    fillableUsd: 400,
    slippagePp: 0.01,
    depthLevels: 3,
    ...overrides,
  };
}

function portfolio(overrides: Partial<PaperPortfolio> = {}): PaperPortfolio {
  return {
    cash: 1000,
    startingCash: 1000,
    positions: [],
    trades: [],
    realizedPnl: 0,
    ...overrides,
  };
}

const book: KalshiOrderbook = {
  ticker: 'KXFAST',
  yes: [{ price: 0.39, quantity: 300 }],
  no: [{ price: 0.58, quantity: 300 }],
  yesAsk: 0.4,
  noAsk: 0.61,
  spread: 0.02,
};

describe('decideCapitalAllocation', () => {
  it('returns the max safe size and protective exit for executable profit', () => {
    const decision = decideCapitalAllocation({
      card: card(),
      portfolio: portfolio(),
      settings: { ...DEFAULT_GUARDRAILS, maxPositionUsd: 50, maxSlippagePp: 0.03 },
      book,
      allocation: {
        maxPositionUsd: 50,
        maxKellyFraction: 0.5,
        minExpectedProfitCents: 1,
        requireProtectableExit: true,
      },
    });

    expect(decision.noTradeReasons).toEqual([]);
    expect(decision.contracts).toBeGreaterThan(0);
    expect(decision.maxSafeContracts).toBe(decision.contracts);
    expect(decision.entryLimitCents).toBe(40);
    expect(decision.protectiveExitCents).toBeGreaterThan(decision.entryLimitCents);
    expect(decision.expectedNetProfitCents).toBeGreaterThan(0);
    expect(decision.latencyMs).toBeLessThan(1);
  });

  it('blocks stale, thin, and unprotectable trades instead of forcing minimum size', () => {
    const decision = decideCapitalAllocation({
      card: card({ freshnessMs: 45_000, netEdge: 0.01, impliedPrice: 0.405, fillableUsd: 4, depthUsd: 4 }),
      portfolio: portfolio(),
      settings: { ...DEFAULT_GUARDRAILS, maxPositionUsd: 50, maxSlippagePp: 0.03 },
      allocation: {
        maxPositionUsd: 50,
        maxKellyFraction: 0.5,
        minExpectedProfitCents: 1,
        requireProtectableExit: true,
      },
    });

    expect(decision.contracts).toBe(0);
    expect(decision.noTradeReasons).toEqual(expect.arrayContaining([
      'stale book',
      'insufficient liquidity',
      'insufficient protected profit',
    ]));
  });

  it('blocks unresolved mistake signatures before sizing capital', () => {
    const decision = decideCapitalAllocation({
      card: card(),
      portfolio: portfolio(),
      settings: DEFAULT_GUARDRAILS,
      unresolvedMistake: true,
    });

    expect(decision.contracts).toBe(0);
    expect(decision.noTradeReasons).toContain('unresolved mistake signature');
  });
});
