import type { ExecutionSimFill, SandboxPortfolioSnapshot, SandboxPosition } from './types.js';

export interface SandboxPortfolioOptions {
  startingBalance?: number;
  liveTradingAllowed?: boolean;
}

export class SandboxPortfolio {
  private cash: number;
  private readonly positions: SandboxPosition[] = [];
  private readonly fills: ExecutionSimFill[] = [];

  constructor(options: SandboxPortfolioOptions = {}) {
    if (options.liveTradingAllowed || process.env.SANDBOX_LIVE_TRADING_ALLOWED === 'true') {
      throw new Error('Sandbox live trading is disabled by hard default');
    }
    this.cash = options.startingBalance ?? 10_000;
  }

  canRouteLiveOrders(): boolean {
    return false;
  }

  applyFill(fill: ExecutionSimFill): SandboxPortfolioSnapshot {
    if (fill.aborted) return this.snapshot();
    const cost = fill.fill_price * fill.qty + fill.fees;
    if (cost > this.cash) throw new Error('insufficient sandbox cash');
    this.cash -= cost;
    this.fills.push(fill);
    const existing = this.positions.find((p) => p.ticker === fill.ticker && p.side === fill.side);
    if (existing) {
      const totalContracts = existing.contracts + fill.qty;
      existing.avgPrice = ((existing.avgPrice * existing.contracts) + (fill.fill_price * fill.qty)) / totalContracts;
      existing.contracts = totalContracts;
    } else {
      this.positions.push({
        ticker: fill.ticker,
        side: fill.side,
        contracts: fill.qty,
        avgPrice: fill.fill_price,
      });
    }
    return this.snapshot();
  }

  snapshot(): SandboxPortfolioSnapshot {
    return {
      cash: this.cash,
      positions: this.positions.map((position) => ({ ...position })),
      fills: this.fills.map((fill) => ({ ...fill })),
    };
  }
}
