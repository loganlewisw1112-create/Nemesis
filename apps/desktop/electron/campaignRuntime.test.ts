import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CampaignSnapshot } from '@nemesis/execution';
import type { ThesisCard } from '@nemesis/core';
import {
  CampaignBookTriggerScheduler,
  campaignBookUpdateWork,
  campaignPendingCapacity,
  isEvidenceOnlyCampaignExecution,
} from './campaignRuntime.js';

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
  afterEach(() => vi.useRealTimers());

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

  it('ignores unrelated deltas and does not repeat a persisted economic lifecycle', () => {
    const card = {
      id: 'card-1', ticker: 'KXTEST', side: 'yes', playbook: 'flow-hunter', sourceMove: 'flow-driven',
      signalReason: 'Whale yes 20 @ 0.40',
    } as ThesisCard;
    const active = snapshot('active');
    expect(campaignBookUpdateWork('OTHER', [card], active)).toEqual({ throughput: false, confirmation: false });
    expect(campaignBookUpdateWork('KXTEST', [card], active)).toEqual({ throughput: true, confirmation: false });

    active.candidates = [{
      candidateId: 'candidate-1', ticker: card.ticker, terminalState: 'rejected',
      economicIdentity: 'KXTEST|yes|flow-hunter|flow-driven|whale yes 20 @ 0.40',
    }] as CampaignSnapshot['candidates'];
    expect(campaignBookUpdateWork('KXTEST', [card], active)).toEqual({ throughput: false, confirmation: false });
  });

  it('routes a matching pending candidate only to confirmation work', () => {
    const active = snapshot('active');
    active.candidates = [{
      candidateId: 'candidate-1', ticker: 'KXTEST', economicIdentity: 'identity',
    }] as CampaignSnapshot['candidates'];
    expect(campaignBookUpdateWork('KXTEST', [], active)).toEqual({ throughput: false, confirmation: true });
  });

  it('coalesces a burst into one immediate and one delayed batch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const batches: Array<{ throughputTickers: string[]; confirmationTickers: string[] }> = [];
    const scheduler = new CampaignBookTriggerScheduler(500, (batch) => batches.push(batch));

    scheduler.request('KX-A', { throughput: true, confirmation: false });
    for (let index = 0; index < 100; index += 1) {
      scheduler.request('KX-A', { throughput: true, confirmation: true });
    }
    expect(batches).toEqual([{ throughputTickers: ['KX-A'], confirmationTickers: [] }]);

    vi.advanceTimersByTime(499);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([
      { throughputTickers: ['KX-A'], confirmationTickers: [] },
      { throughputTickers: ['KX-A'], confirmationTickers: ['KX-A'] },
    ]);
    scheduler.stop();
  });
});
