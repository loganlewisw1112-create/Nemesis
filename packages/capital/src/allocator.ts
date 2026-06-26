import {
  kalshiFeePerContract,
  walkBookFill,
  type GuardrailSettings,
  type KalshiOrderbook,
  type PaperPortfolio,
  type ThesisCard,
} from '@nemesis/core';

export interface AllocationInput {
  card: ThesisCard;
  maxPositionUsd: number;
  kellyCap?: number;
  midSessionIncreaseBlocked?: boolean;
}

export function allocateSize(input: AllocationInput): number {
  const { card, maxPositionUsd, kellyCap = 0.25 } = input;
  if (input.midSessionIncreaseBlocked) return Math.min(maxPositionUsd * 0.5, maxPositionUsd);
  const edgeFactor = Math.max(0, Math.min(1, card.netEdge * 10));
  const predFactor = card.predictability / 100;
  const raw = maxPositionUsd * kellyCap * edgeFactor * predFactor;
  return Math.max(1, Math.round(raw * 100) / 100);
}

export interface CapitalAllocationSettings {
  maxKellyFraction: number;
  maxPositionUsd: number;
  maxPortfolioConcentrationPct: number;
  maxSlippagePp: number;
  minExpectedProfitCents: number;
  maxFreshnessMs: number;
  requireProtectableExit: boolean;
  maxContracts: number;
  maxExchangeSubmitRttMs: number;
}

export interface CapitalDecision {
  contracts: number;
  maxSafeContracts: number;
  entryLimitCents: number;
  protectiveExitCents: number;
  expectedNetProfitCents: number;
  riskUsd: number;
  reasons: string[];
  noTradeReasons: string[];
  latencyMs: number;
}

export interface CapitalDecisionInput {
  card: ThesisCard;
  portfolio: PaperPortfolio;
  settings: GuardrailSettings;
  book?: KalshiOrderbook;
  allocation?: Partial<CapitalAllocationSettings>;
  dailyPnl?: number;
  unresolvedMistake?: boolean;
  exchangeSubmitRttMs?: number;
}

export const DEFAULT_CAPITAL_ALLOCATION_SETTINGS: CapitalAllocationSettings = {
  maxKellyFraction: 0.25,
  maxPositionUsd: 10,
  maxPortfolioConcentrationPct: 0.12,
  maxSlippagePp: 0.03,
  minExpectedProfitCents: 1,
  maxFreshnessMs: 30_000,
  requireProtectableExit: true,
  maxContracts: 50,
  maxExchangeSubmitRttMs: 50,
};

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sidePrice(card: ThesisCard, value: number): number {
  return card.side === 'yes' ? value : 1 - value;
}

function equity(portfolio: PaperPortfolio): number {
  const deployed = portfolio.positions.reduce((sum, pos) => sum + pos.entryPrice * pos.contracts + pos.fees, 0);
  return Math.max(0, portfolio.cash + deployed);
}

function sideLevels(book: KalshiOrderbook, side: 'yes' | 'no', fallbackPrice: number) {
  if (side === 'yes' && book.yesAsk !== undefined) return [{ price: book.yesAsk, quantity: 1000 }];
  if (side === 'no' && book.noAsk !== undefined) return [{ price: book.noAsk, quantity: 1000 }];
  const levels = side === 'yes' ? book.yes : book.no;
  return levels.length > 0 ? levels : [{ price: fallbackPrice, quantity: 0 }];
}

function fillableContracts(
  book: KalshiOrderbook | undefined,
  card: ThesisCard,
  fallbackEntry: number,
  maxContracts: number,
  maxSlippagePp: number,
): number {
  if (!book) {
    const fillableUsd = card.fillableUsd ?? card.depthUsd;
    return Math.max(0, Math.floor(fillableUsd / Math.max(fallbackEntry, 0.01)));
  }
  const levels = sideLevels(book, card.side, fallbackEntry);
  let best = 0;
  for (let qty = 1; qty <= maxContracts; qty += 1) {
    const walk = walkBookFill(levels, qty);
    if (!walk || walk.filled < qty || walk.slippage > maxSlippagePp) break;
    best = qty;
  }
  return best;
}

function bookEntryPrice(book: KalshiOrderbook | undefined, card: ThesisCard): number {
  const fallback = sidePrice(card, card.marketPrice);
  if (!book) return fallback;
  if (card.side === 'yes') return book.yesAsk ?? fallback;
  return book.noAsk ?? fallback;
}

function noTradeDecision(
  start: number,
  entryPrice: number,
  protectiveExit: number,
  reasons: string[],
  noTradeReasons: string[],
): CapitalDecision {
  return {
    contracts: 0,
    maxSafeContracts: 0,
    entryLimitCents: Math.round(entryPrice * 100),
    protectiveExitCents: Math.round(protectiveExit * 100),
    expectedNetProfitCents: 0,
    riskUsd: 0,
    reasons,
    noTradeReasons,
    latencyMs: Number((nowMs() - start).toFixed(4)),
  };
}

