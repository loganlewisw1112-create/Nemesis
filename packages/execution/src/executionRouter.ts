import type {
  GuardrailSettings,
  KalshiOrderbook,
  PaperPortfolio,
  PaperPosition,
  ThesisCard,
  FillMetadata,
  ProfitCertificate,
} from '@nemesis/core';
import {
  DEFAULT_STRICT_PROFIT_MODE,
  isExecutablePrice,
  kalshiFeeForOrder,
  sanitizeExecutableBook,
} from '@nemesis/core';
import { allocateSize, checkConcentration, decideCapitalAllocation, type CapitalDecision } from '@nemesis/capital';
import { dryRunCloseFill, dryRunFill, type DryRunOrder } from './dryRun.js';
import type { PaperDesk } from './paperDesk.js';

export interface FillQuality {
  expectedPrice: number;
  slippage: number;
  implementationShortfall: number;
  depthLevels: number;
}

export interface PaperBuyResult {
  ok: boolean;
  error?: string;
  fill?: DryRunOrder;
  fillQuality?: FillQuality;
  capitalDecision?: CapitalDecision;
  profitCertificate?: ProfitCertificate;
  aborted?: boolean;
  abortReason?: string;
  abortCode?: string;
  queueState?: 'certified' | 'blocked_retryable' | 'blocked_final' | 'executed';
  wouldMutate?: boolean;
}

export interface PaperCloseResult {
  ok: boolean;
  error?: string;
  pnl?: number;
  fill?: DryRunOrder;
  fillQuality?: FillQuality;
  profitCertificate?: ProfitCertificate;
  abortCode?: string;
  queueState?: 'certified' | 'blocked_retryable' | 'blocked_final' | 'executed';
  wouldMutate?: boolean;
}

function fillQualityFromDryRun(fill: DryRunOrder, expectedPrice: number): FillQuality {
  const shortfall = Math.abs(fill.fillPrice - expectedPrice) * fill.filled + fill.fees;
  return {
    expectedPrice,
    slippage: fill.slippage,
    implementationShortfall: shortfall,
    depthLevels: fill.filled > 0 ? 1 : 0,
  };
}

function fillMeta(_fill: DryRunOrder, quality: FillQuality, profitCertificate?: ProfitCertificate): FillMetadata {
  return {
    expectedPrice: quality.expectedPrice,
    slippage: quality.slippage,
    implementationShortfall: quality.implementationShortfall,
    depthLevels: quality.depthLevels,
    mode: 'paper',
    profitCertificate,
  };
}

function strictProfitSettings(settings: GuardrailSettings) {
  return { ...DEFAULT_STRICT_PROFIT_MODE, ...(settings.strictProfitMode ?? {}) };
}

function abortBuy(
  abortReason: string,
  abortCode: string,
  capitalDecision?: CapitalDecision,
  fill?: DryRunOrder,
  retryable = false,
): PaperBuyResult {
  return {
    ok: false,
    aborted: true,
    abortReason,
    abortCode,
    capitalDecision,
    fill,
    queueState: retryable ? 'blocked_retryable' : 'blocked_final',
    wouldMutate: false,
  };
}

function abortClose(abortReason: string, abortCode: string, fill?: DryRunOrder, retryable = false): PaperCloseResult {
  return {
    ok: false,
    error: abortReason,
    abortCode,
    fill,
    queueState: retryable ? 'blocked_retryable' : 'blocked_final',
    wouldMutate: false,
  };
}

function entryAsk(book: KalshiOrderbook, side: 'yes' | 'no'): number | undefined {
  return side === 'yes' ? book.yesAsk : book.noAsk;
}

function hasCloseDepth(book: KalshiOrderbook, side: 'yes' | 'no'): boolean {
  const levels = side === 'yes' ? book.yes : book.no;
  return levels.some((level) => isExecutablePrice(level.price) && level.quantity > 0);
}

function closePnl(position: PaperPosition, exitPrice: number, contracts: number, exitFees: number): number {
  const feePortion = (position.fees * contracts) / position.contracts;
  const proceeds = exitPrice * contracts - exitFees;
  const costBasis = position.entryPrice * contracts + feePortion;
  return proceeds - costBasis;
}

