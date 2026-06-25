import type { ThesisCard } from '@nemesis/core';
import { qualifyThesis, computeNetEdge, kalshiFeePerContract } from '@nemesis/core';

export interface InfraAlert {
  provider: string;
  status: 'operational' | 'degraded' | 'outage';
  summary: string;
}

export function infraToThesis(
  ticker: string,
  title: string,
  alert: InfraAlert,
  marketPrice: number,
  spread: number,
  depthUsd: number,
): ThesisCard | null {
  if (alert.status === 'operational') return null;
  const implied = alert.status === 'outage' ? 0.75 : 0.55;
  const breakdown = computeNetEdge(implied, marketPrice, spread);
  const qual = qualifyThesis({
    impliedPrice: implied,
    marketPrice,
    spread,
    depthUsd,
    predictability: 60,
    freshnessMs: 1000,
    sourceAgreement: 0.85,
    regimeBlocked: false,
    concentrationBlocked: false,
    executionHealthy: true,
  });
  const now = Date.now();
  return {
    id: `infra-${ticker}`,
    ticker,
    title,
    category: 'infra',
    playbook: 'infra-watch',
    status: qual.status,
    side: 'yes',
    marketPrice,
    impliedPrice: implied,
    grossEdge: breakdown.grossEdge,
    netEdge: breakdown.netEdge,
    spread,
    depthUsd,
    predictability: 60,
    feeEstimate: kalshiFeePerContract(marketPrice),
    signalReason: `${alert.provider}: ${alert.status}`,
    externalSummary: alert.summary,
    createdAt: now,
    updatedAt: now,
    freshnessMs: 1000,
    edgeHistory: [breakdown.netEdge],
    drivers: [{ label: alert.provider, impact: 0.7, detail: alert.summary }],
    invalidations: qual.failedGates,
    sourceMove: 'news-driven',
  };
}
