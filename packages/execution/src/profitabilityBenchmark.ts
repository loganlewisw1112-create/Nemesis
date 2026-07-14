export type BenchmarkStrategy = 'baseline' | 'upgraded';

export interface BenchmarkDecision {
  id: string;
  riskUsd: number;
  netPnlUsd: number;
  maxDrawdownUsd: number;
  closeRegretUsd: number;
  slippageUsd: number;
  falseExit?: boolean;
}

export interface ProfitabilityBenchmarkOptions {
  targetLiftPct?: number;
}

export interface BenchmarkMetrics {
  decisions: number;
  riskUsd: number;
  netPnlUsd: number;
  pnlPerRiskDollar: number;
  maxDrawdownUsd: number;
  closeRegretUsd: number;
  slippageUsd: number;
  falseExitRate: number;
}

export interface BenchmarkReport {
  baseline: BenchmarkMetrics;
  upgraded: BenchmarkMetrics;
  delta: {
    netPnlUsd: number;
    pnlPerRiskDollarLiftPct: number;
    maxDrawdownUsd: number;
    closeRegretUsd: number;
    slippageUsd: number;
    falseExitRate: number;
  };
  target: {
    liftPct: number;
    passed: boolean;
    blockers: string[];
  };
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function emptyMetrics(): BenchmarkMetrics {
  return {
    decisions: 0,
    riskUsd: 0,
    netPnlUsd: 0,
    pnlPerRiskDollar: 0,
    maxDrawdownUsd: 0,
    closeRegretUsd: 0,
    slippageUsd: 0,
    falseExitRate: 0,
  };
}

function metrics(rows: BenchmarkDecision[]): BenchmarkMetrics {
  if (rows.length === 0) return emptyMetrics();
  const riskUsd = rows.reduce((sum, row) => sum + Math.max(0, row.riskUsd), 0);
  const netPnlUsd = rows.reduce((sum, row) => sum + row.netPnlUsd, 0);
  const falseExits = rows.filter((row) => row.falseExit).length;
  return {
    decisions: rows.length,
    riskUsd: round(riskUsd),
    netPnlUsd: round(netPnlUsd),
    pnlPerRiskDollar: riskUsd > 0 ? round(netPnlUsd / riskUsd) : 0,
    maxDrawdownUsd: round(Math.max(...rows.map((row) => row.maxDrawdownUsd), 0)),
    closeRegretUsd: round(rows.reduce((sum, row) => sum + row.closeRegretUsd, 0) / rows.length),
    slippageUsd: round(rows.reduce((sum, row) => sum + row.slippageUsd, 0) / rows.length),
    falseExitRate: round(falseExits / rows.length),
  };
}

export class ProfitabilityBenchmark {
  private baseline: BenchmarkDecision[] = [];
  private upgraded: BenchmarkDecision[] = [];
  private readonly targetLiftPct: number;

  constructor(options: ProfitabilityBenchmarkOptions = {}) {
    this.targetLiftPct = options.targetLiftPct ?? 80;
  }

  record(strategy: BenchmarkStrategy, decision: BenchmarkDecision): void {
    const row = { ...decision };
    if (strategy === 'baseline') this.baseline.push(row);
    else this.upgraded.push(row);
  }

  recordBaseline(decision: BenchmarkDecision): void {
    this.record('baseline', decision);
  }

  recordUpgraded(decision: BenchmarkDecision): void {
    this.record('upgraded', decision);
  }

  reset(): void {
    this.baseline = [];
    this.upgraded = [];
  }

  report(): BenchmarkReport {
    const baseline = metrics(this.baseline);
    const upgraded = metrics(this.upgraded);
    const lift = baseline.pnlPerRiskDollar === 0
      ? (upgraded.pnlPerRiskDollar > 0 ? Infinity : 0)
      : ((upgraded.pnlPerRiskDollar - baseline.pnlPerRiskDollar) / Math.abs(baseline.pnlPerRiskDollar)) * 100;
    const blockers: string[] = [];

    if (lift < this.targetLiftPct) blockers.push(`risk-adjusted P&L lift below ${this.targetLiftPct}% target`);
    if (upgraded.maxDrawdownUsd > baseline.maxDrawdownUsd) blockers.push('max drawdown worse than baseline');
    if (upgraded.closeRegretUsd > baseline.closeRegretUsd) blockers.push('close regret worse than baseline');
    if (upgraded.slippageUsd > baseline.slippageUsd) blockers.push('slippage worse than baseline');
    if (upgraded.falseExitRate > baseline.falseExitRate) blockers.push('false-exit rate worse than baseline');
    if (baseline.decisions === 0 || upgraded.decisions === 0) blockers.push('insufficient benchmark decisions');

    return {
      baseline,
      upgraded,
      delta: {
        netPnlUsd: round(upgraded.netPnlUsd - baseline.netPnlUsd),
        pnlPerRiskDollarLiftPct: Number.isFinite(lift) ? round(lift) : Infinity,
        maxDrawdownUsd: round(upgraded.maxDrawdownUsd - baseline.maxDrawdownUsd),
        closeRegretUsd: round(upgraded.closeRegretUsd - baseline.closeRegretUsd),
        slippageUsd: round(upgraded.slippageUsd - baseline.slippageUsd),
        falseExitRate: round(upgraded.falseExitRate - baseline.falseExitRate),
      },
      target: {
        liftPct: this.targetLiftPct,
        passed: blockers.length === 0,
        blockers,
      },
    };
  }
}
