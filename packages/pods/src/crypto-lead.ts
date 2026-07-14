import type { BinanceQuote } from '@nemesis/connectors';
import type { CryptoThesisContext, ThesisCard, ThesisDriver } from '@nemesis/core';
import {
  qualifyThesis,
  computeNetEdge,
  detectSourceDisagreement,
  kalshiFeePerContract,
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
}

interface CryptoScore {
  impliedPrice: number;
  predictability: number;
  context: CryptoThesisContext;
  drivers: ThesisDriver[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 4): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
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
    volatilityBps: round(volatilityBps, 1),
    confidence,
    sampleCount,
    windowMs,
  };
}

function scoreCryptoLead(input: CryptoLeadInput): CryptoScore {
  const context = contextFromInput(input);
  const distanceTilt = clamp(context.distanceBps / 300, -0.3, 0.3);
  const momentumTilt = clamp(context.momentumBps / 500, -0.14, 0.14);
  const rawTilt = distanceTilt + momentumTilt;
  const volatilityDamping = clamp(context.volatilityBps / 300, 0, 0.45);
  const netTilt = rawTilt * (1 - volatilityDamping);
  const impliedPrice = round(clamp(0.5 + netTilt, 0.05, 0.95));
  const volatilityImpact = -Math.abs(rawTilt * volatilityDamping);
  const drivers: ThesisDriver[] = [
    {
      label: 'Binance spot distance',
      impact: round(distanceTilt),
      detail: `${signedBps(context.distanceBps)} from strike`,
    },
    {
      label: 'Binance momentum',
      impact: round(momentumTilt),
      detail: `${signedBps(context.momentumBps)} over ${(context.windowMs / 1000).toFixed(0)}s`,
    },
    {
      label: 'Binance volatility',
      impact: round(volatilityImpact),
      detail: `${context.volatilityBps.toFixed(1)} bps realized over ${context.sampleCount} ticks`,
    },
  ];

  return {
    impliedPrice,
    predictability: context.confidence,
    context,
    drivers,
  };
}

export function cryptoToThesis(input: CryptoLeadInput): ThesisCard {
  const score = scoreCryptoLead(input);
  const implied = score.impliedPrice;
  const spotPrice = score.context.spotPrice;
  const lagMs = input.binanceQuote?.lagMs ?? input.lagMs;
  const kalshiSpot = input.kalshiImpliedSpot ?? input.marketPrice * input.strike;
  const { agreement, disagree } = detectSourceDisagreement(
    [{ value: spotPrice }, { value: kalshiSpot }],
    input.strike * 0.02,
  );
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
  return {
    id: `crypto-${input.ticker}`,
    ticker: input.ticker,
    title: input.title,
    category: 'crypto',
    playbook: 'crypto-lead',
    status: disagree ? 'uncertain' : qual.status,
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
    invalidations: disagree ? ['source-conflict'] : qual.failedGates,
    sourceMove: score.context.sampleCount >= 3 ? 'flow-driven' : 'microstructure-only',
    cryptoContext: score.context,
  };
}
