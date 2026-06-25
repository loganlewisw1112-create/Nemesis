import { describe, expect, it } from 'vitest';
import { scanMarketTheses } from './edge-scanner.js';

const baseInput = {
  ticker: 'SCAN-1',
  title: 'Test market',
  category: 'general',
  marketPrice: 0.2,
  spread: 0.02,
  depthUsd: 400,
};

describe('edge-scanner', () => {
  it('returns tradeable cards when net edge clears threshold', () => {
    const cards = scanMarketTheses(baseInput);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.playbook === 'flow-hunter')).toBe(true);
    expect(cards.some((c) => c.netEdge >= 0.01)).toBe(true);
  });

  it('respects custom minNetEdge', () => {
    const cards = scanMarketTheses({ ...baseInput, minNetEdge: 0.5 });
    expect(cards).toHaveLength(0);
  });

  it('supports demo-style lower minNetEdge', () => {
    const cards = scanMarketTheses({ ...baseInput, minNetEdge: 0.008 });
    expect(cards.length).toBeGreaterThan(0);
  });

  it('skips sides without fair-value gap', () => {
    const cards = scanMarketTheses({
      ...baseInput,
      marketPrice: 0.9,
      minNetEdge: 0.001,
    });
    for (const card of cards) {
      expect(card.impliedPrice).toBeGreaterThan(card.marketPrice + 0.005);
    }
  });

  it('scans both yes and no sides when both qualify', () => {
    const cards = scanMarketTheses({ ...baseInput, minNetEdge: 0.008 });
    const sides = new Set(cards.map((c) => c.side));
    expect(sides.size).toBeGreaterThanOrEqual(1);
    expect([...sides].every((s) => s === 'yes' || s === 'no')).toBe(true);
  });

  it('includes fee estimate and edge drivers on each card', () => {
    const [card] = scanMarketTheses(baseInput);
    expect(card.feeEstimate).toBeGreaterThan(0);
    expect(card.drivers.some((d) => d.label === 'Fair value gap')).toBe(true);
    expect(card.drivers.some((d) => d.label === 'Fees + spread')).toBe(true);
  });
});
