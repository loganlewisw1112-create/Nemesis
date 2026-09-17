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
  sanitizeExecutableBook,
} from '@nemesis/core';
import { checkConcentration, decideCapitalAllocation, type CapitalDecision } from '@nemesis/capital';
import { dryRunCloseFill, dryRunFill, type DryRunOrder } from './dryRun.js';
import type { PaperDesk } from './paperDesk.js';
import { entryEligibilityBlockReason } from './entryEligibility.js';
import { calculateEntryEconomics } from './tradeEconomics.js';

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
      classification: 'research_only',
    };
  }

  if (!hasCloseDepth(book, card.side)) return null;

  // Path A: instant round-trip (buy then immediately sell the same book) clears fees.
  // This only fires on a crossed/mispriced book; on a normal two-sided market the ask
  // is always >= the bid, so this is near-impossible by construction, not a sign the
  // thesis lacks edge.
  const exitFill = dryRunCloseFill(book, card.side, entryFill.filled, entryFill.fillPrice, settings.maxSlippagePp);
  if (!exitFill.aborted && isExecutablePrice(exitFill.fillPrice)) {
    const proceeds = exitFill.fillPrice * exitFill.filled - exitFill.fees;
    const cost = entryFill.fillPrice * entryFill.filled + entryFill.fees;
    const instantNetPnlUsd = Number((proceeds - cost).toFixed(4));
    if (instantNetPnlUsd >= strict.minNetPnlUsd) {
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
        netPnlUsd: instantNetPnlUsd,
        bookTimestamp: now,
        expiresAt: now + strict.maxBookAgeMs,
        reason: 'instant round-trip certified',
        classification: 'immediate_executable',
      };
    }
  }

  // Path B: conditional model-target certification. Actual fill price and fees are
  // authoritative. Screening costs inside card.netEdge are not subtracted again.
  if (!Number.isFinite(card.netEdge) || card.netEdge <= 0) return null;
  const economics = calculateEntryEconomics({
    entryPrice: entryFill.fillPrice,
    entryFeesUsd: entryFill.fees,
    contracts: entryFill.filled,
    sideFairPrice: card.impliedPrice,
    marketPrice: card.marketPrice,
    grossEdge: card.grossEdge,
    screeningNetEdge: card.netEdge,
    executableEntryNetEdge: entryFill.netEdge,
    spread: card.spread,
    fillSlippage: entryFill.slippage,
    feePolicy: book.feePolicy,
  });
  if (economics.targetExitPrice <= entryFill.fillPrice) return null;
  const thesisNetPnlUsd = Number(economics.targetRewardUsd.toFixed(4));
  if (thesisNetPnlUsd < strict.minNetPnlUsd) return null;
  const now = Date.now();
  return {
    kind: 'open',
    ticker: card.ticker,
    side: card.side,
    contracts: entryFill.filled,
    entryPrice: entryFill.fillPrice,
    exitPrice: economics.targetExitPrice,
    entryFees: entryFill.fees,
    exitFees: economics.targetExitFeesUsd,
    netPnlUsd: thesisNetPnlUsd,
    bookTimestamp: now,
    expiresAt: now + strict.maxBookAgeMs,
    reason: 'conditional model target certified (modeled, not locked-in)',
    classification: 'research_only',
    targetExitPrice: economics.targetExitPrice,
    breakEvenExitPrice: economics.breakEvenExitPrice,
    targetRewardUsd: economics.targetRewardUsd,
    expectedRewardUsd: economics.targetRewardUsd,
    plannedLossUsd: economics.plannedLossUsd,
    rewardRiskRatio: economics.rewardRiskRatio,
    stressedNetPnlUsd: economics.stressedNetPnlUsd,
  };
}

