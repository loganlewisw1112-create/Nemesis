import { describe, expect, it } from 'vitest';
import { scanMarketTheses } from './edge-scanner.js';

// A genuine favorite (>= 0.85), with a tight spread so the small,
// evidence-scaled favorite-longshot correction can clear fees + spread.
const extremeInput = {
  ticker: 'SCAN-1',
  title: 'Test market',
  category: 'general',
  marketPrice: 0.03, // "no" side sits at 0.97 -- a favorite
  spread: 0.005,
  depthUsd: 400,
};

// A mid-range price where no documented bias applies.
const midRangeInput = {
  ticker: 'SCAN-2',
  title: 'Mid-range market',
  category: 'general',
  marketPrice: 0.4,
  spread: 0.02,
  depthUsd: 400,
};

describe('edge-scanner', () => {
  it('returns a card for the bias-consistent side at a genuine price extreme', () => {
    const cards = scanMarketTheses(extremeInput);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.playbook === 'flow-hunter')).toBe(true);
    expect(cards.some((c) => c.netEdge >= 0.01)).toBe(true);
    // The longshot "yes" side (3%) should be faded, not bought -- only the
    // favorite "no" side (97%) reflects the documented correction.
    expect(cards.every((c) => c.side === 'no')).toBe(true);
  });

  it('does not fabricate an edge in the mid-range where no bias is documented', () => {
    const cards = scanMarketTheses(midRangeInput);
    expect(cards).toHaveLength(0);
  });

  it('respects custom minNetEdge', () => {
    const cards = scanMarketTheses({ ...extremeInput, minNetEdge: 0.5 });
    expect(cards).toHaveLength(0);
  });

  it('supports a lower minNetEdge threshold', () => {
    const cards = scanMarketTheses({ ...extremeInput, minNetEdge: 0.005 });
    expect(cards.length).toBeGreaterThan(0);
  });

  it('only ever returns cards with a real fair-value gap', () => {
    const cards = scanMarketTheses({ ...extremeInput, minNetEdge: 0.001 });
    for (const card of cards) {
      expect(card.impliedPrice).toBeGreaterThan(card.marketPrice + 0.005);
    }
  });

  it('includes fee estimate and edge drivers on each card', () => {
    const [card] = scanMarketTheses(extremeInput);
    expect(card.feeEstimate).toBeGreaterThan(0);
    expect(card.drivers.some((d) => d.label === 'Fair value gap')).toBe(true);
    expect(card.drivers.some((d) => d.label === 'Fees + spread')).toBe(true);
  });
});
