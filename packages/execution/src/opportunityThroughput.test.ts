import { describe, expect, it } from 'vitest';
import type { ProfitCertificate, ThesisCard } from '@nemesis/core';
import { OpportunityThroughputQueue } from './opportunityThroughput.js';

function card(overrides: Partial<ThesisCard> = {}): ThesisCard {
  return {
    id: 'c1',
    ticker: 'KXTHRU',
    title: 'Throughput market',
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
    signalReason: 'test',
    externalSummary: '',
    createdAt: 1,
    updatedAt: 1,
    freshnessMs: 100,
    edgeHistory: [0.08],
    drivers: [],
    invalidations: [],
    ...overrides,
  };
}

const certificate: ProfitCertificate = {
  kind: 'open',
  ticker: 'KXTHRU',
  side: 'yes',
  contracts: 2,
  entryPrice: 0.4,
  exitPrice: 0.44,
  entryFees: 0.02,
  exitFees: 0.02,
  netPnlUsd: 0.04,
  bookTimestamp: 1_000,
  expiresAt: 3_000,
  reason: 'strict profit certified',
};

describe('OpportunityThroughputQueue', () => {
  it('dedupes discovered candidates and prioritizes certified profit', () => {
    const queue = new OpportunityThroughputQueue({ retryableBlockCooldownMs: 5_000 });

    queue.discover([card(), card({ id: 'c2' }), card({ id: 'c3', ticker: 'KXOTHER' })], 1_000);
    queue.markCertified('KXTHRU:yes', certificate, 1_050);
    queue.markCertified('KXOTHER:yes', { ...certificate, ticker: 'KXOTHER', netPnlUsd: 0.1 }, 1_060);

    expect(queue.snapshot().items).toHaveLength(2);
    expect(queue.snapshot().telemetry.candidatesScanned).toBe(3);
    expect(queue.nextCertified()?.ticker).toBe('KXOTHER');
  });

  it('retries only retryable blocks after cooldown and leaves final blocks quiet', () => {
    const queue = new OpportunityThroughputQueue({ retryableBlockCooldownMs: 5_000 });
    queue.discover([card(), card({ ticker: 'KXFINAL' })], 1_000);

    queue.markBlocked('KXTHRU:yes', 'book_unavailable', true, 1_100);
    queue.markBlocked('KXFINAL:yes', 'strict_profit_block', false, 1_100);

    expect(queue.dueForRetry(6_099)).toEqual([]);
    expect(queue.dueForRetry(6_100).map((item) => item.key)).toEqual(['KXTHRU:yes']);
    expect(queue.snapshot().telemetry.retryableBlocked).toBe(1);
    expect(queue.snapshot().telemetry.profitBlocked).toBe(1);
  });
});
