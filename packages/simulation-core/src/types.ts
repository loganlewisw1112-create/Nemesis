import type { KalshiOrderbook } from '@nemesis/core';

export interface ExecutionSimRequest {
  ticker: string;
  side: 'yes' | 'no';
  qty: number;
  book: KalshiOrderbook;
}

export interface ExecutionSimFill {
  id: string;
  ticker: string;
  side: 'yes' | 'no';
  qty: number;
  fill_price: number;
  slippage: number;
  spread: number;
  fees: number;
  aborted: boolean;
  abortReason?: string;
  filled_at: number;
}

export interface SandboxPosition {
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  avgPrice: number;
}

export interface SandboxPortfolioSnapshot {
  cash: number;
  positions: SandboxPosition[];
  fills: ExecutionSimFill[];
}

export interface ReplayEvent {
  id: string;
  timestamp: number;
  type: 'snapshot' | 'trade' | 'public-data' | 'brain-output' | 'decision';
  payload: Record<string, unknown>;
}

export interface MetricObservation {
  predicted: number;
  actual: 0 | 1;
  pnl: number;
  edgeCaptured: number;
  blocked: boolean;
  shouldBlock: boolean;
}

export interface MetricSummary {
  brier_score: number;
  hit_rate: number;
  pnl: number;
  edge_capture: number;
  blocked_ticket_accuracy: number;
}
