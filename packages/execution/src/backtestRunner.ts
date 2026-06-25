import type { JournalEntry } from '@nemesis/core';
import { kalshiFeeForOrder } from '@nemesis/core';

export interface BacktestResult {
  passed: boolean;
  trades: number;
  netEdgeSum: number;
  avgNetEdge: number;
  detail: string;
}

export function runFeeAwareBacktest(entries: JournalEntry[], minTrades = 10): BacktestResult {
  const sample = entries.slice(0, 100);
  if (sample.length < minTrades) {
    return {
      passed: false,
      trades: sample.length,
      netEdgeSum: 0,
      avgNetEdge: 0,
      detail: `Need at least ${minTrades} journal signals (have ${sample.length})`,
    };
  }

  let netEdgeSum = 0;
  for (const e of sample) {
    const fee = kalshiFeeForOrder(e.entryPrice, 1);
    const spreadCost = e.spread / 2;
    const netEdge = Math.abs(e.entryPrice - 0.5) - spreadCost - fee;
    netEdgeSum += netEdge;
  }
  const avgNetEdge = netEdgeSum / sample.length;
  const passed = avgNetEdge > 0;

  return {
    passed,
    trades: sample.length,
    netEdgeSum,
    avgNetEdge,
    detail: passed
      ? `Avg net edge ${(avgNetEdge * 100).toFixed(2)}¢ over ${sample.length} signals`
      : `Negative avg net edge ${(avgNetEdge * 100).toFixed(2)}¢ — improve signal quality`,
  };
}
