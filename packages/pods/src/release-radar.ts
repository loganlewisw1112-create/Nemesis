import type { ThesisCard } from '@nemesis/core';

export interface ReleaseEvent {
  name: string;
  ticker: string;
  title: string;
  minutesToRelease: number;
  marketPrice: number;
}

export function releaseRadarWarning(event: ReleaseEvent): ThesisCard | null {
  if (event.minutesToRelease > 120) return null;
  const now = Date.now();
  return {
    id: `release-${event.ticker}`,
    ticker: event.ticker,
    title: event.title,
    category: 'economics',
    playbook: 'release-radar',
    status: 'watch-only',
    side: 'yes',
    marketPrice: event.marketPrice,
    impliedPrice: event.marketPrice,
    grossEdge: 0,
    netEdge: 0,
    spread: 0.06,
    depthUsd: 100,
    predictability: 40,
    feeEstimate: 0,
    signalReason: `T-${event.minutesToRelease}m ${event.name} — liquidity regime warning`,
    externalSummary: 'Pre-release caution',
    createdAt: now,
    updatedAt: now,
    freshnessMs: 0,
    edgeHistory: [0],
    drivers: [{ label: 'Release countdown', impact: 0.5, detail: event.name }],
    invalidations: ['pre-release regime'],
    sourceMove: 'resolution-near',
  };
}
