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
  profitCertificate?: ProfitCertificate;
  autoCloseDecisionId?: string;
  autoCloseReason?: string;
  autoCloseAction?: AutoCloseAction;
}

export interface ProfitCertificate {
  kind: 'open' | 'close';
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPrice: number;
  exitPrice: number;
  entryFees: number;
  exitFees: number;
  netPnlUsd: number;
  bookTimestamp: number;
  expiresAt: number;
  reason: string;
  classification?: 'immediate_executable' | 'modeled_confirmed' | 'research_only';
  sourceSignalId?: string;
  sourceAgeMs?: number;
  confirmationSamples?: number;
  confirmationWindowMs?: number;
  initialNetEdge?: number;
  finalNetEdge?: number;
  edgeRetention?: number;
  bookAgeMs?: number;
  targetExitPrice?: number;
  breakEvenExitPrice?: number;
  expectedRewardUsd?: number;
  plannedLossUsd?: number;
  rewardRiskRatio?: number;
  stressedNetPnlUsd?: number;
  holdHorizonMs?: number;
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
  tier?: PositionTier;
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
  profitCertificate?: ProfitCertificate;
  autoCloseDecisionId?: string;
  autoCloseReason?: string;
  autoCloseAction?: AutoCloseAction;
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

export type PositionTier = 'scalp' | 'core' | 'runner';

export type AutoCloseAction = 'hold' | 'trim' | 'close';

export interface AutoCloseSettings {
  enabled: boolean;
  paperOnly: true;
  minAgeMs: number;
  minTicks: number;
  firstTrimProfitPct: number;
  firstTrimGivebackPct: number;
  firstTrimFraction: number;
  finalCloseProfitPct: number;
  finalCloseGivebackPct: number;
  emergencyEdgeExit: number;
  emergencyEdgeConfirmTicks: number;
  hardLossUsd: number;
  geaExitConfidence: number;
  staleSignalMs: number;
  badLiquiditySlippagePp: number;
  maxBridgeLatencyMs: number;
  minDecisionCooldownMs: number;
  highConfidenceCooldownMs: number;
  quickProfitExitEnabled: boolean;
  quickProfitPct: number;
  quickProfitEdgeCompressionTrigger: number;
  quickProfitTrimFraction: number;
  profitLockEnabled: boolean;
  minProfitLockUsd: number;
  profitLockCompressionTrigger: number;
  velocityDownTicksToTrim: number;
  predictiveCrossingEnabled: boolean;
  predictiveCrossingLeadPct: number;
  exitScoreCloseThreshold: number;
  exitScoreTrimThreshold: number;
  profitBiasEnabled: boolean;
  scalp_to_core_winRate: number;
  core_to_runner_winRate: number;
  tier_lookback_n: number;
  adaptiveEnabled: boolean;
  adaptiveMaxDriftPct: number;
}

export interface AutoCloseState {
  positionId: string;
  peakPnlUsd: number;
  peakPnlPct: number;
  peakEdge: number;
  peakMark: number;
  peakAt: number;
  tickCount: number;
  trimmedContracts: number;
  lastDecisionAt: number;
  lastMark: number;
  lastEdge: number;
  markVelocityPct: number;
  edgeVelocityPct: number;
  consecutiveDownTicks: number;
  consecutiveEdgeLossTicks?: number;
  earlyTrimContracts: number;
  tier: PositionTier;
}

export interface AutoCloseDecision {
  id: string;
  positionId: string;
  ticker: string;
  action: AutoCloseAction;
  contracts: number;
  confidence: number;
  reason: string;
  currentPnlUsd: number;
  currentPnlPct: number;
  peakPnlUsd: number;
  peakPnlPct: number;
  currentEdge: number;
  peakEdge: number;
  givebackPct: number;
  triggeredAt: number;
  tier?: PositionTier;
  exitScore?: number;
}

export interface AutoCloseStateSnapshot {
  autoCloseStateByPosition: Record<string, AutoCloseState>;
  autoCloseDecisions: AutoCloseDecision[];
}

export const DEFAULT_AUTO_CLOSE_SETTINGS: AutoCloseSettings = {
  enabled: false,
  paperOnly: true,
  minAgeMs: 30_000,
  minTicks: 3,
  firstTrimProfitPct: 0.06,
  firstTrimGivebackPct: 0.15,
  firstTrimFraction: 0.5,
  finalCloseProfitPct: 0.12,
  finalCloseGivebackPct: 0.25,
  emergencyEdgeExit: 0,
  emergencyEdgeConfirmTicks: 3,
  hardLossUsd: 1,
  geaExitConfidence: 0.85,
  staleSignalMs: 90_000,
  badLiquiditySlippagePp: 0.07,
  maxBridgeLatencyMs: 2_000,
  minDecisionCooldownMs: 5_000,
  highConfidenceCooldownMs: 500,
  quickProfitExitEnabled: false,
  quickProfitPct: 0.03,
  quickProfitEdgeCompressionTrigger: 0.2,
  quickProfitTrimFraction: 0.25,
  profitLockEnabled: true,
  minProfitLockUsd: 1,
  profitLockCompressionTrigger: 0.15,
  velocityDownTicksToTrim: 3,
  predictiveCrossingEnabled: true,
  predictiveCrossingLeadPct: 0.15,
  exitScoreCloseThreshold: 0.7,
  exitScoreTrimThreshold: 0.5,
  profitBiasEnabled: true,
  scalp_to_core_winRate: 0.6,
  core_to_runner_winRate: 0.8,
  tier_lookback_n: 20,
  adaptiveEnabled: false,
  adaptiveMaxDriftPct: 0.2,
};

import type { ShutdownCounters } from '../guardrails/engine.js';

export interface SessionStats {
  dayStart: number;
  dailyPnl: number;
  tradeCount: number;
  abortCount: number;
  startingEquity: number;
  shutdown?: ShutdownCounters;
}

export const DEFAULT_PAPER_CASH = 5000;
