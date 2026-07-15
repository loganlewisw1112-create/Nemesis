import { describe, expect, it } from 'vitest';
import type { CampaignSnapshot } from '@nemesis/execution';
import { campaignPendingCapacity, isEvidenceOnlyCampaignExecution } from './campaignRuntime.js';

function snapshot(status: CampaignSnapshot['manifest']['status'], terminalStates: Array<'ready' | 'rejected' | 'expired' | undefined> = []): CampaignSnapshot {
  return {
    manifest: {
      schemaVersion: 1,
      runId: 'run',
      evidenceNamespace: 'namespace',
      configurationHash: 'cfg',
      gitCommit: 'commit',
      stage: 'instrumentation',
      startedAt: 1,
      enrollmentCutoffAt: 2,
      cutoffAt: 3,
      status,
    },
    candidates: terminalStates.map((terminalState, index) => ({ candidateId: `candidate-${index}`, terminalState })) as CampaignSnapshot['candidates'],
    diagnostics: [],
    safetyFailures: [],
    operationalChecks: [],
    eventCount: 1,
    lastSequence: 1,
    lastHash: 'hash',
    passed: false,
    reasons: [],
    validDiagnosticOutcomes: 0,
    readyCandidates: 0,
    terminalCoverage: 0,
    diagnosticSchedulingCoverage: 0,
    validDiagnosticCoverage: 0,
    freshConfirmationRate: 0,
  };
}

describe('campaign runtime isolation', () => {
  it('uses evidence-only evaluation only for active throughput campaigns', () => {
    expect(isEvidenceOnlyCampaignExecution('throughput', snapshot('active'))).toBe(true);
    expect(isEvidenceOnlyCampaignExecution('manual', snapshot('active'))).toBe(false);
    expect(isEvidenceOnlyCampaignExecution('throughput', snapshot('failed'))).toBe(false);
    expect(isEvidenceOnlyCampaignExecution('throughput', null)).toBe(false);
  });

  it('calculates pending capacity from the campaign namespace, not historical strategy validation', () => {
    const campaign = snapshot('active', [undefined, undefined, 'rejected']);
    expect(campaignPendingCapacity(campaign, 5)).toBe(3);
  });
});
