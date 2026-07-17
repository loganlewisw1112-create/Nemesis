import { describe, expect, it } from 'vitest';
import { assessProductionObservation, productionObservationStateHash, type ProductionObservationInput } from './productionObservation.js';

function safeInput(): ProductionObservationInput {
  return {
    enabled: true,
    liveEnabled: false,
    autoLiveEnabled: false,
    dryRun: true,
    demoMode: false,
    paperPositions: [],
    paperTrades: [],
    workingOrders: [],
    paperPortfolio: { cash: 5_000, positions: [], trades: [] },
    paperOrderState: [],
    protectedArtifacts: {
      paperPortfolio: 'sha256:paper',
      paperQualification: 'sha256:qualification',
      strategyValidation: 'sha256:validation',
    },
    configurationHash: 'sha256:configuration',
    protectedRuntimeState: {
      session: { tradeCount: 0, abortCount: 0 },
      equityHistory: [],
      autoClose: [],
    },
  };
}

describe('production observation evidence', () => {
  it('qualifies only a locked, empty, unchanged state', () => {
    const input = safeInput();
    const baseline = productionObservationStateHash(input);
    expect(assessProductionObservation(input, baseline)).toMatchObject({
      qualificationReady: true,
      settingsLocked: true,
      unchanged: true,
      paperPositionCount: 0,
      paperTradeCount: 0,
      workingOrderCount: 0,
    });
  });

  it('fails closed on any mutation or unsafe setting', () => {
    const input = safeInput();
    const baseline = productionObservationStateHash(input);
    const changed = {
      ...input,
      liveEnabled: true,
      paperTrades: [{ id: 'trade-1' }],
      paperPortfolio: { cash: 4_999, positions: [], trades: [{ id: 'trade-1' }] },
    };
    const result = assessProductionObservation(changed, baseline);
    expect(result.qualificationReady).toBe(false);
    expect(result.unchanged).toBe(false);
    expect(result.reasons).toContain('live, auto-live, dry-run, or demo setting is unsafe');
    expect(result.reasons).toContain('paper trades are not empty');
    expect(result.reasons).toContain('protected paper or safety state changed');
  });

  it('uses stable object-key ordering when hashing evidence', () => {
    const left = safeInput();
    const right = { ...safeInput(), paperPortfolio: { trades: [], positions: [], cash: 5_000 } };
    expect(productionObservationStateHash(left)).toBe(productionObservationStateHash(right));
  });

  it('fails closed when an auxiliary paper artifact or runtime configuration changes', () => {
    const input = safeInput();
    const baseline = productionObservationStateHash(input);
    const artifactMutation = assessProductionObservation({
      ...input,
      protectedArtifacts: {
        ...input.protectedArtifacts,
        paperQualification: 'sha256:qualification-mutated',
      },
    }, baseline);
    const configurationMutation = assessProductionObservation({
      ...input,
      configurationHash: 'sha256:configuration-mutated',
    }, baseline);
    const runtimeMutation = assessProductionObservation({
      ...input,
      protectedRuntimeState: { ...input.protectedRuntimeState as object, autoClose: [{ id: 'changed' }] },
    }, baseline);

    expect(artifactMutation.qualificationReady).toBe(false);
    expect(artifactMutation.reasons).toContain('protected paper or safety state changed');
    expect(configurationMutation.qualificationReady).toBe(false);
    expect(configurationMutation.reasons).toContain('protected paper or safety state changed');
    expect(runtimeMutation.qualificationReady).toBe(false);
  });
});
