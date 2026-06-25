import { describe, expect, it } from 'vitest';
import { ExecutionSim, MetricsEngine, ReplayEngine, SandboxPortfolio } from './index.js';

describe('simulation-core', () => {
  it('hard-disables live trading in sandbox portfolio by default', () => {
    expect(() => new SandboxPortfolio({ liveTradingAllowed: true })).toThrow(/disabled/);
    const portfolio = new SandboxPortfolio({ startingBalance: 1_000 });
    expect(portfolio.snapshot().cash).toBe(1_000);
    expect(portfolio.canRouteLiveOrders()).toBe(false);
  });

  it('simulates fills with spread, depth, slippage, and fees', () => {
    const fill = ExecutionSim.simulateFill({
      ticker: 'KXTEST-26',
      side: 'yes',
      qty: 8,
      book: {
        ticker: 'KXTEST-26',
        yes: [
          { price: 0.42, quantity: 5 },
          { price: 0.45, quantity: 10 },
        ],
        no: [],
        spread: 0.03,
      },
    });

    expect(fill.aborted).toBe(false);
    expect(fill.fill_price).toBeCloseTo(0.43125, 5);
    expect(fill.slippage).toBeCloseTo(0.01125, 5);
    expect(fill.fees).toBeGreaterThan(0);
  });

  it('keeps sandbox fills isolated from external paper desks', () => {
    const portfolio = new SandboxPortfolio({ startingBalance: 100 });
    const fill = ExecutionSim.simulateFill({
      ticker: 'KXTEST-26',
      side: 'yes',
      qty: 3,
      book: { ticker: 'KXTEST-26', yes: [{ price: 0.2, quantity: 5 }], no: [] },
    });

    portfolio.applyFill(fill);

    expect(portfolio.snapshot().cash).toBeLessThan(100);
    expect(portfolio.snapshot().positions[0]).toMatchObject({ ticker: 'KXTEST-26', side: 'yes', contracts: 3 });
  });

  it('computes calibration and pnl metrics', () => {
    const metrics = MetricsEngine.summarize([
      { predicted: 0.7, actual: 1, pnl: 12, edgeCaptured: 0.05, blocked: false, shouldBlock: false },
      { predicted: 0.3, actual: 0, pnl: -2, edgeCaptured: 0.01, blocked: true, shouldBlock: true },
    ]);

    expect(metrics.pnl).toBe(10);
    expect(metrics.hit_rate).toBe(1);
    expect(metrics.blocked_ticket_accuracy).toBe(1);
    expect(metrics.brier_score).toBeCloseTo(0.09, 5);
  });

  it('replays events in timestamp order at requested speed', () => {
    const engine = new ReplayEngine([
      { id: 'late', timestamp: 300, type: 'trade', payload: { price: 0.5 } },
      { id: 'early', timestamp: 100, type: 'snapshot', payload: { price: 0.4 } },
    ]);

    expect(engine.seek(0).map((e) => e.id)).toEqual([]);
    expect(engine.step(2, 100).map((e) => e.id)).toEqual(['early']);
    expect(engine.step(2, 100).map((e) => e.id)).toEqual(['late']);
  });
});
