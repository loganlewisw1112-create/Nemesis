import { describe, expect, it } from 'vitest';
import { unrealizedPnlSeries } from './liveCharts.js';

describe('unrealizedPnlSeries', () => {
  it('includes entry fees in cost basis', () => {
    const ticks = [{ t: 1, yesPrice: 0.5, spread: 0.02, netEdge: 0.01 }];
    const withoutFees = unrealizedPnlSeries(ticks, 0.4, 10, 'yes', 0);
    const withFees = unrealizedPnlSeries(ticks, 0.4, 10, 'yes', 0.5);
    expect(withFees[0]).toBeLessThan(withoutFees[0]);
  });
});
