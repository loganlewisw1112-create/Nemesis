import { describe, expect, it } from 'vitest';
import { buildKalshiFeePolicy, kalshiFeeForOrder, type KalshiOrderbook } from '@nemesis/core';
import { dryRunFill } from './dryRun.js';

const policy = buildKalshiFeePolicy({ multiplier: 1, accountPrecision: 'direct' });

function book(): KalshiOrderbook {
  return {
    ticker: 'KXFP',
    yes: [{ price: 0.38, quantity: 10 }],
    no: [
      { price: 0.6, quantity: 1 },
      { price: 0.59, quantity: 2 },
    ],
    feePolicy: policy,
    sourceTimestamp: 1_000,
    sequence: 10,
  };
}

describe('fixed-point dry-run execution', () => {
  it('walks each ask level and reconstructs fees at each fill price', () => {
    const result = dryRunFill(book(), 'yes', 2, 0.6, 0.1);
    expect(result.aborted).toBe(false);
    expect(result.fillLevels).toEqual([
      { price: 0.4, quantity: 1, cost: 0.4 },
      { price: 0.41000000000000003, quantity: 1, cost: 0.41 },
    ]);
    expect(result.fillPrice).toBeCloseTo(0.405);
    expect(result.fees).toBe(
      kalshiFeeForOrder(0.4, 1, policy) + kalshiFeeForOrder(0.41000000000000003, 1, policy),
    );
  });

  it('supports fractional quantities and fails partial fills closed', () => {
    const fractional = dryRunFill(book(), 'yes', 1.5, 0.6, 0.1);
    expect(fractional.aborted).toBe(false);
    expect(fractional.filled).toBe(1.5);
    const partial = dryRunFill(book(), 'yes', 4, 0.6, 0.1);
    expect(partial.aborted).toBe(true);
    expect(partial.abortReason).toMatch(/complete fill/i);
    expect(partial.filled).toBe(3);
  });

  it('marks unresolved account/series policy as non-qualifying', () => {
    const result = dryRunFill({ ...book(), feePolicy: undefined }, 'yes', 1, 0.6, 0.1);
    expect(result.aborted).toBe(false);
    expect(result.feePolicyKnown).toBe(false);
  });
});
