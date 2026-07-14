import type { ThesisCard } from '@nemesis/core';
import {
  qualifyThesis,
  computeNetEdge,
  kalshiFeePerContract,
  sigmoidProbability,
  clampProbability,
  selectedSidePricing,
} from '@nemesis/core';

// Typical consensus-vs-actual error scale for a headline macro release
// (e.g. CPI m/m, in percentage points). Surprises are measured against this
// scale rather than mapped to a fixed +/-0.2 bucket regardless of size.
const SURPRISE_SCALE = 0.15;

export interface MacroEvent {
  ticker: string;
  title: string;
  releaseName: string;
  consensus: number;
  actual?: number;
  marketPrice: number;
  spread: number;
  depthUsd: number;
  minutesToRelease: number;
}

export function macroToThesis(event: MacroEvent): ThesisCard {
  const surprise = event.actual !== undefined ? event.actual - event.consensus : 0;
  const implied = event.actual !== undefined
    ? clampProbability(sigmoidProbability(surprise, SURPRISE_SCALE))
    : 0.5;
  const pricing = selectedSidePricing(event.marketPrice, implied);
  const breakdown = computeNetEdge(pricing.impliedPrice, pricing.marketPrice, event.spread);
  const qual = qualifyThesis({
    impliedPrice: pricing.impliedPrice,
    marketPrice: pricing.marketPrice,
    spread: event.spread,
    depthUsd: event.depthUsd,
    predictability: event.minutesToRelease < 30 ? 55 : 70,
    freshnessMs: 2000,
    sourceAgreement: 0.9,
    regimeBlocked: event.minutesToRelease < 5,
    concentrationBlocked: false,
    executionHealthy: true,
  });
  const now = Date.now();
  return {
    id: `macro-${event.ticker}`,
    ticker: event.ticker,
    title: event.title,
    category: 'economics',
    playbook: 'macro-pulse',
    status: qual.status,
    side: pricing.side,
    marketPrice: pricing.marketPrice,
    impliedPrice: pricing.impliedPrice,
    grossEdge: breakdown.grossEdge,
    netEdge: breakdown.netEdge,
    spread: event.spread,
    depthUsd: event.depthUsd,
    predictability: event.minutesToRelease < 30 ? 55 : 70,
    feeEstimate: kalshiFeePerContract(pricing.marketPrice),
    signalReason: event.actual !== undefined
      ? `${event.releaseName} surprise ${surprise > 0 ? '+' : ''}${surprise.toFixed(2)}`
      : `T-${event.minutesToRelease}m ${event.releaseName}`,
    externalSummary: `Consensus ${event.consensus}`,
    createdAt: now,
    updatedAt: now,
    freshnessMs: 2000,
    edgeHistory: [breakdown.netEdge],
    drivers: [{ label: 'Macro release', impact: 0.9, detail: event.releaseName }],
    invalidations: qual.failedGates,
    sourceMove: event.actual !== undefined ? 'forecast-driven' : 'resolution-near',
  };
}