function certifyOpenProfit(
  card: ThesisCard,
  book: KalshiOrderbook,
  entryFill: DryRunOrder,
  settings: GuardrailSettings,
): ProfitCertificate | null {
  const strict = strictProfitSettings(settings);
  if (!strict.enabled || !strict.requireEntryLiquidationPath) {
    return {
      kind: 'open',
      ticker: card.ticker,
      side: card.side,
      contracts: entryFill.filled,
      entryPrice: entryFill.fillPrice,
      exitPrice: entryFill.fillPrice,
      entryFees: entryFill.fees,
      exitFees: 0,
      netPnlUsd: 0,
      bookTimestamp: Date.now(),
      expiresAt: Date.now() + strict.maxBookAgeMs,
      reason: 'strict profit mode disabled',
    };
  }

  if (!hasCloseDepth(book, card.side)) return null;
  const exitFill = dryRunCloseFill(book, card.side, entryFill.filled, entryFill.fillPrice, settings.maxSlippagePp);
  if (exitFill.aborted || !isExecutablePrice(exitFill.fillPrice)) return null;
  const proceeds = exitFill.fillPrice * exitFill.filled - exitFill.fees;
  const cost = entryFill.fillPrice * entryFill.filled + entryFill.fees;
  const netPnlUsd = Number((proceeds - cost).toFixed(4));
  if (netPnlUsd < strict.minNetPnlUsd) return null;
  const now = Date.now();
  return {
    kind: 'open',
    ticker: card.ticker,
    side: card.side,
    contracts: entryFill.filled,
    entryPrice: entryFill.fillPrice,
    exitPrice: exitFill.fillPrice,
    entryFees: entryFill.fees,
    exitFees: exitFill.fees,
    netPnlUsd,
    bookTimestamp: now,
    expiresAt: now + strict.maxBookAgeMs,
    reason: 'strict profit certified',
  };
}

function certifyCloseProfit(
  position: PaperPosition,
  fill: DryRunOrder,
  settings: GuardrailSettings,
): { certificate: ProfitCertificate; pnl: number } | null {
  if (!isExecutablePrice(fill.fillPrice)) return null;
  const strict = strictProfitSettings(settings);
  const pnl = Number(closePnl(position, fill.fillPrice, fill.filled, fill.fees).toFixed(4));
  if (strict.enabled && pnl < strict.minNetPnlUsd) return null;
  const feePortion = (position.fees * fill.filled) / position.contracts;
  const now = Date.now();
  return {
    pnl,
    certificate: {
      kind: 'close',
      ticker: position.ticker,
      side: position.side,
      contracts: fill.filled,
      entryPrice: position.entryPrice,
      exitPrice: fill.fillPrice,
      entryFees: Number(feePortion.toFixed(4)),
      exitFees: fill.fees,
      netPnlUsd: pnl,
      bookTimestamp: now,
      expiresAt: now + strict.maxBookAgeMs,
      reason: 'strict profit certified',
    },
  };
}

export function resolveContractCount(
  card: ThesisCard,
  portfolio: PaperPortfolio,
  settings: GuardrailSettings,
  contracts?: number,
): number {
  if (contracts !== undefined && contracts >= 1) return Math.floor(contracts);
  const decision = decideCapitalAllocation({ card, portfolio, settings });
  if (decision.contracts > 0) return decision.contracts;
  const usdSize = allocateSize({ card, maxPositionUsd: settings.maxPositionUsd });
  const price = card.side === 'yes' ? card.marketPrice : 1 - card.marketPrice;
  const fee = kalshiFeeForOrder(price, 1);
  const costPer = price + fee;
  return Math.max(0, Math.min(50, Math.floor(usdSize / Math.max(costPer, 0.01))));
}

export function checkPaperRisk(
  card: ThesisCard,
  portfolio: PaperPortfolio,
  settings: GuardrailSettings,
  dailyPnl: number,
): { ok: boolean; error?: string } {
  if (settings.killSwitchActive) return { ok: false, error: 'kill switch active' };
  if (dailyPnl <= -settings.dailyLossCapUsd) {
    return { ok: false, error: 'daily loss cap breached' };
  }
  const exposure = portfolio.positions.map((p) => ({
    ticker: p.ticker,
    eventTicker: p.eventTicker,
    category: p.category ?? 'unknown',
  }));
  const market = portfolio.positions.find((p) => p.ticker === card.ticker);
  const conc = checkConcentration(exposure, {
    ticker: card.ticker,
    eventTicker: market?.eventTicker,
    category: card.category,
  });
  if (conc.blocked) return { ok: false, error: conc.reason };
  return { ok: true };
}

