import type { PaperPosition } from '@nemesis/core';

/** Settle paper positions at binary outcome (1 = YES wins, 0 = NO wins). */
export function settlePaperPosition(
  pos: PaperPosition,
  outcome: 0 | 1,
): { exitPrice: number; pnl: number } {
  const exitPrice = pos.side === 'yes' ? outcome : 1 - outcome;
  const proceeds = exitPrice * pos.contracts;
  const costBasis = pos.entryPrice * pos.contracts + pos.fees;
  return { exitPrice, pnl: proceeds - costBasis };
}
