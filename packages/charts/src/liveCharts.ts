import type { PriceTick } from '@nemesis/core';
import { kalshiFeeForOrder } from '@nemesis/core';

export interface ChartPoint {
  x: number;
  y: number;
}

export function buildLinePath(
  values: number[],
  width: number,
  height: number,
  padding = 8,
): string {
  if (values.length === 0) return '';
  if (values.length === 1) {
    const y = height / 2;
    return `0,${y} ${width},${y}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 0.01;
  return values
    .map((v, i) => {
      const x = padding + (i / (values.length - 1)) * (width - padding * 2);
      const y = height - padding - ((v - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(' ');
}

export function computeVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const returns = prices.slice(1).map((p, i) => (p - prices[i]) / (prices[i] || 0.01));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

export function priceChangePct(ticks: PriceTick[]): number {
  if (ticks.length < 2) return 0;
  const first = ticks[0].yesPrice;
  const last = ticks[ticks.length - 1].yesPrice;
  return ((last - first) / (first || 0.01)) * 100;
}

export function unrealizedPnlSeries(
  ticks: PriceTick[],
  entryPrice: number,
  contracts: number,
  side: 'yes' | 'no',
  entryFees = 0,
): number[] {
  return ticks.map((tick) => {
    const mark = side === 'yes' ? tick.yesPrice : 1 - tick.yesPrice;
    const exitFees = kalshiFeeForOrder(mark, contracts);
    const proceeds = mark * contracts - exitFees;
    const costBasis = entryPrice * contracts + entryFees;
    return proceeds - costBasis;
  });
}

export function formatCents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}
