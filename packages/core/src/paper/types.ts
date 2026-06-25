export interface PriceTick {
  t: number;
  yesPrice: number;
  spread: number;
  netEdge: number;
  volume?: number;
}

export interface FillMetadata {
  expectedPrice: number;
  slippage: number;
  implementationShortfall: number;
  depthLevels?: number;
  abortReason?: string;
  mode: 'paper' | 'live';
}

export interface PaperPosition {
  id: string;
  thesisId: string;
  ticker: string;
  title: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPrice: number;
  fees: number;
  openedAt: number;
  playbook: string;
  category?: string;
  eventTicker?: string;
}

export interface PaperTrade {
  id: string;
  positionId: string;
  type: 'open' | 'close';
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  price: number;
  fees: number;
  pnl?: number;
  timestamp: number;
  expectedPrice?: number;
  slippage?: number;
  implementationShortfall?: number;
  depthLevels?: number;
  abortReason?: string;
  mode?: 'paper' | 'live';
  playbook?: string;
}

export interface PaperPortfolio {
  cash: number;
  startingCash: number;
  positions: PaperPosition[];
  trades: PaperTrade[];
  realizedPnl: number;
}

export interface PaperOrder {
  id: string;
  thesisId: string;
  ticker: string;
  side: 'yes' | 'no';
  orderType: 'limit' | 'stop' | 'take-profit';
  contracts: number;
  limitPrice: number;
  createdAt: number;
  status: 'working' | 'filled' | 'cancelled';
}

import type { ShutdownCounters } from '../guardrails/engine.js';

export interface SessionStats {
  dayStart: number;
  dailyPnl: number;
  tradeCount: number;
  abortCount: number;
  startingEquity: number;
  shutdown?: ShutdownCounters;
}

export const DEFAULT_PAPER_CASH = 1000;
