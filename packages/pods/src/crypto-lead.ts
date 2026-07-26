import type { BinanceQuote } from '@nemesis/connectors';
import type { CryptoThesisContext, ThesisCard, ThesisDriver } from '@nemesis/core';
import {
  clampProbability,
  qualifyThesis,
  computeNetEdge,
  detectSourceDisagreement,
  kalshiFeePerContract,
  normalCdf,
  selectedSidePricing,
} from '@nemesis/core';

export interface CryptoLeadInput {
  ticker: string;
  title: string;
  spotPrice: number;
  strike: number;
  marketPrice: number;
  spread: number;
  depthUsd: number;
  lagMs: number;
  kalshiImpliedSpot?: number;
  symbol?: string;
  binanceQuote?: BinanceQuote;
  closeTime?: string;
}

interface CryptoScore {
  impliedPrice: number;
  predictability: number;
  context: CryptoThesisContext;
  drivers: ThesisDriver[];
  modelUsable: boolean;
  invalidReason?: string;
}

const VOL_SCALE = 1;
const MIN_SIGMA_T = 0.0001;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const DEFAULT_ANNUAL_VOL_FLOOR = 0.4;
const ANNUAL_VOL_FLOOR_BY_SYMBOL: Record<string, number> = {
  BTCUSDT: 0.35,
  ETHUSDT: 0.5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 4): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function roundBpsForModel(value: number): number {
  if (value > 0 && Math.abs(value) < 0.1) return round(value, 4);
  return round(value, 1);
}

function annualVolFloor(symbol: string): number {
  return ANNUAL_VOL_FLOOR_BY_SYMBOL[symbol.toUpperCase()] ?? DEFAULT_ANNUAL_VOL_FLOOR;
}

