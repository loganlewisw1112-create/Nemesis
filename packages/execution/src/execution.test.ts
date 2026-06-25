import { describe, expect, it } from 'vitest';
import { dryRunFill, reconcilePositions } from '../src/index.js';

describe('execution', () => {
  it('dry runs fill', () => {
    const r = dryRunFill(
      { ticker: 'T', yes: [], no: [], yesAsk: 0.35 },
      'yes',
      5,
      0.42,
    );
    expect(r.aborted).toBe(false);
    expect(r.filled).toBe(5);
  });

  it('detects reconcile mismatch', () => {
    const m = reconcilePositions(
      [{ ticker: 'T', side: 'yes', contracts: 10, avgPrice: 0.3 }],
      [{ ticker: 'T', position: 5, market_exposure: 3 }],
    );
    expect(m.length).toBe(1);
  });
});
