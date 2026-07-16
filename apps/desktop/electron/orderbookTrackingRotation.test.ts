import { describe, expect, it } from 'vitest';
import { selectBoundedOrderbookTracking } from './orderbookTrackingRotation.js';

const base = {
  critical: [] as string[],
  current: [] as string[],
  desired: [] as string[],
  now: 1_000,
  lastRotationAt: 0,
  cursor: 0,
  limit: 5,
  rotationIntervalMs: 300_000,
  rotationBatchSize: 2,
};

describe('selectBoundedOrderbookTracking', () => {
  it('fills once and remains sticky before the controlled rotation interval', () => {
    const initial = selectBoundedOrderbookTracking({ ...base, desired: ['A', 'B', 'C', 'D', 'E'] });
    const next = selectBoundedOrderbookTracking({
      ...base,
      current: initial.tickers,
      desired: ['F', 'G'],
      now: 120_000,
      lastRotationAt: initial.lastRotationAt,
    });
    expect(next.tickers).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(next.rotated).toBe(false);
  });

  it('rotates only the configured batch after the interval', () => {
    const result = selectBoundedOrderbookTracking({
      ...base,
      current: ['A', 'B', 'C', 'D', 'E'],
      desired: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      now: 301_000,
      lastRotationAt: 1_000,
    });
    expect(result.tickers).toEqual(['A', 'B', 'C', 'F', 'G']);
    expect(result.rotated).toBe(true);
  });

  it('pins new campaign-critical tickers immediately without exceeding the limit', () => {
    const result = selectBoundedOrderbookTracking({
      ...base,
      critical: ['X', 'Y'],
      current: ['A', 'B', 'C', 'D', 'E'],
      desired: ['A', 'B', 'C', 'D', 'E'],
      now: 20_000,
      lastRotationAt: 1_000,
    });
    expect(result.tickers).toEqual(['X', 'Y', 'A', 'B', 'C']);
    expect(result.rotated).toBe(false);
  });

  it('fills and rotates an exact 25-ticker set while retaining campaign-critical markets', () => {
    const desired = Array.from({ length: 32 }, (_, index) => `LIVE-${index}`);
    const initial = selectBoundedOrderbookTracking({
      ...base,
      limit: 25,
      critical: ['CRITICAL-A', 'CRITICAL-B'],
      desired,
    });
    expect(initial.tickers).toHaveLength(25);
    expect(new Set(initial.tickers).size).toBe(25);
    expect(initial.tickers.slice(0, 2)).toEqual(['CRITICAL-A', 'CRITICAL-B']);

    const rotated = selectBoundedOrderbookTracking({
      ...base,
      limit: 25,
      critical: ['CRITICAL-A', 'CRITICAL-B'],
      current: initial.tickers,
      desired: [...initial.tickers, ...Array.from({ length: 8 }, (_, index) => `NEXT-${index}`)],
      now: initial.lastRotationAt + 300_000,
      lastRotationAt: initial.lastRotationAt,
    });
    expect(rotated.rotated).toBe(true);
    expect(rotated.tickers).toHaveLength(25);
    expect(new Set(rotated.tickers).size).toBe(25);
    expect(rotated.tickers.slice(0, 2)).toEqual(['CRITICAL-A', 'CRITICAL-B']);
  });
});
