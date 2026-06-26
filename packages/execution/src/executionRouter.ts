import type {
  GuardrailSettings,
  KalshiOrderbook,
  PaperPortfolio,
  ThesisCard,
  FillMetadata,
} from '@nemesis/core';
import { kalshiFeeForOrder } from '@nemesis/core';
import { allocateSize, checkConcentration, decideCapitalAllocation, type CapitalDecision } from '@nemesis/capital';
import { dryRunFill, type DryRunOrder } from './dryRun.js';
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
  aborted?: boolean;
  abortReason?: string;
}

export interface PaperCloseResult {
  ok: boolean;
  error?: string;
  pnl?: number;
  fill?: DryRunOrder;
  fillQuality?: FillQuality;
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

function fillMeta(_fill: DryRunOrder, quality: FillQuality): FillMetadata {
  return {
    expectedPrice: quality.expectedPrice,
    slippage: quality.slippage,
    implementationShortfall: quality.implementationShortfall,
    depthLevels: quality.depthLevels,
    mode: 'paper',
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
  const capitalDecision = decideCapitalAllocation({ card, portfolio, settings, book });
  if (contracts === undefined && capitalDecision.noTradeReasons.length > 0) {
    return {
      ok: false,
      aborted: true,
      abortReason: capitalDecision.noTradeReasons.join('; '),
      capitalDecision,
    };
  }
  const qty = contracts !== undefined && contracts >= 1 ? Math.floor(contracts) : capitalDecision.contracts;
  if (qty < 1) {
    return {
      ok: false,
      aborted: true,
      abortReason: 'capital allocator returned zero safe contracts',
      capitalDecision,
    };
  }
  const expectedPrice = card.side === 'yes' ? card.marketPrice : 1 - card.marketPrice;
  const fill = dryRunFill(book, card.side, qty, card.impliedPrice, settings.maxSlippagePp);

  if (fill.aborted) {
    return { ok: false, aborted: true, abortReason: fill.abortReason, fill, capitalDecision };
  }

  const quality = fillQualityFromDryRun(fill, expectedPrice);
  const meta = fillMeta(fill, quality);
  const result = desk.openPosition(card, fill.filled, fill.fillPrice, meta, card.category);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, fill, fillQuality: quality, capitalDecision };
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
  const fill = dryRunFill(book, side, contracts, expectedPrice, settings.maxSlippagePp);
  if (fill.aborted) {
    return { ok: false, error: fill.abortReason ?? 'fill aborted', fill };
  }
  const quality = fillQualityFromDryRun(fill, expectedPrice);
  const meta = { ...fillMeta(fill, quality), ...metaPatch };
  const result = desk.closePosition(positionId, fill.fillPrice, contracts, meta);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, pnl: result.pnl, fill, fillQuality: quality };
}
