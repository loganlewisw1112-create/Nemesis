import type { ThesisCard, KalshiMarket, KalshiTrade } from '@nemesis/core';
import { qualifyThesis, computeNetEdge, kalshiFeePerContract } from '@nemesis/core';

const WHALE_THRESHOLD = 50;

export function tradeToThesis(trade: KalshiTrade, market?: KalshiMarket): ThesisCard | null {
  const notional = trade.count * (trade.yes_price / 100);
  if (notional < WHALE_THRESHOLD) return null;
  const marketPrice = trade.taker_side === 'yes' ? trade.yes_price / 100 : trade.no_price / 100;
  const implied = marketPrice + (trade.taker_side === 'yes' ? 0.03 : -0.03);
  const spread = 0.04;
  const breakdown = computeNetEdge(implied, marketPrice, spread, 0);
  const qual = qualifyThesis({
    impliedPrice: implied,
    marketPrice,
    spread,
    depthUsd: notional,
    predictability: 65,
    freshnessMs: 0,
    sourceAgreement: 0.85,
    regimeBlocked: false,
    concentrationBlocked: false,
    executionHealthy: true,
  });
  const now = Date.now();
  return {
    id: `flow-${trade.trade_id}`,
    ticker: trade.ticker,
    title: market?.title ?? trade.ticker,
    category: market?.category ?? 'flow',
    playbook: 'flow-hunter',
    status: qual.status,
    side: trade.taker_side,
    marketPrice,
    impliedPrice: implied,
    grossEdge: breakdown.grossEdge,
    netEdge: breakdown.netEdge,
    spread,
    depthUsd: notional,
    predictability: 65,
    feeEstimate: kalshiFeePerContract(marketPrice),
    signalReason: `Whale ${trade.taker_side.toUpperCase()} ${trade.count} @ ${marketPrice.toFixed(2)}`,
    externalSummary: `Large taker flow $${notional.toFixed(0)}`,
    createdAt: now,
    updatedAt: now,
    freshnessMs: 0,
    edgeHistory: [breakdown.netEdge],
    drivers: [{ label: 'Whale flow', impact: 0.8, detail: `${trade.count} contracts` }],
    invalidations: qual.failedGates,
    sourceMove: 'flow-driven',
  };
}
