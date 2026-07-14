import { describe, expect, it } from 'vitest';
import { evaluateLiveUnlock } from './liveUnlock.js';

function baseInput() {
  return {
    now: 1_772_000_000_000,
    hasCredentials: true,
    gates: [{ id: 'api-health', name: 'API health', passed: true, detail: 'ok' }],
    paper: {
      validationStage: 'qualification' as const,
      completedPositionCount: 100,
      profitableWeekCount: 4,
      profitFactor: 1.5,
      averageNetPnlUsd: 0.18,
      realizedPnlUsd: 18,
      equityAboveStart: true,
      pnlPerRiskDollar: 0.08,
      winRate: 0.65,
      largestWinShare: 0.2,
      profitConfidenceRate: 0.95,
      stressedNetPnlUsd: 4,
      stressedProfitFactor: 1.1,
      rollingLossPaused: false,
      configurationValid: true,
      manualScoredCloseCount: 30,
      automaticScoredCloseCount: 30,
      benchmarkPassed: true,
      falseExitRate: 0.1,
      avgCloseRegretUsd: 0.5,
      avgSlippagePp: 0.03,
      maxDrawdownUsd: 150,
      dailyLossCapUsd: 150,
      shutdownTriggered: false,
      killSwitchActive: false,
      apiHealthy: true,
      cleanAudit: true,
      blockingSafetyEventCount: 0,
    },
  };
}

describe('evaluateLiveUnlock', () => {
  it.each(['shadow', 'pilot'] as const)('blocks live while strategy validation is in %s', (validationStage) => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'manual-live',
      paper: { ...baseInput().paper, validationStage },
      confirmationText: 'ENABLE LIVE MANUAL',
    });
    expect(result.passed).toBe(false);
    expect(result.blockers).toContain('strategy validation stage has not reached qualification');
  });

  it('does not unlock manual live from credentials alone', () => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'manual-live',
      paper: { ...baseInput().paper, completedPositionCount: 99, realizedPnlUsd: 0 },
      confirmationText: 'ENABLE LIVE MANUAL',
    });

    expect(result.passed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      'completed paper position sample below 100',
      'paper realized P&L must be positive',
    ]));
  });

  it('issues a manual live certificate after paper proof and explicit confirmation', () => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'manual-live',
      confirmationText: 'ENABLE LIVE MANUAL',
    });

    expect(result.passed).toBe(true);
    expect(result.certificate?.stage).toBe('manual-live');
  });

  it('passes on the safe side of every paper qualification boundary', () => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'manual-live',
      paper: {
        ...baseInput().paper,
        completedPositionCount: 101,
        profitableWeekCount: 5,
        profitFactor: 1.501,
        averageNetPnlUsd: 0.19,
        pnlPerRiskDollar: 0.081,
        winRate: 0.651,
        largestWinShare: 0.199,
        profitConfidenceRate: 0.951,
        stressedNetPnlUsd: 4.01,
        stressedProfitFactor: 1.101,
        manualScoredCloseCount: 31,
        automaticScoredCloseCount: 31,
        falseExitRate: 0.099,
        avgCloseRegretUsd: 0.499,
        avgSlippagePp: 0.029,
        maxDrawdownUsd: 149.99,
      },
      confirmationText: 'ENABLE LIVE MANUAL',
    });
    expect(result.passed).toBe(true);
  });

  it.each([
    ['completedPositionCount', 99, 'completed paper position sample below 100'],
    ['profitableWeekCount', 3, 'fewer than four consecutive profitable weeks'],
    ['profitFactor', 1.499, 'paper profit factor below 1.50'],
    ['averageNetPnlUsd', 0, 'average paper position P&L must be positive'],
    ['pnlPerRiskDollar', 0, 'paper P&L per risk dollar must be positive'],
    ['winRate', 0.649, 'paper win rate below 65%'],
    ['largestWinShare', 0.201, 'largest paper win exceeds 20% of winning dollars'],
    ['profitConfidenceRate', 0.949, 'profit resampling confidence below 95%'],
    ['stressedNetPnlUsd', 0, 'one-cent stressed paper P&L must be positive'],
    ['stressedProfitFactor', 1.099, 'one-cent stressed profit factor below 1.10'],
    ['manualScoredCloseCount', 29, 'scored manual-close sample below 30'],
    ['automaticScoredCloseCount', 29, 'scored automatic-close sample below 30'],
    ['falseExitRate', 0.101, 'paper false-exit rate above 10%'],
    ['avgCloseRegretUsd', 0.501, 'paper close regret above $0.50'],
    ['avgSlippagePp', 0.031, 'paper slippage above 3pp'],
    ['maxDrawdownUsd', 150.01, 'paper drawdown exceeds daily loss cap'],
  ] as const)('blocks immediately below or above the %s boundary', (field, value, blocker) => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'manual-live',
      paper: { ...baseInput().paper, [field]: value },
      confirmationText: 'ENABLE LIVE MANUAL',
    });
    expect(result.blockers).toContain(blocker);
  });

  it.each([
    ['rollingLossPaused', true, 'qualification run has a rolling-loss pause'],
    ['configurationValid', false, 'qualification settings changed during the run'],
    ['benchmarkPassed', false, 'automatic-close improvement target not passed'],
    ['cleanAudit', false, 'audit log has unresolved failures'],
    ['blockingSafetyEventCount', 1, 'blocking safety events are present'],
  ] as const)('fails closed when %s is unsafe', (field, value, blocker) => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'manual-live',
      paper: { ...baseInput().paper, [field]: value },
      confirmationText: 'ENABLE LIVE MANUAL',
    });
    expect(result.blockers).toContain(blocker);
  });

  it('blocks auto live until manual stability, shadow readiness, and tiny pilot pass', () => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'auto-live',
      currentStage: 'manual-live',
      confirmationText: 'ENABLE LIVE AUTO',
      manualLive: { orderCount: 20, reconciled: true, riskBreaches: 0, unresolvedRejects: 0, avgSlippagePp: 0.01, modeledSlippagePp: 0.015 },
      shadowAuto: { decisions: 30, expectancy: 0.01, manualExpectancy: 0.02, falseExitRate: 0.04, missedTicketReduction: 0.1 },
      tinyAutoPilot: { trades: 0, expectancy: 0, riskBreaches: 0 },
    });

    expect(result.passed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      'shadow auto expectancy below manual baseline',
      'tiny auto pilot below 15 trades',
    ]));
  });

  it('issues an auto live certificate only after all three post-manual evals pass', () => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'auto-live',
      currentStage: 'manual-live',
      confirmationText: 'ENABLE LIVE AUTO',
      manualLive: { orderCount: 22, reconciled: true, riskBreaches: 0, unresolvedRejects: 0, avgSlippagePp: 0.01, modeledSlippagePp: 0.015 },
      shadowAuto: { decisions: 35, expectancy: 0.04, manualExpectancy: 0.02, falseExitRate: 0.04, missedTicketReduction: 0.2 },
      tinyAutoPilot: { trades: 16, expectancy: 0.03, riskBreaches: 0 },
    });

    expect(result.passed).toBe(true);
    expect(result.certificate?.stage).toBe('auto-live');
  });
});
