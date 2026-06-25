import { kalshiFeeForOrder, walkBookFill } from '@nemesis/core';
import type { ExecutionSimFill, ExecutionSimRequest } from './types.js';

export class ExecutionSim {
  static simulateFill(request: ExecutionSimRequest): ExecutionSimFill {
    const levels = request.side === 'yes' ? request.book.yes : request.book.no;
    const walk = walkBookFill(levels, request.qty);
    const spread = request.book.spread ?? 0;
    if (!walk) {
      return {
        id: `fill-${request.ticker}-${Date.now()}`,
        ticker: request.ticker,
        side: request.side,
        qty: request.qty,
        fill_price: 0,
        slippage: 0,
        spread,
        fees: 0,
        aborted: true,
        abortReason: 'insufficient depth',
        filled_at: Date.now(),
      };
    }
    return {
      id: `fill-${request.ticker}-${Date.now()}`,
      ticker: request.ticker,
      side: request.side,
      qty: walk.filled,
      fill_price: walk.avgPrice,
      slippage: walk.slippage,
      spread,
      fees: kalshiFeeForOrder(walk.avgPrice, walk.filled),
      aborted: false,
      filled_at: Date.now(),
    };
  }
}
