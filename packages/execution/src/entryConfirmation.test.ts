import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_QUALIFICATION, type ProfitCertificate, type ThesisCard } from '@nemesis/core';
import type { DryRunOrder } from './dryRun.js';
import { EntryConfirmationEngine } from './entryConfirmation.js';

const startedAt = Date.UTC(2026, 6, 14, 12, 0, 0);

function card(overrides: Partial<ThesisCard> = {}): ThesisCard {
  return {
    id: 'flow-1',
    ticker: 'KXTEST-26',
    title: 'Test flow market',
    category: 'test',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.4,
    impliedPrice: 0.5,
    grossEdge: 0.14,
    netEdge: 0.12,
    spread: 0.02,
    depthUsd: 500,
    predictability: 0.8,
    feeEstimate: 0.01,
    signalReason: 'persistent aggressive flow',
    externalSummary: '',
    createdAt: startedAt,
    updatedAt: startedAt,
    freshnessMs: 0,
    edgeHistory: [0.12],
    drivers: [],
    invalidations: [],
    sourceMove: 'flow-driven',
    ...overrides,
  };
}

function fill(overrides: Partial<DryRunOrder> = {}): DryRunOrder {
  return {
    ticker: 'KXTEST-26',
    side: 'yes',
    contracts: 25,
    expectedPrice: 0.4,
    fillPrice: 0.4,
    filled: 25,
    slippage: 0,
    fees: 0.18,
    netEdge: 0.09,
    aborted: false,
    ...overrides,
  };
}

function certificate(): ProfitCertificate {
  return {
    kind: 'open',
    ticker: 'KXTEST-26',
    side: 'yes',
    contracts: 25,
    entryPrice: 0.4,
    exitPrice: 0.4,
    entryFees: 0.18,
    exitFees: 0,
    netPnlUsd: 2.32,
    bookTimestamp: startedAt,
    expiresAt: startedAt + 60_000,
    reason: 'modeled edge',
    classification: 'research_only',
  };
}

function observe(engine: EntryConfirmationEngine, index: number, overrides: Partial<ThesisCard> = {}) {
  const observedAt = startedAt + index * 6_000;
  return engine.observe({
    card: card({ updatedAt: observedAt, ...overrides }),
    fill: fill(),
    baseCertificate: certificate(),
    bookTimestamp: observedAt,
    observedAt,
  });
}

describe('EntryConfirmationEngine', () => {
  it('requires six executable samples over at least 30 seconds before confirming', () => {
    const engine = new EntryConfirmationEngine();
    for (let index = 0; index < 5; index += 1) {
      expect(observe(engine, index).status).toBe('pending');
    }
    const result = observe(engine, 5);
    expect(result.status).toBe('ready');
    expect(result.samples).toBe(6);
    expect(result.windowMs).toBe(30_000);
    expect(result.edgeRetention).toBe(1);
    expect(result.expectedRewardUsd).toBeGreaterThanOrEqual(1);
    expect(result.rewardRiskRatio).toBeGreaterThanOrEqual(2);
    expect(result.stressedNetPnlUsd).toBeGreaterThan(0);
    expect(result.certificate?.classification).toBe('modeled_confirmed');
  });

  it('rejects stale, reused, non-flow, and cooldown-blocked sources', () => {
    const stale = new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt + 60_001, observedAt: startedAt + 60_001,
    });
    expect(stale.reason).toMatch(/stale/i);
    expect(new EntryConfirmationEngine().observe({
      card: card({ sourceMove: 'news-driven' }), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt, observedAt: startedAt,
    }).reason).toMatch(/flow-driven/i);
    expect(new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt, observedAt: startedAt, sourceAlreadyUsed: true,
    }).reason).toMatch(/already used/i);
    expect(new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt, observedAt: startedAt, lastTickerExecutionAt: startedAt - 1_000,
    }).reason).toMatch(/cooldown/i);
  });

  it('rejects edge decay and spread widening during confirmation', () => {
    const decaying = new EntryConfirmationEngine({
      ...DEFAULT_ENTRY_QUALIFICATION,
      minExpectedNetPnlUsd: 0,
      minRewardRiskRatio: 0,
      minStressedNetPnlUsd: -1,
    });
    expect(observe(decaying, 0).status).toBe('pending');
    expect(observe(decaying, 1, { netEdge: 0.06 }).reason).toMatch(/edge decayed/i);

    const widening = new EntryConfirmationEngine();
    expect(observe(widening, 0).status).toBe('pending');
    expect(observe(widening, 1, { spread: 0.031 }).reason).toMatch(/spread widened/i);
  });

  it('fails closed when one-cent stress is not profitable', () => {
    const engine = new EntryConfirmationEngine({
      ...DEFAULT_ENTRY_QUALIFICATION,
      minExpectedNetPnlUsd: -1,
      minRewardRiskRatio: -100,
    });
    const result = engine.observe({
      card: card({ netEdge: 0.01 }),
      fill: fill({ filled: 1, contracts: 1, fees: 0.02 }),
      baseCertificate: { ...certificate(), contracts: 1, entryFees: 0.02 },
      bookTimestamp: startedAt,
      observedAt: startedAt,
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/stressed/i);
  });
});