function signedBps(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)} bps`;
}

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 2 });
}

function contextFromInput(input: CryptoLeadInput): CryptoThesisContext {
  const quote = input.binanceQuote;
  const symbol = quote?.symbol ?? input.symbol ?? (input.title.toUpperCase().includes('ETH') ? 'ETHUSDT' : 'BTCUSDT');
  const spotPrice = quote?.price ?? input.spotPrice;
  const distanceBps = input.strike > 0 ? ((spotPrice - input.strike) / input.strike) * 10_000 : 0;
  const momentumBps = quote?.momentumBps ?? 0;
  const volatilityBps = quote?.volatilityBps ?? 0;
  const sampleCount = quote?.sampleCount ?? 1;
  const windowMs = quote?.windowMs ?? 0;
  const lagMs = quote?.lagMs ?? input.lagMs;
  const distanceConfidence = clamp(Math.abs(distanceBps) / 3, 0, 14);
  const momentumAligned = Math.sign(momentumBps) === 0 || Math.sign(distanceBps || momentumBps) === Math.sign(momentumBps);
  const momentumConfidence = clamp(Math.abs(momentumBps) / 2, 0, 18) * (momentumAligned ? 1 : -1);
  const sampleBonus = sampleCount >= 8 ? 8 : sampleCount >= 3 ? 3 : 0;
  const volatilityPenalty = clamp(volatilityBps / 4, 0, 40);
  const lagPenalty = clamp(Math.max(0, lagMs - 250) / 75, 0, 12);
  const confidence = Math.round(clamp(
    58 + distanceConfidence + momentumConfidence + sampleBonus - volatilityPenalty - lagPenalty,
    20,
    96,
  ));

  return {
    symbol,
    spotPrice,
    strike: input.strike,
    distanceBps: round(distanceBps, 1),
    momentumBps: round(momentumBps, 1),
    volatilityBps: roundBpsForModel(volatilityBps),
    confidence,
    sampleCount,
    windowMs,
  };
}

function scoreCryptoLead(input: CryptoLeadInput): CryptoScore {
  const context = contextFromInput(input);
  const quote = input.binanceQuote;
  const closeMs = input.closeTime ? Date.parse(input.closeTime) : Number.NaN;
  const timeToExpirySec = Number.isFinite(closeMs) ? (closeMs - Date.now()) / 1000 : Number.NaN;
  const dtSec = context.windowMs > 0 && context.sampleCount > 1
    ? (context.windowMs / 1000) / Math.max(1, context.sampleCount - 1)
    : Number.NaN;
  const volFrac = Math.max(0, context.volatilityBps / 10_000);
  const observedSigmaT = Number.isFinite(volFrac) && Number.isFinite(dtSec) && dtSec > 0 && Number.isFinite(timeToExpirySec) && timeToExpirySec > 0
    ? volFrac * Math.sqrt(timeToExpirySec / dtSec) * VOL_SCALE
    : Number.NaN;
  const floorAnnualVol = annualVolFloor(context.symbol);
  const floorSigmaT = Number.isFinite(timeToExpirySec) && timeToExpirySec > 0
    ? floorAnnualVol * Math.sqrt(timeToExpirySec / SECONDS_PER_YEAR)
    : Number.NaN;
  const sigmaT = Number.isFinite(observedSigmaT) && Number.isFinite(floorSigmaT)
    ? Math.max(observedSigmaT, floorSigmaT)
    : Number.NaN;
  const modelContext = {
    ...context,
    timeToExpirySec: Number.isFinite(timeToExpirySec) ? round(timeToExpirySec, 1) : undefined,
    sigmaT: Number.isFinite(sigmaT) ? round(sigmaT, 6) : undefined,
    observedSigmaT: Number.isFinite(observedSigmaT) ? round(observedSigmaT, 6) : undefined,
    floorSigmaT: Number.isFinite(floorSigmaT) ? round(floorSigmaT, 6) : undefined,
    annualVolFloor: floorAnnualVol,
    volatilityScale: VOL_SCALE,
  };

  let invalidReason: string | undefined;
  if (!quote) invalidReason = 'crypto-binance-quote-missing';
  else if (context.sampleCount < 3) invalidReason = 'crypto-binance-samples-insufficient';
  else if (context.windowMs <= 0) invalidReason = 'crypto-binance-window-missing';
  else if (!Number.isFinite(timeToExpirySec) || timeToExpirySec <= 0) invalidReason = 'crypto-expiry-unavailable';
  else if (!Number.isFinite(sigmaT) || sigmaT < MIN_SIGMA_T) invalidReason = 'crypto-sigma-unusable';

  const d = invalidReason
    ? Number.NaN
    : (Math.log(context.spotPrice / input.strike) - 0.5 * sigmaT * sigmaT) / sigmaT;
  const impliedPrice = invalidReason
    ? round(clamp(input.marketPrice, 0.02, 0.98))
    : round(clampProbability(normalCdf(d)));
  const distanceImpact = invalidReason ? 0 : round(impliedPrice - 0.5);
  const momentumImpact = clamp(context.momentumBps / 500, -0.14, 0.14);
  const volatilityImpact = invalidReason ? 0 : round(-Math.abs(sigmaT) / 4);
  const drivers: ThesisDriver[] = [
    {
      label: 'Log-normal distance',
      impact: distanceImpact,
      detail: `${signedBps(context.distanceBps)} from strike`,
    },
    {
      label: 'Binance momentum',
      impact: round(momentumImpact),
      detail: `${signedBps(context.momentumBps)} display-only over ${(context.windowMs / 1000).toFixed(0)}s`,
    },
    {
      label: 'Volatility horizon',
      impact: round(volatilityImpact),
      detail: invalidReason
        ? invalidReason
        : `sigmaT ${sigmaT.toFixed(4)} over ${Math.round(timeToExpirySec)}s; floor ${(floorAnnualVol * 100).toFixed(0)}% ann`,
    },
  ];

  return {
    impliedPrice,
    predictability: invalidReason ? Math.min(context.confidence, 40) : context.confidence,
    context: modelContext,
    drivers,
    modelUsable: !invalidReason,
    invalidReason,
  };
}

export function cryptoToThesis(input: CryptoLeadInput): ThesisCard {
  const score = scoreCryptoLead(input);
  const implied = score.impliedPrice;
  const spotPrice = score.context.spotPrice;
  const lagMs = input.binanceQuote?.lagMs ?? input.lagMs;
  // Only run the multi-source disagree gate when a real Kalshi-implied spot was
  // supplied. A fabricated marketPrice*strike is not an implied spot and must
  // not quarantine every crypto-lead card.
  const hasKalshiImpliedSpot = Number.isFinite(input.kalshiImpliedSpot);
  const { agreement, disagree } = hasKalshiImpliedSpot
    ? detectSourceDisagreement(
      [{ value: spotPrice }, { value: input.kalshiImpliedSpot! }],
      input.strike * 0.02,
    )
    : { agreement: 1, disagree: false };
  const pricing = selectedSidePricing(input.marketPrice, implied);
  const breakdown = computeNetEdge(pricing.impliedPrice, pricing.marketPrice, input.spread);
  const qual = qualifyThesis({
    impliedPrice: pricing.impliedPrice,
    marketPrice: pricing.marketPrice,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: score.predictability,
    freshnessMs: lagMs,
    sourceAgreement: agreement,
    regimeBlocked: false,
    concentrationBlocked: false,
    executionHealthy: true,
  });
  const now = Date.now();
  const modelInvalidations = score.invalidReason ? [score.invalidReason] : [];
  const status = disagree || !score.modelUsable ? 'uncertain' as const : qual.status;
  const invalidations = disagree ? ['source-conflict', ...modelInvalidations] : [...qual.failedGates, ...modelInvalidations];
  return {
    id: `crypto-${input.ticker}`,
    ticker: input.ticker,
    title: input.title,
    category: 'crypto',
    playbook: 'crypto-lead',
    status,
    side: pricing.side,
    marketPrice: pricing.marketPrice,
    impliedPrice: pricing.impliedPrice,
    grossEdge: breakdown.grossEdge,
    netEdge: breakdown.netEdge,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: score.predictability,
    feeEstimate: kalshiFeePerContract(pricing.marketPrice),
    signalReason: `Binance ${score.context.symbol} spot lead ${lagMs}ms; momentum ${signedBps(score.context.momentumBps)}, vol ${score.context.volatilityBps.toFixed(1)} bps`,
    externalSummary: `${score.context.symbol} spot $${formatUsd(spotPrice)} vs strike $${formatUsd(input.strike)} (${signedBps(score.context.distanceBps)}) · momentum ${signedBps(score.context.momentumBps)} · vol ${score.context.volatilityBps.toFixed(1)} bps`,
    createdAt: now,
    updatedAt: now,
    freshnessMs: lagMs,
    edgeHistory: [breakdown.netEdge],
    drivers: score.drivers,
    invalidations,
    sourceMove: score.modelUsable && Number.isFinite(lagMs) && lagMs < 5_000
      ? 'flow-driven'
      : 'microstructure-only',
    cryptoContext: score.context,
  };
}
