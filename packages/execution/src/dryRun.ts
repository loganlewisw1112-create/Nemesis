import { walkBookFill, kalshiFeeForOrder } from '@nemesis/core';
import type { KalshiOrderbook } from '@nemesis/core';

export interface DryRunOrder {
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  expectedPrice: number;
  fillPrice: number;
  filled: number;
  slippage: number;
  fees: number;
  netEdge: number;
  aborted: boolean;
  abortReason?: string;
}

export function dryRunFill(
  book: KalshiOrderbook,
  side: 'yes' | 'no',
  contracts: number,
  impliedPrice: number,
  maxSlippagePp = 0.03,
): DryRunOrder {
  const levels = side === 'yes'
    ? (book.yesAsk !== undefined
        ? [{ price: book.yesAsk, quantity: 1000 }]
        : book.yes.map((l) => ({ price: l.price, quantity: l.quantity })))
    : (book.noAsk !== undefined
        ? [{ price: book.noAsk, quantity: 1000 }]
        : book.no.map((l) => ({ price: l.price, quantity: l.quantity })));

  const walk = walkBookFill(levels, contracts);
  if (!walk) {
    return {
      ticker: book.ticker,
      side,
      contracts,
      expectedPrice: impliedPrice,
      fillPrice: 0,
      filled: 0,
      slippage: 0,
      fees: 0,
      netEdge: 0,
      aborted: true,
      abortReason: 'insufficient depth',
    };
  }

  if (walk.slippage > maxSlippagePp) {
    return {
      ticker: book.ticker,
      side,
      contracts,
      expectedPrice: impliedPrice,
      fillPrice: walk.avgPrice,
      filled: walk.filled,
      slippage: walk.slippage,
      fees: kalshiFeeForOrder(walk.avgPrice, walk.filled),
      netEdge: impliedPrice - walk.avgPrice - walk.slippage,
      aborted: true,
      abortReason: 'slippage exceeded',
    };
  }

  const fees = kalshiFeeForOrder(walk.avgPrice, walk.filled);
  return {
    ticker: book.ticker,
    side,
    contracts,
    expectedPrice: impliedPrice,
    fillPrice: walk.avgPrice,
    filled: walk.filled,
    slippage: walk.slippage,
    fees,
    netEdge: impliedPrice - walk.avgPrice - fees / walk.filled,
    aborted: false,
  };
}

export function dryRunCloseFill(
  book: KalshiOrderbook,
  side: 'yes' | 'no',
  contracts: number,
  expectedPrice: number,
  maxSlippagePp = 0.03,
): DryRunOrder {
  const levels = side === 'yes'
    ? book.yes.map((l) => ({ price: l.price, quantity: l.quantity })).sort((a, b) => b.price - a.price)
    : book.no.map((l) => ({ price: l.price, quantity: l.quantity })).sort((a, b) => b.price - a.price);

  const walk = walkBookFill(levels, contracts);
  if (!walk) {
    return {
      ticker: book.ticker,
      side,
      contracts,
      expectedPrice,
      fillPrice: 0,
      filled: 0,
      slippage: 0,
      fees: 0,
      netEdge: 0,
      aborted: true,
      abortReason: 'insufficient close-side depth',
    };
  }

  const bestBid = levels[0]?.price ?? walk.avgPrice;
  const closeSlippage = Math.max(0, bestBid - walk.avgPrice);
  if (closeSlippage > maxSlippagePp) {
    return {
      ticker: book.ticker,
      side,
      contracts,
      expectedPrice,
      fillPrice: walk.avgPrice,
      filled: walk.filled,
      slippage: closeSlippage,
      fees: kalshiFeeForOrder(walk.avgPrice, walk.filled),
      netEdge: walk.avgPrice - expectedPrice - closeSlippage,
      aborted: true,
      abortReason: 'close-side slippage exceeded',
    };
  }

  const fees = kalshiFeeForOrder(walk.avgPrice, walk.filled);
  return {
    ticker: book.ticker,
    side,
    contracts,
    expectedPrice,
    fillPrice: walk.avgPrice,
    filled: walk.filled,
    slippage: closeSlippage,
    fees,
    netEdge: walk.avgPrice - expectedPrice - fees / walk.filled,
    aborted: false,
  };
}

export function requoteGuard(
  originalEdge: number,
  currentEdge: number,
  tolerancePp = 0.02,
): { ok: boolean; reason?: string } {
  if (currentEdge < originalEdge - tolerancePp) {
    return { ok: false, reason: 'edge degraded beyond tolerance' };
  }
  return { ok: true };
}
