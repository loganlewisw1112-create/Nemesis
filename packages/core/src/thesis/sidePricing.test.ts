import { describe, expect, it } from 'vitest';
import { selectedSidePricing } from './sidePricing.js';

describe('selectedSidePricing', () => {
  it('keeps YES prices when model fair value is above the market', () => {
    expect(selectedSidePricing(0.4, 0.55)).toEqual({
      side: 'yes', marketPrice: 0.4, impliedPrice: 0.55,
    });
  });

  it('converts both prices into NO-contract terms', () => {
    expect(selectedSidePricing(0.7, 0.55)).toEqual({
      side: 'no', marketPrice: 0.3, impliedPrice: 0.45,
    });
  });
});
