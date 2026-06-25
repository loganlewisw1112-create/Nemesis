import { kalshiFeeForOrder } from '../fees/kalshiFee.js';
import type { PaperPosition } from './types.js';

export function positionUnrealizedPnl(pos: PaperPosition, mark: number): number {
  const exitFees = kalshiFeeForOrder(mark, pos.contracts);
  const proceeds = mark * pos.contracts - exitFees;
  const costBasis = pos.entryPrice * pos.contracts + pos.fees;
  return proceeds - costBasis;
}

export function positionUnrealizedPnlPerContract(
  mark: number,
  entryPrice: number,
  contracts: number,
  entryFees: number,
  side: 'yes' | 'no',
): number {
  void side;
  const exitFees = kalshiFeeForOrder(mark, contracts);
  return (mark * contracts - exitFees) - (entryPrice * contracts + entryFees);
}

export function unrealizedPnlAtMark(
  mark: number,
  entryPrice: number,
  contracts: number,
): number {
  const exitFees = kalshiFeeForOrder(mark, contracts) / contracts;
  return (mark - exitFees - entryPrice) * contracts;
}

export function markToMarketPortfolio(
  positions: PaperPosition[],
  markPrices: Map<string, number>,
  cash: number,
): { equity: number; unrealized: number; deployed: number } {
  let unrealized = 0;
  let deployed = 0;
  for (const pos of positions) {
    const mark = markPrices.get(pos.ticker) ?? pos.entryPrice;
    unrealized += positionUnrealizedPnl(pos, mark);
    deployed += pos.entryPrice * pos.contracts;
  }
  return { equity: cash + deployed + unrealized, unrealized, deployed };
}
