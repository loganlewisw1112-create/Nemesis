import { describe, expect, it } from 'vitest';
import type { ThesisCard } from '@nemesis/core';
import {
  entryEligibilityBlockReason,
  isEntryEligible,
  isResearchSimulationEligible,
} from './entryEligibility.js';

function card(overrides: Partial<ThesisCard> = {}): ThesisCard {
  return {
    id: 'flow-1',
    ticker: 'KXTEST',
    title: 'Test market',
    category: 'test',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.4,
    impliedPrice: 0.55,
    grossEdge: 0.15,
    netEdge: 0.08,
    spread: 0.02,
    depthUsd: 500,
    predictability: 75,
    feeEstimate: 0.01,
    signalReason: 'current market-specific flow',
    externalSummary: 'live tape',
    createdAt: 1,
    updatedAt: 1,
    freshnessMs: 0,
    edgeHistory: [0.08],
    drivers: [],
    invalidations: [],
    sourceMove: 'flow-driven',
    ...overrides,
  };
}

describe('entry eligibility', () => {
  it('allows clean tradeable cards from evidence-backed playbooks', () => {
    for (const playbook of ['flow-hunter', 'crypto-lead'] as const) {
      expect(isEntryEligible(card({ playbook }))).toBe(true);
    }
  });

  it('keeps qualified and watch-only cards in research even with positive edge', () => {
    expect(entryEligibilityBlockReason(card({ status: 'qualified' }))).toContain('research-only');
    expect(entryEligibilityBlockReason(card({ status: 'watch-only' }))).toContain('research-only');
  });

  it('keeps heuristic and alert playbooks research-only even if mislabeled tradeable', () => {
    for (const playbook of [
      'global-pulse',
      'infra-watch',
      'release-radar',
      'weather-wing',
      'macro-pulse',
      'sports-live',
    ] as const) {
      expect(entryEligibilityBlockReason(card({ playbook }))).toBe(`playbook ${playbook} is research-only`);
    }
  });

  it('blocks active invalidations, non-positive edge, and unconfirmed crypto flow', () => {
    expect(entryEligibilityBlockReason(card({ invalidations: ['source-conflict'] }))).toContain('source-conflict');
    expect(entryEligibilityBlockReason(card({ netEdge: 0 }))).toBe('net edge must be positive');
    expect(entryEligibilityBlockReason(card({ playbook: 'crypto-lead', sourceMove: 'microstructure-only' })))
      .toBe('crypto-lead requires confirmed live flow');
  });

  it('allows broad statuses for non-mutating research simulation only', () => {
    expect(isResearchSimulationEligible(card({ status: 'tradeable' }))).toBe(true);
    expect(isResearchSimulationEligible(card({ status: 'qualified' }))).toBe(true);
    expect(isResearchSimulationEligible(card({ status: 'watch-only' }))).toBe(true);
    expect(isResearchSimulationEligible(card({ status: 'blocked' }))).toBe(false);
  });
});
