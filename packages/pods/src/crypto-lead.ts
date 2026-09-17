import type { BinanceQuote } from '@nemesis/connectors';
import type { CryptoThesisContext, ThesisCard, ThesisDriver } from '@nemesis/core';
import {
  clampProbability,
  qualifyThesis,
  computeNetEdge,
  detectSourceDisagreement,
  countUsableLadderQuotes,
  fitLadderImpliedVol,
  kalshiFeePerContract,
  normalCdf,
  selectedSidePricing,
  type LadderQuote,
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
  /**
   * Every strike quoted on this underlying at this expiry, including this one.
   * Used only to read the market's own volatility off the ladder and check the
   * model against it. Omit it and the calibration check simply does not run.
   */
  strikeLadder?: readonly LadderQuote[];
}

interface CryptoScore {
  impliedPrice: number;
  predictability: number;
  context: CryptoThesisContext;
  drivers: ThesisDriver[];
  modelUsable: boolean;
  invalidReason?: string;
}

const MIN_SIGMA_T = 0.0001;

/**
 * How far the model's volatility may sit from the one the market is quoting on
 * the same ladder before the card stops being a signal. A model that disagrees
 * with the market about volatility by more than this is not finding mispriced
 * contracts, it is mispricing them itself.
 */
const MIN_LADDER_SIGMA_RATIO = 0.5;
const MAX_LADDER_SIGMA_RATIO = 1.5;

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
  // sigmaPerRootSec is already time-weighted over the actual gaps between samples
  // (see realizedVolPerRootSec), so scaling to the horizon is a plain sqrt(t).
  // The previous path took a per-sample dispersion and rescaled it by the *mean*
  // sample gap, which is only valid if the samples were evenly spaced -- they are
  // not, the window is fed by a sub-second websocket and a 5s poll at once.
  const sigmaPerRootSec = quote?.sigmaPerRootSec ?? Number.NaN;
  const sigmaT = Number.isFinite(sigmaPerRootSec) && sigmaPerRootSec > 0
    && Number.isFinite(timeToExpirySec) && timeToExpirySec > 0
    ? sigmaPerRootSec * Math.sqrt(timeToExpirySec)
    : Number.NaN;

  // The market quotes the whole strike ladder on this underlying at this expiry,
  // and it fits lognormal at R-squared 0.997, so its own volatility is readable
  // every snapshot at no extra cost. A model volatility far from it is not an
  // edge, it is a broken input -- the 0.35 annual floor this replaced won 57% of
  // the time and exceeded market-implied volatility in 34% of snapshots, which is
  // how a 3-cent contract came to be priced at 16.5 cents.
  const ladder = input.strikeLadder && input.strikeLadder.length > 0
    ? fitLadderImpliedVol(context.spotPrice, input.strikeLadder)
    : null;
  const ladderSigmaRatio = ladder && Number.isFinite(sigmaT) && ladder.sigmaT > 0
    ? sigmaT / ladder.sigmaT
    : Number.NaN;
  const ladderUncalibrated = Number.isFinite(ladderSigmaRatio)
    && (ladderSigmaRatio < MIN_LADDER_SIGMA_RATIO || ladderSigmaRatio > MAX_LADDER_SIGMA_RATIO);

  const modelContext = {
    ...context,
    timeToExpirySec: Number.isFinite(timeToExpirySec) ? round(timeToExpirySec, 1) : undefined,
    sigmaT: Number.isFinite(sigmaT) ? round(sigmaT, 6) : undefined,
    sigmaPerRootSec: Number.isFinite(sigmaPerRootSec) ? round(sigmaPerRootSec, 9) : undefined,
    ladderSigmaT: ladder ? round(ladder.sigmaT, 6) : undefined,
    ladderRSquared: ladder ? round(ladder.rSquared, 4) : undefined,
    ladderPoints: ladder?.points,
    ladderSigmaRatio: Number.isFinite(ladderSigmaRatio) ? round(ladderSigmaRatio, 4) : undefined,
    // Recorded even when zero: "no ladder reached the model" and "a ladder
    // reached it but could not be fitted" are different problems with different
    // fixes, and ladderSigmaT alone cannot tell them apart.
    ladderQuoteCount: input.strikeLadder?.length ?? 0,
    ladderUsableCount: input.strikeLadder && input.strikeLadder.length > 0
      ? countUsableLadderQuotes(context.spotPrice, input.strikeLadder)
      : 0,
  };

  let invalidReason: string | undefined;
  if (!quote) invalidReason = 'crypto-binance-quote-missing';
  else if (context.sampleCount < 3) invalidReason = 'crypto-binance-samples-insufficient';
  else if (context.windowMs <= 0) invalidReason = 'crypto-binance-window-missing';
  else if (!Number.isFinite(timeToExpirySec) || timeToExpirySec <= 0) invalidReason = 'crypto-expiry-unavailable';
  else if (!Number.isFinite(sigmaT) || sigmaT < MIN_SIGMA_T) invalidReason = 'crypto-sigma-unusable';
  else if (ladderUncalibrated) invalidReason = 'crypto-sigma-uncalibrated';

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
        : `sigmaT ${sigmaT.toFixed(4)} over ${Math.round(timeToExpirySec)}s${
          ladder ? `; ladder ${ladder.sigmaT.toFixed(4)} (R2 ${ladder.rSquared.toFixed(3)}, ${ladder.points} strikes)` : '; no ladder fit'
        }`,
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
