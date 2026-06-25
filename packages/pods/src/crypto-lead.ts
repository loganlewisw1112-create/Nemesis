import type { ThesisCard } from '@nemesis/core';
import { qualifyThesis, computeNetEdge, detectSourceDisagreement, kalshiFeePerContract } from '@nemesis/core';

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
}

export function cryptoToThesis(input: CryptoLeadInput): ThesisCard {
  const implied = input.spotPrice > input.strike ? 0.72 : 0.28;
  const kalshiSpot = input.kalshiImpliedSpot ?? input.marketPrice * input.strike;
  const { agreement, disagree } = detectSourceDisagreement(
    [{ value: input.spotPrice }, { value: kalshiSpot }],
    input.strike * 0.02,
  );
  const breakdown = computeNetEdge(implied, input.marketPrice, input.spread);
  const qual = qualifyThesis({
    impliedPrice: implied,
    marketPrice: input.marketPrice,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: input.lagMs < 500 ? 80 : 50,
    freshnessMs: input.lagMs,
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
    side: implied > input.marketPrice ? 'yes' : 'no',
    marketPrice: input.marketPrice,
    impliedPrice: implied,
    grossEdge: breakdown.grossEdge,
    netEdge: breakdown.netEdge,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: input.lagMs < 500 ? 80 : 50,
    feeEstimate: kalshiFeePerContract(input.marketPrice),
    signalReason: `Spot lead ${input.lagMs}ms ahead`,
    externalSummary: `Spot $${input.spotPrice.toLocaleString()} vs strike $${input.strike.toLocaleString()}`,
    createdAt: now,
    updatedAt: now,
    freshnessMs: input.lagMs,
    edgeHistory: [breakdown.netEdge],
    drivers: [{ label: 'Binance spot', impact: 0.85, detail: `$${input.spotPrice}` }],
    invalidations: disagree ? ['source-conflict'] : qual.failedGates,
    sourceMove: 'flow-driven',
  };
}
