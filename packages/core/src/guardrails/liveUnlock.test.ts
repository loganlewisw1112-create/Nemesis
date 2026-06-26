import { describe, expect, it } from 'vitest';
import { evaluateLiveUnlock } from './liveUnlock.js';

function baseInput() {
  return {
    now: 1_772_000_000_000,
    hasCredentials: true,
    gates: [{ id: 'api-health', name: 'API health', passed: true, detail: 'ok' }],
    paper: {
      tradeCount: 60,
      autoCloseDecisionCount: 30,
      realizedPnlUsd: 18,
      equityAboveStart: true,
      pnlPerRiskDollar: 0.08,
      winRate: 0.66,
      falseExitRate: 0.05,
      avgCloseRegretUsd: 0.35,
      avgSlippagePp: 0.01,
      maxDrawdownUsd: 2,
      dailyLossCapUsd: 5,
      shutdownTriggered: false,
      killSwitchActive: false,
      apiHealthy: true,
      cleanAudit: true,
    },
  };
}

describe('evaluateLiveUnlock', () => {
  it('does not unlock manual live from credentials alone', () => {
    const result = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'manual-live',
      paper: { ...baseInput().paper, tradeCount: 4, realizedPnlUsd: 0 },
      confirmationText: 'ENABLE LIVE MANUAL',
    });

    expect(result.passed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      'paper trade sample below 50',
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
