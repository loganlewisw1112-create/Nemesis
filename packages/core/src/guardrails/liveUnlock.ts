import type { GateStatus, LiveUnlockCertificate } from '../types.js';

export type LiveUnlockTargetStage = 'manual-live' | 'auto-live';

export interface PaperUnlockMetrics {
  completedPositionCount: number;
  profitableWeekCount: number;
  profitFactor: number;
  averageNetPnlUsd: number;
  realizedPnlUsd: number;
  equityAboveStart: boolean;
  pnlPerRiskDollar: number;
  winRate: number;
  largestWinShare: number;
  profitConfidenceRate: number;
  stressedNetPnlUsd: number;
  stressedProfitFactor: number;
  rollingLossPaused: boolean;
  configurationValid: boolean;
  manualScoredCloseCount: number;
  automaticScoredCloseCount: number;
  benchmarkPassed: boolean;
  falseExitRate: number;
  avgCloseRegretUsd: number;
  avgSlippagePp: number;
  maxDrawdownUsd: number;
  dailyLossCapUsd: number;
  shutdownTriggered: boolean;
  killSwitchActive: boolean;
  apiHealthy: boolean;
  cleanAudit: boolean;
  blockingSafetyEventCount: number;
}

export interface ManualLiveMetrics {
  orderCount: number;
  reconciled: boolean;
  riskBreaches: number;
  unresolvedRejects: number;
  avgSlippagePp: number;
  modeledSlippagePp: number;
}

export interface ShadowAutoMetrics {
  decisions: number;
  expectancy: number;
  manualExpectancy: number;
  falseExitRate: number;
  missedTicketReduction: number;
}

export interface TinyAutoPilotMetrics {
  trades: number;
  expectancy: number;
  riskBreaches: number;
}

export interface LiveUnlockInput {
  now: number;
  targetStage: LiveUnlockTargetStage;
  currentStage?: 'paper' | 'manual-live' | 'auto-live';
  hasCredentials: boolean;
  gates: GateStatus[];
  paper: PaperUnlockMetrics;
  manualLive?: ManualLiveMetrics;
  shadowAuto?: ShadowAutoMetrics;
  tinyAutoPilot?: TinyAutoPilotMetrics;
  confirmationText: string;
}

export interface LiveUnlockEvaluation {
  targetStage: LiveUnlockTargetStage;
  passed: boolean;
  blockers: string[];
  certificate?: LiveUnlockCertificate;
}

const CERTIFICATE_TTL_MS = 24 * 60 * 60 * 1000;

function addPaperBlockers(input: LiveUnlockInput, blockers: string[]) {
  if (!input.hasCredentials) blockers.push('Kalshi credentials not configured');
  for (const gate of input.gates) {
    if (!gate.passed) blockers.push(`${gate.name}: ${gate.detail}`);
  }
  const p = input.paper;
  if (p.completedPositionCount < 100) blockers.push('completed paper position sample below 100');
  if (p.profitableWeekCount < 4) blockers.push('fewer than four consecutive profitable weeks');
  if (p.profitFactor < 1.5) blockers.push('paper profit factor below 1.50');
  if (p.averageNetPnlUsd <= 0) blockers.push('average paper position P&L must be positive');
  if (p.realizedPnlUsd <= 0) blockers.push('paper realized P&L must be positive');
  if (!p.equityAboveStart) blockers.push('paper equity must be above start');
  if (p.pnlPerRiskDollar <= 0) blockers.push('paper P&L per risk dollar must be positive');
  if (p.winRate < 0.65) blockers.push('paper win rate below 65%');
  if (p.largestWinShare > 0.2) blockers.push('largest paper win exceeds 20% of winning dollars');
  if (p.profitConfidenceRate < 0.95) blockers.push('profit resampling confidence below 95%');
  if (p.stressedNetPnlUsd <= 0) blockers.push('one-cent stressed paper P&L must be positive');
  if (p.stressedProfitFactor < 1.1) blockers.push('one-cent stressed profit factor below 1.10');
  if (p.rollingLossPaused) blockers.push('qualification run has a rolling-loss pause');
  if (!p.configurationValid) blockers.push('qualification settings changed during the run');
  if (p.manualScoredCloseCount < 30) blockers.push('scored manual-close sample below 30');
  if (p.automaticScoredCloseCount < 30) blockers.push('scored automatic-close sample below 30');
  if (!p.benchmarkPassed) blockers.push('automatic-close improvement target not passed');
  if (p.falseExitRate > 0.1) blockers.push('paper false-exit rate above 10%');
  if (p.avgCloseRegretUsd > 0.5) blockers.push('paper close regret above $0.50');
  if (p.avgSlippagePp > 0.03) blockers.push('paper slippage above 3pp');
  if (p.maxDrawdownUsd > p.dailyLossCapUsd) blockers.push('paper drawdown exceeds daily loss cap');
  if (p.shutdownTriggered) blockers.push('shutdown counters triggered');
  if (p.killSwitchActive) blockers.push('kill switch active');
  if (!p.apiHealthy) blockers.push('API health degraded');
  if (!p.cleanAudit) blockers.push('audit log has unresolved failures');
  if (p.blockingSafetyEventCount > 0) blockers.push('blocking safety events are present');
}

