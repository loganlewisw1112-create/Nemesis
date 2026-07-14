import type { ThesisCard, KalshiMarket, KalshiTrade } from '@nemesis/core';
import { qualifyThesis, computeNetEdge, kalshiFeePerContract, clampProbability } from '@nemesis/core';

const WHALE_THRESHOLD = 50;

// Square-root price-impact law (standard microstructure heuristic): impact
// grows with the size of the flow but with diminishing returns, instead of
// every qualifying trade producing the same fixed nudge regardless of size.
const BASE_IMPACT = 0.02;
const MAX_IMPACT = 0.08;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

export function tradeToThesis(trade: KalshiTrade, market?: KalshiMarket, now = Date.now()): ThesisCard | null {
  const parsedTradeAt = Date.parse(trade.created_time);
  const tradeAgeMs = now - parsedTradeAt;
  const validTradeTime = Number.isFinite(parsedTradeAt) && tradeAgeMs >= -MAX_FUTURE_CLOCK_SKEW_MS;
  const tradeAt = validTradeTime ? parsedTradeAt : now;
  const freshnessMs = validTradeTime ? Math.max(0, tradeAgeMs) : Number.MAX_SAFE_INTEGER;
  const sidePriceCents = trade.taker_side === 'yes' ? trade.yes_price : trade.no_price;
  const notional = trade.count * (sidePriceCents / 100);
  if (notional < WHALE_THRESHOLD) return null;
  const marketPrice = sidePriceCents / 100;
  const impact = Math.min(MAX_IMPACT, BASE_IMPACT * Math.sqrt(notional / WHALE_THRESHOLD));
  const implied = clampProbability(marketPrice + impact);
  const spread = 0.04;
  const breakdown = computeNetEdge(implied, marketPrice, spread, 0);
  const qual = qualifyThesis({
    impliedPrice: implied,
    marketPrice,
    spread,
    depthUsd: notional,
    predictability: 65,
    freshnessMs,
    sourceAgreement: 0.85,
    regimeBlocked: false,
    concentrationBlocked: false,
    executionHealthy: true,
  });
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
    createdAt: tradeAt,
    updatedAt: now,
    freshnessMs,
    edgeHistory: [breakdown.netEdge],
    drivers: [{ label: 'Whale flow', impact: 0.8, detail: `${trade.count} contracts` }],
    invalidations: qual.failedGates,
    sourceMove: 'flow-driven',
  };
}
