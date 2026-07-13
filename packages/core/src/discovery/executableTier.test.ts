import { describe, expect, it } from 'vitest';
import {
  buildAskLevels,
  getTierThresholds,
  hasRealExecutableDepth,
  usdToContracts,
  verifySideDepth,
} from './executableTier.js';
import type { KalshiOrderbook } from '../types.js';

describe('executableTier', () => {
  it('usdToContracts is fee-aware', () => {
    expect(usdToContracts(100, 0.5)).toBeGreaterThan(0);
    expect(usdToContracts(100, 0.5) * 0.5).toBeLessThan(100);
  });

  it('assigns whale tier on deep book with low slippage', () => {
    const book: KalshiOrderbook = {
      ticker: 'T',
      yes: [{ price: 0.48, quantity: 500 }],
      no: [{ price: 0.48, quantity: 500 }],
      yesAsk: 0.52,
      noAsk: 0.52,
      spread: 0.04,
    };
    const levels = buildAskLevels(book, 'yes');
    expect(levels.length).toBeGreaterThan(0);
    const result = verifySideDepth(book, 'yes', 0.52, getTierThresholds('balanced'));
    expect(['scout', 'solid', 'whale']).toContain(result.executableTier);
    expect(hasRealExecutableDepth(result)).toBe(true);
    expect(result.fillableUsd).toBeGreaterThan(0);
  });

  it('returns null tier when book is too thin', () => {
    const book: KalshiOrderbook = {
      ticker: 'T',
      yes: [],
      no: [{ price: 0.9, quantity: 1 }],
      yesAsk: 0.1,
      spread: 0.02,
    };
    const result = verifySideDepth(book, 'yes', 0.1, getTierThresholds());
    expect(result.executableTier).toBeNull();
  });

  it('conservative preset tightens slippage vs aggressive', () => {
    const c = getTierThresholds('conservative').find((t) => t.tier === 'scout')!;
    const a = getTierThresholds('aggressive').find((t) => t.tier === 'scout')!;
    expect(c.maxSlippagePp).toBeLessThan(a.maxSlippagePp);
  });

  it('only admits measured executable depth at the declared tier', () => {
    expect(hasRealExecutableDepth({
      executableTier: 'scout',
      fillableUsd: 100,
      slippagePp: 0.01,
      depthLevels: 2,
    })).toBe(true);
    expect(hasRealExecutableDepth({
      executableTier: 'scout',
      fillableUsd: 98,
      slippagePp: 0.01,
      depthLevels: 2,
    })).toBe(false);
    expect(hasRealExecutableDepth({
      executableTier: undefined,
      fillableUsd: 500,
      slippagePp: 0,
      depthLevels: 4,
    })).toBe(false);
  });
});
