import { describe, expect, it } from 'vitest';
import { dryRunCloseFill, dryRunFill, reconcilePositions } from '../src/index.js';

describe('execution', () => {
  it('dry runs fill', () => {
    const r = dryRunFill(
      { ticker: 'T', yes: [], no: [{ price: 0.65, quantity: 5 }], yesAsk: 0.35 },
      'yes',
      5,
      0.42,
    );
    expect(r.aborted).toBe(false);
    expect(r.filled).toBe(5);
  });

  it('prices paper closes from the executable close-side bid ladder', () => {
    const r = dryRunCloseFill(
      {
        ticker: 'T',
        yes: [
          { price: 0.48, quantity: 3 },
          { price: 0.46, quantity: 7 },
        ],
        no: [],
        yesAsk: 0.55,
      },
      'yes',
      5,
      0.5,
    );

    expect(r.aborted).toBe(false);
    expect(r.fillPrice).toBeCloseTo(0.472);
    expect(r.slippage).toBeCloseTo(0.008);
  });

  it('detects reconcile mismatch', () => {
    const m = reconcilePositions(
      [{ ticker: 'T', side: 'yes', contracts: 10, avgPrice: 0.3 }],
      [{ ticker: 'T', position: 5, market_exposure: 3 }],
    );
    expect(m.length).toBe(1);
  });
});