function certifyCloseProfit(
  position: PaperPosition,
  fill: DryRunOrder,
  settings: GuardrailSettings,
  isEmergencyClose = false,
): { certificate: ProfitCertificate; pnl: number } | null {
  if (!isExecutablePrice(fill.fillPrice)) return null;
  const strict = strictProfitSettings(settings);
  const pnl = Number(closePnl(position, fill.fillPrice, fill.filled, fill.fees).toFixed(4));
  const blockAsLoss = strict.enabled && pnl < strict.minNetPnlUsd;
  const emergencyOverride = isEmergencyClose && strict.allowEmergencyLossClose;
  if (blockAsLoss && !emergencyOverride) return null;
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
      reason: blockAsLoss ? 'emergency loss close certified' : 'strict profit certified',
    },
  };
}

/**
 * Kalshi multi-outcome markets share an event stem before the final outcome
 * segment, e.g. `KXMLBGAME-26JUL052130BOSLAA-BOS` and `...-LAA` share
 * `KXMLBGAME-26JUL052130BOSLAA`. The persisted `eventTicker` field is often
 * undefined, so derive the stem from the ticker itself.
 */
export function eventStem(ticker: string): string {
  const idx = ticker.lastIndexOf('-');
  return idx > 0 ? ticker.slice(0, idx) : ticker;
}

/**
 * Blocks opens that would combine with existing holdings into a structurally
 * guaranteed loss on a mutually-exclusive event:
 *  - Holding YES and NO on the *same* market pays exactly $1 at settlement for
 *    a combined (post-fee) cost above $1.
 *  - Holding YES on multiple distinct outcomes of the same event caps the
 *    combined payout at $1 (at most one outcome resolves), so once the entry
 *    cost of those YES claims reaches $1 the set can never profit. This is the
 *    "bought both sides of the game" case.
 *
 * The YES-stacking check keys on the ticker stem, which for genuinely
 * mutually-exclusive winner markets is exactly right. For scalar/overlapping
 * bucket markets (where two YES buckets could both resolve) it may
 * conservatively block a legitimate stack, which is acceptable under the
 * system's no-trade-preferred posture: a skipped trade is the safe default,
 * a guaranteed-loss fill is not.
 */
export function mutualExclusionBlock(
  ticker: string,
  side: 'yes' | 'no',
  entryPrice: number,
  positions: PaperPosition[],
): string | undefined {
  const oppositeSameTicker = positions.find((p) => p.ticker === ticker && p.side !== side);
  if (oppositeSameTicker) {
    return 'mutual-exclusion: opposite side already held on same market';
  }
  if (side === 'yes') {
    const stem = eventStem(ticker);
    const siblingYesCost = positions
      .filter((p) => p.side === 'yes' && p.ticker !== ticker && eventStem(p.ticker) === stem)
      .reduce((sum, p) => sum + p.entryPrice, 0);
    if (siblingYesCost > 0 && siblingYesCost + entryPrice >= 1) {
      return 'mutual-exclusion: combined YES cost across event outcomes >= $1 (guaranteed non-profit)';
    }
  }
  return undefined;
}

