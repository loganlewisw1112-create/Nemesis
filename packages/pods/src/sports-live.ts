import type { ThesisCard } from '@nemesis/core';
import { qualifyThesis, computeNetEdge, kalshiFeePerContract, selectedSidePricing } from '@nemesis/core';

export interface SportsLiveInput {
  ticker: string;
  title: string;
  homeScore: number;
  awayScore: number;
  impliedWinProb: number;
  marketPrice: number;
  spread: number;
  depthUsd: number;
}

export function sportsToThesis(input: SportsLiveInput): ThesisCard {
  const implied = input.impliedWinProb;
  const pricing = selectedSidePricing(input.marketPrice, implied);
  const breakdown = computeNetEdge(pricing.impliedPrice, pricing.marketPrice, input.spread);
  const qual = qualifyThesis({
    impliedPrice: pricing.impliedPrice,
    marketPrice: pricing.marketPrice,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: 65,
    freshnessMs: 2000,
    sourceAgreement: 0.85,
    regimeBlocked: false,
    concentrationBlocked: false,
    executionHealthy: true,
  });
  const now = Date.now();
  return {
    id: `sports-${input.ticker}`,
    ticker: input.ticker,
    title: input.title,
    category: 'sports',
    playbook: 'sports-live',
    status: qual.status,
    side: pricing.side,
    marketPrice: pricing.marketPrice,
    impliedPrice: pricing.impliedPrice,
    grossEdge: breakdown.grossEdge,
    netEdge: breakdown.netEdge,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: 65,
    feeEstimate: kalshiFeePerContract(pricing.marketPrice),
    signalReason: `Live ${input.homeScore}-${input.awayScore}`,
    externalSummary: `Implied ${(implied * 100).toFixed(0)}%`,
    createdAt: now,
    updatedAt: now,
    freshnessMs: 2000,
    edgeHistory: [breakdown.netEdge],
    drivers: [{ label: 'Live score', impact: 0.8, detail: `${input.homeScore}-${input.awayScore}` }],
    invalidations: qual.failedGates,
    sourceMove: 'flow-driven',
  };
}
