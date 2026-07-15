import { describe, expect, it } from 'vitest';
import { kalshiFeeForOrder } from '@nemesis/core';
import {
  calculateEntryEconomics,
  compareLegacyEntryEconomics,
  solveBreakEvenExitPrice,
} from './tradeEconomics.js';

const input = {
  entryPrice: 0.4,
  entryFeesUsd: 0.42,
  contracts: 25,
  sideFairPrice: 0.55,
  marketPrice: 0.4,
  grossEdge: 0.15,
  screeningNetEdge: 0.11,
  executableEntryNetEdge: 0.13,
  spread: 0.02,
  fillSlippage: 0,
};

describe('entry trade economics', () => {
  it('counts actual entry and target-exit costs exactly once', () => {
    const result = calculateEntryEconomics(input);

    expect(result.targetExitPrice).toBe(0.55);
    expect(result.targetExitFeesUsd).toBe(0.4332);
    expect(result.entryCostUsd).toBe(10.42);
    expect(result.targetRewardUsd).toBe(2.8968);
  });

  it('keeps the model target fixed when the executable entry gets worse', () => {
    const result = calculateEntryEconomics({
      ...input,
      entryPrice: 0.45,
      entryFeesUsd: kalshiFeeForOrder(0.45, 25),
      fillSlippage: 0.05,
    });

    expect(result.targetExitPrice).toBe(0.55);
    expect(result.targetRewardUsd).toBe(1.6336);
  });

  it('does not turn an externally supplied gross-edge field into an exit price', () => {
    const baseline = calculateEntryEconomics(input);
    const overridden = calculateEntryEconomics({ ...input, grossEdge: 0.9 });
    expect(overridden.targetExitPrice).toBe(baseline.targetExitPrice);
    expect(overridden.targetRewardUsd).toBe(baseline.targetRewardUsd);
  });

  it('finds the first fixed-point tick with non-negative net P&L', () => {
    const result = calculateEntryEconomics(input);
    const breakEven = solveBreakEvenExitPrice(result.entryCostUsd, input.contracts);
    if (breakEven == null) throw new Error('expected a reachable break-even tick');
    const atBreakEven = breakEven * input.contracts - kalshiFeeForOrder(breakEven, input.contracts) - result.entryCostUsd;
    const prior = breakEven - 0.0001;
    const beforeBreakEven = prior * input.contracts - kalshiFeeForOrder(prior, input.contracts) - result.entryCostUsd;

    expect(breakEven).toBe(0.434);
    expect(atBreakEven).toBeGreaterThanOrEqual(-1e-9);
    expect(beforeBreakEven).toBeLessThan(0);
  });

  it('reports no break-even when even settlement value cannot recover entry cost', () => {
    expect(solveBreakEvenExitPrice(10.01, 10)).toBeNull();
  });

  it('can re-score schema-2 evidence against the legacy calculation offline', () => {
    const comparison = compareLegacyEntryEconomics(input);
    expect(comparison.legacyTargetRewardUsd).toBe(1.8925);
    expect(comparison.correctedTargetRewardUsd).toBe(2.8968);
    expect(comparison.correctionUsd).toBe(1.0043);
  });
});
