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

export interface SettlementDecision {
  exitPrice: 0 | 1;
  result: 'yes' | 'no';
}

/**
 * Decide whether an open paper position can be settled from market metadata.
 * Kalshi reports market lifecycle via `status` and the resolved outcome via
 * `result` ('yes' | 'no', empty until determination). A position settles only
 * once the outcome is known — 'closed' alone means trading has halted, not
 * that the market resolved, so it never settles a position by itself.
 * Settlement exits bypass the orderbook entirely (the book no longer exists
 * for a resolved market); exit price is the binary payout, and the standard
 * Kalshi fee formula charges $0 at prices 0 and 1, matching the exchange's
 * real no-settlement-fee behavior.
 */
export function resolveSettlement(
  marketStatus: string | undefined,
  marketResult: string | undefined,
  side: 'yes' | 'no',
): SettlementDecision | null {
  const status = (marketStatus ?? '').toLowerCase();
  const result = (marketResult ?? '').toLowerCase();
  if (status !== 'settled' && status !== 'finalized' && status !== 'determined') return null;
  if (result !== 'yes' && result !== 'no') return null;
  return { exitPrice: result === side ? 1 : 0, result };
}
