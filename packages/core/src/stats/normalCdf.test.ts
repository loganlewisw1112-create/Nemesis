import { describe, expect, it } from 'vitest';
import { normalCdf } from './normalCdf.js';

describe('normalCdf', () => {
  it('matches common standard-normal reference points', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('is monotonic and approaches the tails', () => {
    expect(normalCdf(-3)).toBeLessThan(normalCdf(-1));
    expect(normalCdf(-1)).toBeLessThan(normalCdf(0));
    expect(normalCdf(0)).toBeLessThan(normalCdf(1));
    expect(normalCdf(1)).toBeLessThan(normalCdf(3));
    expect(normalCdf(-8)).toBeLessThan(0.000001);
    expect(normalCdf(8)).toBeGreaterThan(0.999999);
  });

  it('preserves symmetry', () => {
    for (const x of [0.25, 1, 2.5]) {
      expect(normalCdf(-x)).toBeCloseTo(1 - normalCdf(x), 6);
    }
  });
});