export function simulatePaperBuy(
  desk: PaperDesk,
  card: ThesisCard,
  book: KalshiOrderbook,
  settings: GuardrailSettings,
  contracts?: number,
): PaperBuyResult {
  const portfolio = desk.snapshot();
  const cleanBook = sanitizeExecutableBook(book);
  const expectedPrice = card.side === 'yes' ? card.marketPrice : 1 - card.marketPrice;
  const executableEntry = entryAsk(cleanBook, card.side);
  if (!isExecutablePrice(expectedPrice) || !isExecutablePrice(executableEntry)) {
    return abortBuy('invalid executable price', 'invalid_price');
  }

  const capitalDecision = decideCapitalAllocation({ card, portfolio, settings, book: cleanBook });
  if (capitalDecision.noTradeReasons.length > 0) {
    return abortBuy(capitalDecision.noTradeReasons.join('; '), 'capital_allocator_block', capitalDecision);
  }
  const qty = contracts !== undefined && contracts >= 1 ? Math.floor(contracts) : capitalDecision.contracts;
  if (qty < 1) {
    return abortBuy('capital allocator returned zero safe contracts', 'capital_allocator_block', capitalDecision);
  }
  const fill = dryRunFill(cleanBook, card.side, qty, card.impliedPrice, settings.maxSlippagePp);

  if (fill.aborted) {
    return abortBuy(fill.abortReason ?? 'fill aborted', 'fill_aborted', capitalDecision, fill, true);
  }
  if (!isExecutablePrice(fill.fillPrice)) return abortBuy('invalid executable fill price', 'invalid_price', capitalDecision, fill);

  const certificate = certifyOpenProfit(card, cleanBook, fill, settings);
  if (!certificate) {
    return abortBuy('strict profit certification failed', 'strict_profit_block', capitalDecision, fill);
  }

  const quality = fillQualityFromDryRun(fill, expectedPrice);
  const meta = fillMeta(fill, quality, certificate);
  const result = desk.openPosition(card, fill.filled, fill.fillPrice, meta, card.category);
  if (!result.ok) return { ok: false, error: result.error, capitalDecision, queueState: 'blocked_final', wouldMutate: false };
  return { ok: true, fill, fillQuality: quality, capitalDecision, profitCertificate: certificate, queueState: 'executed', wouldMutate: true };
}

export function simulatePaperClose(
  desk: PaperDesk,
  positionId: string,
  book: KalshiOrderbook,
  side: 'yes' | 'no',
  expectedPrice: number,
  contracts: number,
  settings: GuardrailSettings,
  metaPatch?: Pick<FillMetadata, 'autoCloseDecisionId' | 'autoCloseReason' | 'autoCloseAction'>,
): PaperCloseResult {
  const cleanBook = sanitizeExecutableBook(book);
  if (!isExecutablePrice(expectedPrice) || !hasCloseDepth(cleanBook, side)) {
    return abortClose('invalid executable close price', 'invalid_price');
  }
  const fill = dryRunCloseFill(cleanBook, side, contracts, expectedPrice, settings.maxSlippagePp);
  if (fill.aborted) {
    return abortClose(fill.abortReason ?? 'fill aborted', 'fill_aborted', fill, true);
  }
  const position = desk.snapshot().positions.find((p) => p.id === positionId);
  if (!position) return abortClose('position not found', 'position_not_found', fill);
  const certified = certifyCloseProfit(position, fill, settings);
  if (!certified) return abortClose('strict profit certification failed', 'strict_profit_block', fill);

  const quality = fillQualityFromDryRun(fill, expectedPrice);
  const meta = { ...fillMeta(fill, quality, certified.certificate), ...metaPatch };
  const result = desk.closePosition(positionId, fill.fillPrice, contracts, meta);
  if (!result.ok) return { ok: false, error: result.error, queueState: 'blocked_final', wouldMutate: false };
  return {
    ok: true,
    pnl: result.pnl,
    fill,
    fillQuality: quality,
    profitCertificate: certified.certificate,
    queueState: 'executed',
    wouldMutate: true,
  };
}
