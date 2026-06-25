import { describe, expect, it } from 'vitest';
import { kalshiFeeForOrder } from '../fees/kalshiFee.js';
import {
  markToMarketPortfolio,
  positionUnrealizedPnl,
  positionUnrealizedPnlPerContract,
  unrealizedPnlAtMark,
} from './pnl.js';
import type { PaperPosition } from './types.js';

function samplePosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: 'p1',
    thesisId: 't1',
    ticker: 'DEMO-1',
    title: 'Demo market',
    side: 'yes',
    contracts: 10,
    entryPrice: 0.4,
    fees: kalshiFeeForOrder(0.4, 10),
    openedAt: Date.now(),
    playbook: 'flow-hunter',
    ...overrides,
  };
}

describe('pnl fee math', () => {
  it('positionUnrealizedPnl subtracts entry and exit fees', () => {
    const pos = samplePosition();
    const mark = 0.5;
    const exitFees = kalshiFeeForOrder(mark, pos.contracts);
    const expected = mark * pos.contracts - exitFees - (pos.entryPrice * pos.contracts + pos.fees);
    expect(positionUnrealizedPnl(pos, mark)).toBeCloseTo(expected, 6);
  });

  it('positionUnrealizedPnl is negative when mark equals entry', () => {
    const pos = samplePosition({ entryPrice: 0.45, fees: kalshiFeeForOrder(0.45, 10) });
    expect(positionUnrealizedPnl(pos, 0.45)).toBeLessThan(0);
  });

  it('positionUnrealizedPnlPerContract matches total for one contract', () => {
    const pos = samplePosition({ contracts: 1, fees: kalshiFeeForOrder(0.4, 1) });
    const mark = 0.48;
    const total = positionUnrealizedPnlPerContract(mark, pos.entryPrice, 1, pos.fees, pos.side);
    expect(total).toBeCloseTo(positionUnrealizedPnl(pos, mark), 6);
  });

  it('unrealizedPnlAtMark scales per-contract fee across qty', () => {
    const contracts = 5;
    const entry = 0.42;
    const mark = 0.5;
    const perContractExitFee = kalshiFeeForOrder(mark, contracts) / contracts;
    const expected = (mark - perContractExitFee - entry) * contracts;
    expect(unrealizedPnlAtMark(mark, entry, contracts)).toBeCloseTo(expected, 6);
  });

  it('markToMarketPortfolio sums equity, unrealized, and deployed', () => {
    const positions = [
      samplePosition({ ticker: 'A', contracts: 5, entryPrice: 0.3, fees: kalshiFeeForOrder(0.3, 5) }),
      samplePosition({ id: 'p2', ticker: 'B', contracts: 8, entryPrice: 0.55, fees: kalshiFeeForOrder(0.55, 8) }),
    ];
    const marks = new Map([
      ['A', 0.35],
      ['B', 0.6],
    ]);
    const cash = 750;
    const { equity, unrealized, deployed } = markToMarketPortfolio(positions, marks, cash);
    const expectedUnrealized = positions.reduce(
      (sum, pos) => sum + positionUnrealizedPnl(pos, marks.get(pos.ticker)!),
      0,
    );
    const expectedDeployed = positions.reduce((sum, pos) => sum + pos.entryPrice * pos.contracts, 0);
    expect(unrealized).toBeCloseTo(expectedUnrealized, 6);
    expect(deployed).toBeCloseTo(expectedDeployed, 6);
    expect(equity).toBeCloseTo(cash + expectedDeployed + expectedUnrealized, 6);
  });

  it('markToMarketPortfolio falls back to entry price when mark missing', () => {
    const pos = samplePosition();
    const mtm = markToMarketPortfolio([pos], new Map(), 900);
    expect(mtm.unrealized).toBeCloseTo(positionUnrealizedPnl(pos, pos.entryPrice), 6);
  });
});