export function resolveContractCount(
  card: ThesisCard,
  portfolio: PaperPortfolio,
  settings: GuardrailSettings,
  contracts?: number,
): number {
  const decision = decideCapitalAllocation({ card, portfolio, settings });
  if (contracts !== undefined && contracts > 0) {
    const requested = Math.floor(contracts * 100) / 100;
    return Math.max(0, Math.min(requested, decision.maxSafeContracts));
  }
  if (decision.contracts > 0) return decision.contracts;
  return 0;
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

export function previewPaperBuy(
  portfolio: PaperPortfolio,
  card: ThesisCard,
  book: KalshiOrderbook,
  settings: GuardrailSettings,
  contracts?: number,
): PaperBuyResult {
  const eligibilityBlock = entryEligibilityBlockReason(card);
  if (eligibilityBlock) return abortBuy(eligibilityBlock, 'signal_eligibility_block');
  const cleanBook = sanitizeExecutableBook(book);
  // Thesis prices are expressed in the contract side being traded. NO cards
  // therefore carry a NO price and must not be inverted again here.
  const expectedPrice = card.marketPrice;
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

  const exclusion = mutualExclusionBlock(card.ticker, card.side, fill.fillPrice, portfolio.positions);
  if (exclusion) {
    return abortBuy(exclusion, 'mutual_exclusion_block', capitalDecision, fill);
  }

  const certificate = certifyOpenProfit(card, cleanBook, fill, settings);
  if (!certificate) {
    return abortBuy('strict profit certification failed', 'strict_profit_block', capitalDecision, fill);
  }

  const quality = fillQualityFromDryRun(fill, expectedPrice);
  return {
    ok: true,
    fill,
    fillQuality: quality,
    capitalDecision,
    profitCertificate: certificate,
    queueState: 'certified',
    wouldMutate: false,
  };
}

export function simulatePaperBuy(
  desk: PaperDesk,
  card: ThesisCard,
  book: KalshiOrderbook,
  settings: GuardrailSettings,
  contracts?: number,
  profitCertificateOverride?: ProfitCertificate,
): PaperBuyResult {
  const portfolio = desk.snapshot();
  const preview = previewPaperBuy(portfolio, card, book, settings, contracts);
  if (!preview.ok || !preview.fill || !preview.fillQuality || !preview.profitCertificate) return preview;
  const baseCertificate = preview.profitCertificate;
  const overrideValid = profitCertificateOverride
    && profitCertificateOverride.kind === 'open'
    && profitCertificateOverride.ticker === card.ticker
    && profitCertificateOverride.side === card.side
    && profitCertificateOverride.contracts === preview.fill.filled
    && profitCertificateOverride.expiresAt >= Date.now()
    && profitCertificateOverride.classification === 'modeled_confirmed';
  if (
    settings.entryQualification?.enabled !== false
    && baseCertificate.classification !== 'immediate_executable'
    && !overrideValid
  ) {
    return abortBuy(
      'modeled edge requires persistent executable entry confirmation',
      'entry_confirmation_required',
      preview.capitalDecision,
      preview.fill,
      true,
    );
  }
  const certificate = overrideValid ? profitCertificateOverride : baseCertificate;
  const quality = preview.fillQuality;
  const fill = preview.fill;
  const meta = fillMeta(fill, quality, certificate);
  const result = desk.openPosition(card, fill.filled, fill.fillPrice, meta, card.category);
  if (!result.ok) return { ok: false, error: result.error, capitalDecision: preview.capitalDecision, queueState: 'blocked_final', wouldMutate: false };
  return { ok: true, fill, fillQuality: quality, capitalDecision: preview.capitalDecision, profitCertificate: certificate, queueState: 'executed', wouldMutate: true };
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
  const isEmergencyClose = /^emergency close:/i.test(metaPatch?.autoCloseReason ?? '');
  const certified = certifyCloseProfit(position, fill, settings, isEmergencyClose);
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

export function previewPaperClose(
  book: KalshiOrderbook,
  side: 'yes' | 'no',
  contracts: number,
  settings: GuardrailSettings,
): PaperCloseResult {
  const cleanBook = sanitizeExecutableBook(book);
  const levels = side === 'yes' ? cleanBook.yes : cleanBook.no;
  const bestBid = levels
    .filter((level) => isExecutablePrice(level.price) && level.quantity > 0)
    .reduce<number | undefined>((best, level) => best == null || level.price > best ? level.price : best, undefined);
  if (!bestBid || contracts < 1) return abortClose('no executable close-side depth', 'invalid_price', undefined, true);
  const fill = dryRunCloseFill(cleanBook, side, contracts, bestBid, settings.maxSlippagePp);
  if (fill.aborted) return abortClose(fill.abortReason ?? 'fill aborted', 'fill_aborted', fill, true);
  return {
    ok: true,
    fill,
    fillQuality: fillQualityFromDryRun(fill, bestBid),
    queueState: 'certified',
    wouldMutate: false,
  };
}
