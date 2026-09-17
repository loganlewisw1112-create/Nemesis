import { describe, expect, it } from 'vitest';
import type { LiveUnlockCertificate } from '../types.js';
import {
  CERTIFICATE_TTL_MS,
  evaluateLiveUnlock,
  evaluateStoredLiveAuthorization,
} from './liveUnlock.js';

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

describe('evaluateStoredLiveAuthorization', () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);

  function certificate(overrides: Partial<LiveUnlockCertificate> = {}): LiveUnlockCertificate {
    return {
      stage: 'manual-live',
      issuedAt: now - 60_000,
      expiresAt: now - 60_000 + CERTIFICATE_TTL_MS,
      summary: 'Paper proof passed; manual live unlocked.',
      metrics: {},
      ...overrides,
    };
  }

  it('accepts paper settings without asking for a certificate', () => {
    expect(evaluateStoredLiveAuthorization({}, now)).toEqual({ ok: true, blockers: [] });
    expect(evaluateStoredLiveAuthorization({ liveEnabled: false, liveStage: 'paper' }, now))
      .toEqual({ ok: true, blockers: [] });
  });

  it('accepts live settings backed by a current certificate', () => {
    expect(evaluateStoredLiveAuthorization(
      { liveEnabled: true, liveStage: 'manual-live', liveUnlockCertificate: certificate() },
      now,
    )).toEqual({ ok: true, blockers: [] });
  });

  it('refuses a hand-edited liveEnabled with no certificate behind it', () => {
    // The whole point: flipping one boolean in settings.json used to inherit
    // every one of the ~30 evidence gates without passing any of them.
    const result = evaluateStoredLiveAuthorization({ liveEnabled: true, liveStage: 'manual-live' }, now);
    expect(result.ok).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/no unlock certificate/i);
  });

  it('reads the 24-hour expiry that was previously written and ignored', () => {
    const expired = certificate({
      issuedAt: now - CERTIFICATE_TTL_MS - 60_000,
      expiresAt: now - 60_000,
    });
    const result = evaluateStoredLiveAuthorization(
      { liveEnabled: true, liveStage: 'manual-live', liveUnlockCertificate: expired },
      now,
    );
    expect(result.ok).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/expired/i);
  });

  it('refuses a certificate whose lifetime was stretched past the maximum', () => {
    const stretched = certificate({ expiresAt: now + 365 * CERTIFICATE_TTL_MS });
    const result = evaluateStoredLiveAuthorization(
      { liveEnabled: true, liveStage: 'manual-live', liveUnlockCertificate: stretched },
      now,
    );
    expect(result.ok).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/lifetime exceeds/i);
  });

  it('refuses a certificate issued in the future', () => {
    const future = certificate({ issuedAt: now + 3_600_000, expiresAt: now + 3_600_000 + CERTIFICATE_TTL_MS });
    expect(evaluateStoredLiveAuthorization(
      { liveEnabled: true, liveStage: 'manual-live', liveUnlockCertificate: future },
      now,
    ).blockers.join(' ')).toMatch(/issued in the future/i);
  });

  it('will not let a manual-live certificate authorize auto live', () => {
    const result = evaluateStoredLiveAuthorization(
      {
        liveEnabled: true,
        autoLiveEnabled: true,
        liveStage: 'auto-live',
        liveUnlockCertificate: certificate({ stage: 'manual-live' }),
      },
      now,
    );
    expect(result.ok).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/only unlocked manual live/i);
  });

  it('requires the stage and the certificate to agree', () => {
    const result = evaluateStoredLiveAuthorization(
      { liveEnabled: true, liveStage: 'auto-live', liveUnlockCertificate: certificate({ stage: 'manual-live' }) },
      now,
    );
    expect(result.ok).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/does not match the certificate stage/i);
  });

  it('checks a non-paper stage even when live is currently disabled', () => {
    // An inert-looking stage is still a claim, and it is what the next unlock
    // step builds on.
    const result = evaluateStoredLiveAuthorization({ liveEnabled: false, liveStage: 'manual-live' }, now);
    expect(result.ok).toBe(false);
  });

  it('refuses a malformed certificate rather than coercing it', () => {
    for (const broken of [
      certificate({ issuedAt: Number.NaN }),
      certificate({ expiresAt: Number.NaN }),
      certificate({ stage: 'paper' as never }),
    ]) {
      expect(evaluateStoredLiveAuthorization(
        { liveEnabled: true, liveStage: broken.stage, liveUnlockCertificate: broken },
        now,
      ).ok).toBe(false);
    }
  });

  it('accepts a certificate issued by evaluateLiveUnlock itself', () => {
    const evaluation = evaluateLiveUnlock({
      ...baseInput(),
      targetStage: 'manual-live',
      confirmationText: 'ENABLE LIVE MANUAL',
    });
    expect(evaluation.passed).toBe(true);
    expect(evaluateStoredLiveAuthorization(
      { liveEnabled: true, liveStage: 'manual-live', liveUnlockCertificate: evaluation.certificate },
      evaluation.certificate!.issuedAt + 1_000,
    )).toEqual({ ok: true, blockers: [] });
  });
});
