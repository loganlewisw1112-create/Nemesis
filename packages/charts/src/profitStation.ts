import type { EdgeBreakdown, PaperTrade, PaperPosition } from '@nemesis/core';
import { buildLinePath } from './liveCharts.js';

export function feeWaterfallData(b: EdgeBreakdown) {
  return [
    { label: 'Gross edge', value: b.grossEdge, color: '#22c55e' },
    { label: 'Spread', value: -b.spreadCost, color: '#ef4444' },
    { label: 'Fees', value: -b.feeCost, color: '#f97316' },
    { label: 'Slippage buf', value: -b.slippageBuffer, color: '#eab308' },
    { label: 'Net edge', value: b.netEdge, color: '#6366f1' },
  ];
}

export function edgeDecayPoints(history: number[]): { x: number; y: number }[] {
  return history.map((y, x) => ({ x, y }));
}

export interface EquityPoint {
  t: number;
  equity: number;
  deployed: number;
  cash: number;
}

export interface ProfitMetrics {
  equity: number;
  totalPnl: number;
  pctReturn: number;
  cash: number;
  deployed: number;
  unrealized: number;
  realizedPnl: number;
}

export function equitySeries(points: EquityPoint[]): number[] {
  return points.map((p) => p.equity);
}

export function profitSeries(points: EquityPoint[], startingCash: number): number[] {
  return points.map((p) => p.equity - startingCash);
}

export function pctReturnSeries(points: EquityPoint[], startingCash: number): number[] {
  if (startingCash <= 0) return points.map(() => 0);
  return points.map((p) => ((p.equity - startingCash) / startingCash) * 100);
}

export function deployedSeries(points: EquityPoint[]): number[] {
  return points.map((p) => p.deployed);
}

export function cashSeries(points: EquityPoint[]): number[] {
  return points.map((p) => p.cash);
}

export function profitMetrics(
  points: EquityPoint[],
  startingCash: number,
  unrealized: number,
  realizedPnl: number,
): ProfitMetrics {
  const last = points[points.length - 1];
  const equity = last?.equity ?? startingCash;
  const totalPnl = equity - startingCash;
  const pctReturn = startingCash > 0 ? (totalPnl / startingCash) * 100 : 0;
  return {
    equity,
    totalPnl,
    pctReturn,
    cash: last?.cash ?? startingCash,
    deployed: last?.deployed ?? 0,
    unrealized,
    realizedPnl,
  };
}

export function buildEquityCurve(
  points: EquityPoint[],
  width = 400,
  height = 120,
): string {
  return buildLinePath(equitySeries(points), width, height);
}

export interface FillQualityMetrics {
  avgSlippage: number;
  avgShortfall: number;
  abortRate: number;
  fillCount: number;
}

export function computeFillQuality(trades: PaperTrade[]): FillQualityMetrics {
  const fills = trades.filter((t) => t.slippage !== undefined && !t.abortReason);
  const aborts = trades.filter((t) => t.abortReason);
  if (fills.length === 0) {
    return { avgSlippage: 0, avgShortfall: 0, abortRate: 0, fillCount: 0 };
  }
  const avgSlippage = fills.reduce((s, t) => s + (t.slippage ?? 0), 0) / fills.length;
  const avgShortfall = fills.reduce((s, t) => s + (t.implementationShortfall ?? 0), 0) / fills.length;
  const total = fills.length + aborts.length;
  return {
    avgSlippage,
    avgShortfall,
    abortRate: total > 0 ? aborts.length / total : 0,
    fillCount: fills.length,
  };
}

export interface DepthLadderRow {
  label: string;
  expected: number;
  filled: number;
  slippage: number;
}

export function depthLadderFromTrades(trades: PaperTrade[], limit = 8): DepthLadderRow[] {
  return trades
    .filter((t) => t.expectedPrice !== undefined && t.type === 'open')
    .slice(0, limit)
    .map((t) => ({
      label: `${t.ticker} ${t.side}`,
      expected: t.expectedPrice ?? t.price,
      filled: t.price,
      slippage: t.slippage ?? 0,
    }));
}

export interface PlaybookAttribution {
  playbook: string;
  realizedPnl: number;
  tradeCount: number;
}

export function playbookAttribution(
  trades: PaperTrade[],
  positions: PaperPosition[],
): PlaybookAttribution[] {
  const map = new Map<string, { pnl: number; count: number }>();
  for (const t of trades) {
    if (t.type !== 'close' || t.pnl === undefined) continue;
    const pb = t.playbook ?? positions.find((p) => p.id === t.positionId)?.playbook ?? 'unknown';
    const cur = map.get(pb) ?? { pnl: 0, count: 0 };
    cur.pnl += t.pnl;
    cur.count += 1;
    map.set(pb, cur);
  }
  return [...map.entries()].map(([playbook, v]) => ({
    playbook,
    realizedPnl: v.pnl,
    tradeCount: v.count,
  }));
}

export interface PortfolioFeeWaterfall {
  grossPnl: number;
  feesPaid: number;
  netPnl: number;
}

export function portfolioFeeWaterfall(trades: PaperTrade[]): PortfolioFeeWaterfall {
  const closes = trades.filter((t) => t.type === 'close');
  const grossPnl = closes.reduce((s, t) => s + (t.pnl ?? 0) + t.fees, 0);
  const feesPaid = trades.reduce((s, t) => s + t.fees, 0);
  const netPnl = closes.reduce((s, t) => s + (t.pnl ?? 0), 0);
  return { grossPnl, feesPaid, netPnl };
}