function addAutoBlockers(input: LiveUnlockInput, blockers: string[]) {
  if (input.currentStage !== 'manual-live' && input.currentStage !== 'auto-live') {
    blockers.push('manual live stage must be unlocked before auto live');
  }

  const manual = input.manualLive;
  if (!manual) {
    blockers.push('manual live metrics missing');
  } else {
    if (manual.orderCount < 20) blockers.push('manual live order sample below 20');
    if (!manual.reconciled) blockers.push('manual live reconciliation not clean');
    if (manual.riskBreaches > 0) blockers.push('manual live risk breaches present');
    if (manual.unresolvedRejects > 0) blockers.push('manual live unresolved rejects present');
    if (manual.avgSlippagePp > manual.modeledSlippagePp + 0.02) blockers.push('manual live slippage exceeds modeled slippage by more than 2pp');
  }

  const shadow = input.shadowAuto;
  if (!shadow) {
    blockers.push('shadow auto metrics missing');
  } else {
    if (shadow.decisions < 30) blockers.push('shadow auto decisions below 30');
    if (shadow.expectancy < shadow.manualExpectancy) blockers.push('shadow auto expectancy below manual baseline');
    if (shadow.falseExitRate > 0.08) blockers.push('shadow auto false-exit rate above 8%');
    if (shadow.missedTicketReduction <= 0) blockers.push('shadow auto missed-ticket reduction must be positive');
  }

  const pilot = input.tinyAutoPilot;
  if (!pilot) {
    blockers.push('tiny auto pilot metrics missing');
  } else {
    if (pilot.trades < 15) blockers.push('tiny auto pilot below 15 trades');
    if (pilot.expectancy <= 0) blockers.push('tiny auto pilot expectancy must be positive');
    if (pilot.riskBreaches > 0) blockers.push('tiny auto pilot risk breaches present');
  }
}

export function evaluateLiveUnlock(input: LiveUnlockInput): LiveUnlockEvaluation {
  const blockers: string[] = [];
  addPaperBlockers(input, blockers);

  if (input.targetStage === 'manual-live') {
    if (input.confirmationText !== 'ENABLE LIVE MANUAL') blockers.push('Type ENABLE LIVE MANUAL to confirm');
  } else {
    if (input.confirmationText !== 'ENABLE LIVE AUTO') blockers.push('Type ENABLE LIVE AUTO to confirm');
    addAutoBlockers(input, blockers);
  }

  if (blockers.length > 0) return { targetStage: input.targetStage, passed: false, blockers };

  return {
    targetStage: input.targetStage,
    passed: true,
    blockers: [],
    certificate: {
      stage: input.targetStage,
      issuedAt: input.now,
      expiresAt: input.now + CERTIFICATE_TTL_MS,
      summary: input.targetStage === 'manual-live'
        ? 'Paper proof passed; manual live unlocked.'
        : 'Manual live, shadow auto, and tiny auto pilot passed; auto live unlocked.',
      metrics: {
        paperTrades: input.paper.completedPositionCount,
        paperWinRate: input.paper.winRate,
        paperPnlPerRiskDollar: input.paper.pnlPerRiskDollar,
        manualOrders: input.manualLive?.orderCount ?? 0,
        shadowDecisions: input.shadowAuto?.decisions ?? 0,
        tinyPilotTrades: input.tinyAutoPilot?.trades ?? 0,
      },
    },
  };
}
