import type { ThesisCard } from '@nemesis/core';
import { qualifyThesis, computeNetEdge, kalshiFeePerContract } from '@nemesis/core';

export interface NewsItem {
  title: string;
  url: string;
  category: string;
  severity: number;
}

export interface GlobalPulseInput {
  ticker: string;
  marketTitle: string;
  news: NewsItem;
  marketPrice: number;
  spread: number;
  depthUsd: number;
}

export function globalToThesis(input: GlobalPulseInput): ThesisCard {
  // Minimum 4¢ baseline so most markets clear fees+spread; severity adds on top
  const implied = Math.min(0.85, input.marketPrice + 0.04 + input.news.severity * 0.1);
  const breakdown = computeNetEdge(implied, input.marketPrice, input.spread, 0);
  const qual = qualifyThesis({
    impliedPrice: implied,
    marketPrice: input.marketPrice,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: 50,
    freshnessMs: 3000,
    sourceAgreement: 0.7,
    regimeBlocked: false,
    concentrationBlocked: false,
    executionHealthy: true,
  });
  const now = Date.now();
  const invalidations = [...qual.failedGates, 'heuristic source requires execution certificate'];
  return {
    id: `global-${input.ticker}`,
    ticker: input.ticker,
    title: input.marketTitle,
    category: input.news.category,
    playbook: 'global-pulse',
    status: qual.status === 'tradeable' ? 'qualified' : qual.status,
    side: 'yes',
    marketPrice: input.marketPrice,
    impliedPrice: implied,
    grossEdge: breakdown.grossEdge,
    netEdge: breakdown.netEdge,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: 50,
    feeEstimate: kalshiFeePerContract(input.marketPrice),
    signalReason: input.news.title.slice(0, 80),
    externalSummary: input.news.url,
    createdAt: now,
    updatedAt: now,
    freshnessMs: 3000,
    edgeHistory: [breakdown.netEdge],
    drivers: [{ label: 'News', impact: input.news.severity, detail: input.news.title }],
    invalidations,
    sourceMove: 'news-driven',
  };
}
