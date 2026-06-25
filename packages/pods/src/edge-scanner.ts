import type { ThesisCard, TickerDepthResult } from '@nemesis/core';
import { qualifyThesis, computeNetEdge, kalshiFeePerContract } from '@nemesis/core';

export interface ScanMarketInput {
  ticker: string;
  title: string;
  category: string;
  marketPrice: number;
  spread: number;
  depthUsd: number;
  minNetEdge?: number;
  depthContext?: TickerDepthResult;
}

/** Scan YES and NO sides for positive net edge when pod-specific signals are absent. */
export function scanMarketTheses(input: ScanMarketInput): ThesisCard[] {
  const cards: ThesisCard[] = [];
  const sides: Array<{ side: 'yes' | 'no'; marketPrice: number; implied: number }> = [
    {
      side: 'yes',
      marketPrice: input.marketPrice,
      implied: Math.min(0.95, input.marketPrice + Math.max(0.05, (0.55 - input.marketPrice) * 0.4)),
    },
    {
      side: 'no',
      marketPrice: 1 - input.marketPrice,
      implied: Math.min(0.95, (1 - input.marketPrice) + Math.max(0.05, (0.55 - (1 - input.marketPrice)) * 0.4)),
    },
  ];

  for (const { side, marketPrice, implied } of sides) {
    if (input.depthContext) {
      const sideDepth = side === 'yes' ? input.depthContext.yes : input.depthContext.no;
      if (!sideDepth?.executableTier) continue;
    }
    if (implied <= marketPrice + 0.005) continue;
    // Paper fills at quoted price — no real slippage
    const breakdown = computeNetEdge(implied, marketPrice, input.spread, 0);
    if (breakdown.netEdge < (input.minNetEdge ?? 0.01)) continue;

    const qual = qualifyThesis({
      impliedPrice: implied,
      marketPrice,
      spread: input.spread,
      depthUsd: input.depthUsd,
      predictability: 55,
      freshnessMs: 2000,
      sourceAgreement: 0.75,
      regimeBlocked: false,
      concentrationBlocked: false,
      executionHealthy: true,
      minNetEdge: input.minNetEdge ?? 0.01,
      minPredictability: 45,
    });

    const now = Date.now();
    cards.push({
      id: `scan-${input.ticker}-${side}`,
      ticker: input.ticker,
      title: input.title,
      category: input.category || 'general',
      playbook: 'flow-hunter',
      status: qual.status,
      side,
      marketPrice,
      impliedPrice: implied,
      grossEdge: breakdown.grossEdge,
      netEdge: breakdown.netEdge,
      spread: input.spread,
      depthUsd: input.depthUsd,
      predictability: 55,
      feeEstimate: kalshiFeePerContract(marketPrice),
      signalReason: `Edge scan: ${side.toUpperCase()} fair ${(implied * 100).toFixed(1)}¢ vs mkt ${(marketPrice * 100).toFixed(1)}¢`,
      externalSummary: `Orderbook edge · spread ${(input.spread * 100).toFixed(1)}¢ · depth ~$${input.depthUsd.toFixed(0)}`,
      createdAt: now,
      updatedAt: now,
      freshnessMs: 2000,
      edgeHistory: [breakdown.netEdge],
      drivers: [
        { label: 'Fair value gap', impact: breakdown.grossEdge, detail: `${(implied * 100).toFixed(1)}¢ vs ${(marketPrice * 100).toFixed(1)}¢` },
        { label: 'Fees + spread', impact: -(breakdown.spreadCost + breakdown.feeCost), detail: 'Kalshi all-in costs' },
      ],
      invalidations: qual.failedGates,
      sourceMove: 'microstructure-only',
    });
  }
  return cards;
}