export function decideCapitalAllocation(input: CapitalDecisionInput): CapitalDecision {
  const start = nowMs();
  const allocation = {
    ...DEFAULT_CAPITAL_ALLOCATION_SETTINGS,
    maxPositionUsd: input.settings.maxPositionUsd,
    maxSlippagePp: input.settings.maxSlippagePp,
    ...input.allocation,
  };
  const reasons: string[] = [];
  const noTradeReasons: string[] = [];
  const entryPrice = bookEntryPrice(input.book, input.card);
  const slippagePp = input.card.slippagePp ?? Math.max(0, input.card.spread / 2);
  const feePerContract = kalshiFeePerContract(entryPrice);
  const impliedSidePrice = sidePrice(input.card, input.card.impliedPrice);
  const edgePerContract = impliedSidePrice - entryPrice - feePerContract - slippagePp;
  const minProfitUsd = allocation.minExpectedProfitCents / 100;
  const protectiveExit = Math.min(0.99, entryPrice + feePerContract + minProfitUsd);

  if (input.unresolvedMistake) noTradeReasons.push('unresolved mistake signature');
  if (input.card.freshnessMs > allocation.maxFreshnessMs) noTradeReasons.push('stale book');
  if (input.exchangeSubmitRttMs !== undefined && input.exchangeSubmitRttMs > allocation.maxExchangeSubmitRttMs) {
    noTradeReasons.push('slow exchange path');
  }
  if (slippagePp > allocation.maxSlippagePp) noTradeReasons.push('excessive slippage');
  if (edgePerContract < minProfitUsd) noTradeReasons.push('insufficient protected profit');
  if (allocation.requireProtectableExit && protectiveExit > impliedSidePrice) {
    if (!noTradeReasons.includes('insufficient protected profit')) noTradeReasons.push('insufficient protected profit');
  }

  const fillable = fillableContracts(input.book, input.card, entryPrice, allocation.maxContracts, allocation.maxSlippagePp);
  if (fillable < 1 || (input.card.fillableUsd ?? input.card.depthUsd) < 25) noTradeReasons.push('insufficient liquidity');

  const dailyLossRoom = input.settings.dailyLossCapUsd + Math.min(0, input.dailyPnl ?? 0);
  if (dailyLossRoom <= 0) noTradeReasons.push('daily loss cap breached');
  if (input.portfolio.cash <= 0) noTradeReasons.push('insufficient paper cash');

  if (noTradeReasons.length > 0) {
    return noTradeDecision(start, entryPrice, protectiveExit, reasons, [...new Set(noTradeReasons)]);
  }

  const confidence = input.card.predictability > 1
    ? clamp(input.card.predictability / 100)
    : clamp(input.card.predictability);
  const edgeFactor = clamp(edgePerContract / 0.1);
  const portfolioEquity = equity(input.portfolio);
  const positionCapUsd = Math.min(allocation.maxPositionUsd, input.settings.maxPositionUsd);
  const concentrationCapUsd = portfolioEquity * allocation.maxPortfolioConcentrationPct;
  const kellyCapUsd = positionCapUsd * allocation.maxKellyFraction * confidence * Math.max(0.05, edgeFactor);
  const costPerContract = entryPrice + feePerContract;
  const safeUsd = Math.max(0, Math.min(
    input.portfolio.cash,
    positionCapUsd,
    concentrationCapUsd,
    dailyLossRoom,
    kellyCapUsd,
  ));
  const byUsd = Math.floor(safeUsd / Math.max(costPerContract, 0.01));
  const maxSafeContracts = Math.max(0, Math.min(allocation.maxContracts, fillable, byUsd));
  const expectedNetProfitCents = Math.max(0, edgePerContract * maxSafeContracts * 100);
  const riskUsd = maxSafeContracts * costPerContract;

  if (maxSafeContracts < 1) {
    return noTradeDecision(start, entryPrice, protectiveExit, reasons, ['insufficient liquidity']);
  }

  reasons.push('fee/slippage adjusted edge positive');
  reasons.push('fillable depth inside slippage budget');
  if (allocation.requireProtectableExit) reasons.push('protective exit path priced');

  return {
    contracts: maxSafeContracts,
    maxSafeContracts,
    entryLimitCents: Math.round(entryPrice * 100),
    protectiveExitCents: Math.round(protectiveExit * 100),
    expectedNetProfitCents: Number(expectedNetProfitCents.toFixed(4)),
    riskUsd: Number(riskUsd.toFixed(4)),
    reasons,
    noTradeReasons: [],
    latencyMs: Number((nowMs() - start).toFixed(4)),
  };
}

export interface ExposureCheck {
  ticker: string;
  eventTicker?: string;
  category: string;
}

export function checkConcentration(
  existing: ExposureCheck[],
  candidate: ExposureCheck,
  maxPerEvent = 2,
  maxPerCategory = 4,
): { blocked: boolean; reason?: string } {
  const sameEvent = existing.filter((e) => e.eventTicker && e.eventTicker === candidate.eventTicker).length;
  if (candidate.eventTicker && sameEvent >= maxPerEvent) {
    return { blocked: true, reason: 'event concentration limit' };
  }
  const sameCat = existing.filter((e) => e.category === candidate.category).length;
  if (sameCat >= maxPerCategory) {
    return { blocked: true, reason: 'category concentration limit' };
  }
  return { blocked: false };
}
