import type { GuardrailSettings, GateStatus } from '../types.js';

export function evaluateGates(
  settings: GuardrailSettings,
  journalCount: number,
  backtestPassed: boolean,
  apiHealthy: boolean,
  humanQuizPassed: boolean,
): GateStatus[] {
  return [
    {
      id: 'install-trust',
      name: 'Install trust',
      passed: true,
      detail: 'Application launched successfully',
    },
    {
      id: 'mode-lock',
      name: 'Mode lock',
      passed: true,
      detail: settings.liveEnabled ? 'Live trading ON' : settings.demoMode ? 'Demo mode' : 'Paper mode',
    },
    {
      id: 'key-hygiene',
      name: 'Key hygiene',
      passed: settings.demoMode || humanQuizPassed,
      detail: 'Dedicated test keys recommended before live',
    },
    {
      id: 'backtest',
      name: 'Backtest',
      passed: backtestPassed || settings.dryRun,
      detail: backtestPassed ? 'Fee-aware backtest passed' : 'Run backtest before live',
    },
    {
      id: 'dry-run-journal',
      name: 'Dry-run journal',
      passed: journalCount >= 100 || settings.dryRun,
      detail: `${journalCount}/100 signals logged`,
    },
    {
      id: 'risk-controls',
      name: 'Risk controls',
      passed: settings.maxPositionUsd > 0 && settings.dailyLossCapUsd > 0,
      detail: `Max $${settings.maxPositionUsd} / daily cap $${settings.dailyLossCapUsd}`,
    },
    {
      id: 'api-health',
      name: 'API health',
      passed: apiHealthy,
      detail: apiHealthy ? 'Connectors healthy' : 'API degradation detected',
    },
    {
      id: 'human-readiness',
      name: 'Human readiness',
      passed: humanQuizPassed || !settings.liveEnabled,
      detail: humanQuizPassed ? 'Quiz passed' : 'Complete readiness quiz for live',
    },
  ];
}

export function canEnableLive(gates: GateStatus[]): boolean {
  return gates.every((g) => g.passed);
}

export type NoTradeRegime =
  | 'spread-blowout'
  | 'depth-collapse'
  | 'source-conflict'
  | 'data-staleness'
  | 'event-chaos'
  | 'api-degradation'
  | 'post-win-lockdown'
  | 'strategy-drawdown';

export interface RegimeState {
  active: NoTradeRegime[];
  reviewOnly: boolean;
  profitLockMode: boolean;
}

export function detectNoTradeRegimes(input: {
  spread: number;
  maxSpread: number;
  depthUsd: number;
  minDepth: number;
  freshnessMs: number;
  maxFreshnessMs: number;
  sourceDisagree: boolean;
  apiHealthy: boolean;
  dailyPnl: number;
  dailyTarget: number;
  strategyDrawdown: boolean;
}): RegimeState {
  const active: NoTradeRegime[] = [];
  if (input.spread > input.maxSpread) active.push('spread-blowout');
  if (input.depthUsd < input.minDepth) active.push('depth-collapse');
  if (input.sourceDisagree) active.push('source-conflict');
  if (input.freshnessMs > input.maxFreshnessMs) active.push('data-staleness');
  if (input.dailyPnl >= input.dailyTarget) active.push('post-win-lockdown');
  if (input.strategyDrawdown) active.push('strategy-drawdown');
  return {
    active,
    reviewOnly: active.length >= 3 || input.strategyDrawdown,
    profitLockMode: input.dailyPnl >= input.dailyTarget,
  };
}

export interface ShutdownCounters {
  consecutiveInvalidations: number;
  abnormalExecutions: number;
  manualOverrides: number;
  apiDegradedMinutes: number;
}

export const DEFAULT_SHUTDOWN_COUNTERS: ShutdownCounters = {
  consecutiveInvalidations: 0,
  abnormalExecutions: 0,
  manualOverrides: 0,
  apiDegradedMinutes: 0,
};

export function shouldShutdownSession(input: ShutdownCounters): boolean {
  return (
    input.consecutiveInvalidations >= 5 ||
    input.abnormalExecutions >= 3 ||
    input.manualOverrides >= 3 ||
    input.apiDegradedMinutes >= 10
  );
}
