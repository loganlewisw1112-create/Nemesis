import { describe, expect, it } from 'vitest';
import { ProfitabilityBenchmark } from './profitabilityBenchmark.js';

describe('ProfitabilityBenchmark', () => {
  it('reports target lift in risk-adjusted paper P&L against baseline', () => {
    const benchmark = new ProfitabilityBenchmark({ targetLiftPct: 80 });
    benchmark.recordBaseline({
      id: 'b1',
      riskUsd: 100,
      netPnlUsd: 5,
      maxDrawdownUsd: 8,
      closeRegretUsd: 4,
      slippageUsd: 2,
      falseExit: true,
    });
    benchmark.recordUpgraded({
      id: 'u1',
      riskUsd: 100,
      netPnlUsd: 10,
      maxDrawdownUsd: 6,
      closeRegretUsd: 2,
      slippageUsd: 1,
      falseExit: false,
    });

    const report = benchmark.report();

    expect(report.baseline.pnlPerRiskDollar).toBeCloseTo(0.05, 4);
    expect(report.upgraded.pnlPerRiskDollar).toBeCloseTo(0.1, 4);
    expect(report.delta.pnlPerRiskDollarLiftPct).toBeCloseTo(100, 4);
    expect(report.target.passed).toBe(true);
  });

  it('does not pass target when profit lift comes with worse drawdown or regret', () => {
    const benchmark = new ProfitabilityBenchmark({ targetLiftPct: 80 });
    benchmark.recordBaseline({
      id: 'b1',
      riskUsd: 100,
      netPnlUsd: 5,
      maxDrawdownUsd: 6,
      closeRegretUsd: 2,
      slippageUsd: 1,
      falseExit: false,
    });
    benchmark.recordUpgraded({
      id: 'u1',
      riskUsd: 100,
      netPnlUsd: 12,
      maxDrawdownUsd: 12,
      closeRegretUsd: 5,
      slippageUsd: 1,
      falseExit: false,
    });

    const report = benchmark.report();

    expect(report.delta.pnlPerRiskDollarLiftPct).toBeGreaterThan(80);
    expect(report.target.passed).toBe(false);
    expect(report.target.blockers).toEqual(expect.arrayContaining([
      'max drawdown worse than baseline',
      'close regret worse than baseline',
    ]));
  });

  it('compares average slippage fairly when sample counts differ', () => {
    const benchmark = new ProfitabilityBenchmark({ targetLiftPct: 80 });
    benchmark.recordBaseline({
      id: 'b1', riskUsd: 10, netPnlUsd: 1, maxDrawdownUsd: 1, closeRegretUsd: 1, slippageUsd: 1,
    });
    for (let index = 0; index < 3; index += 1) {
      benchmark.recordUpgraded({
        id: `u${index}`, riskUsd: 10, netPnlUsd: 2, maxDrawdownUsd: 1, closeRegretUsd: 1, slippageUsd: 0.5,
      });
    }
    const report = benchmark.report();
    expect(report.baseline.slippageUsd).toBe(1);
    expect(report.upgraded.slippageUsd).toBe(0.5);
    expect(report.target.blockers).not.toContain('slippage worse than baseline');
  });
});
