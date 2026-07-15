import {
  kalshiFeeForFills,
  kalshiFeeForOrder,
  walkBookFill,
  type BookFillLevel,
  type KalshiOrderbook,
} from '@nemesis/core';

export interface DryRunOrder {
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  expectedPrice: number;
  fillPrice: number;
  filled: number;
  fillLevels: BookFillLevel[];
  slippage: number;
  fees: number;
  feePolicyKnown: boolean;
  netEdge: number;
  aborted: boolean;
  abortReason?: string;
}

function entryLevels(book: KalshiOrderbook, side: 'yes' | 'no') {
  const opposingBids = side === 'yes' ? book.no : book.yes;
  return opposingBids
    .map((level) => ({ price: 1 - level.price, quantity: level.quantity }))
    .sort((a, b) => a.price - b.price);
}

function exitLevels(book: KalshiOrderbook, side: 'yes' | 'no') {
  return (side === 'yes' ? book.yes : book.no)
    .map((level) => ({ price: level.price, quantity: level.quantity }))
    .sort((a, b) => b.price - a.price);
}

function feeForWalk(book: KalshiOrderbook, fills: BookFillLevel[]) {
  const exact = book.feePolicy ? kalshiFeeForFills(fills, book.feePolicy) : null;
  if (exact) return { fees: exact.totalFeeUsd, feePolicyKnown: true };
  return {
    fees: fills.reduce((sum, fill) => sum + kalshiFeeForOrder(fill.price, fill.quantity), 0),
    feePolicyKnown: false,
  };
}

function emptyResult(
  book: KalshiOrderbook,
  side: 'yes' | 'no',
  contracts: number,
  expectedPrice: number,
  reason: string,
): DryRunOrder {
  return {
    ticker: book.ticker,
    side,
    contracts,
    expectedPrice,
    fillPrice: 0,
    filled: 0,
    fillLevels: [],
    slippage: 0,
    fees: 0,
    feePolicyKnown: false,
    netEdge: 0,
    aborted: true,
    abortReason: reason,
  };
}

export function dryRunFill(
  book: KalshiOrderbook,
  side: 'yes' | 'no',
  contracts: number,
  impliedPrice: number,
  maxSlippagePp = 0.03,
): DryRunOrder {
  const levels = entryLevels(book, side);
  const walk = walkBookFill(levels, contracts);
  if (!walk) return emptyResult(book, side, contracts, impliedPrice, 'insufficient depth');

  const fee = feeForWalk(book, walk.fills);
  const partial = !walk.complete;
  const slippageExceeded = walk.slippage > maxSlippagePp;
  const aborted = partial || slippageExceeded;
  const abortReason = partial ? 'insufficient depth for complete fill' : slippageExceeded ? 'slippage exceeded' : undefined;
  return {
    ticker: book.ticker,
    side,
    contracts,
    expectedPrice: impliedPrice,
    fillPrice: walk.avgPrice,
    filled: walk.filled,
    fillLevels: walk.fills,
    slippage: walk.slippage,
    fees: fee.fees,
    feePolicyKnown: fee.feePolicyKnown,
    netEdge: walk.filled > 0 ? impliedPrice - walk.avgPrice - fee.fees / walk.filled : 0,
    aborted,
    abortReason,
  };
}

export function dryRunCloseFill(
  book: KalshiOrderbook,
  side: 'yes' | 'no',
  contracts: number,
  expectedPrice: number,
  maxSlippagePp = 0.03,
): DryRunOrder {
  const levels = exitLevels(book, side);
  const walk = walkBookFill(levels, contracts);
  if (!walk) return emptyResult(book, side, contracts, expectedPrice, 'insufficient close-side depth');

  const bestBid = levels[0]?.price ?? walk.avgPrice;
  const closeSlippage = Math.max(0, bestBid - walk.avgPrice);
  const fee = feeForWalk(book, walk.fills);
  const partial = !walk.complete;
  const slippageExceeded = closeSlippage > maxSlippagePp;
  const aborted = partial || slippageExceeded;
  const abortReason = partial
    ? 'insufficient close-side depth for complete fill'
    : slippageExceeded ? 'close-side slippage exceeded' : undefined;
  return {
    ticker: book.ticker,
    side,
    contracts,
    expectedPrice,
    fillPrice: walk.avgPrice,
    filled: walk.filled,
    fillLevels: walk.fills,
    slippage: closeSlippage,
    fees: fee.fees,
    feePolicyKnown: fee.feePolicyKnown,
    netEdge: walk.avgPrice - expectedPrice - (walk.filled > 0 ? fee.fees / walk.filled : 0),
    aborted,
    abortReason,
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
