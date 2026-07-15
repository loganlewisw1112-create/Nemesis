import { afterEach, describe, expect, it, vi } from 'vitest';
import { candidateEconomicIdentity, type CampaignSnapshot } from '@nemesis/execution';
import type { KalshiOrderbook, ThesisCard } from '@nemesis/core';
import {
  CampaignBookTriggerScheduler,
  campaignBookUpdateWork,
  campaignEnrollmentReadiness,
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
    screenedOut: [],
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
    readOnly: false,
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

  it('enrolls only from fresh exchange deltas with a resolved fee policy', () => {
    const baseBook: KalshiOrderbook = {
      ticker: 'KXTEST',
      yes: [{ price: 0.4, quantity: 10 }],
      no: [{ price: 0.59, quantity: 10 }],
      sourceTimestamp: 9_500,
      sequence: 12,
      feePolicy: {
        known: true,
        role: 'taker',
        multiplier: 1,
        accountPrecision: 'non_direct',
        scheduleVersion: 'test',
        source: 'test',
      },
    };

    expect(campaignEnrollmentReadiness(baseBook, 10_000, 1_000)).toEqual({ ready: true });
    expect(campaignEnrollmentReadiness({ ...baseBook, sourceTimestamp: undefined }, 10_000, 1_000)).toMatchObject({ ready: false });
    expect(campaignEnrollmentReadiness({ ...baseBook, sourceTimestamp: 8_999 }, 10_000, 1_000)).toMatchObject({ ready: false });
    expect(campaignEnrollmentReadiness({
      ...baseBook,
      feePolicy: {
        known: false,
        role: 'taker',
        multiplier: 1,
        accountPrecision: 'unknown',
        scheduleVersion: 'test',
        source: 'test',
      },
    }, 10_000, 1_000)).toMatchObject({ ready: false });
  });

  it('ignores unrelated deltas and does not repeat a persisted economic lifecycle', () => {
    const card = {
      id: 'card-1', ticker: 'KXTEST', side: 'yes', playbook: 'flow-hunter', sourceMove: 'flow-driven',
      signalReason: 'Whale yes 20 @ 0.40',
    } as ThesisCard;
    const active = snapshot('active');
    expect(campaignBookUpdateWork('OTHER', [card], active)).toEqual({ throughput: false, confirmation: false, diagnostic: false });
    expect(campaignBookUpdateWork('KXTEST', [card], active)).toEqual({ throughput: true, confirmation: false, diagnostic: false });

    active.candidates = [{
      candidateId: 'candidate-1', ticker: card.ticker, terminalState: 'rejected',
      economicIdentity: candidateEconomicIdentity(card),
    }] as CampaignSnapshot['candidates'];
    expect(campaignBookUpdateWork('KXTEST', [card], active)).toEqual({ throughput: false, confirmation: false, diagnostic: false });
  });

  it('routes a matching pending candidate only to confirmation work', () => {
    const active = snapshot('active');
    active.candidates = [{
      candidateId: 'candidate-1', ticker: 'KXTEST', economicIdentity: 'identity',
    }] as CampaignSnapshot['candidates'];
    expect(campaignBookUpdateWork('KXTEST', [], active)).toEqual({ throughput: false, confirmation: true, diagnostic: false });
  });

  it('routes a due diagnostic from the exact matching exchange delta', () => {
    const active = snapshot('active');
    active.candidates = [{
      candidateId: 'candidate-1', ticker: 'KXTEST', economicIdentity: 'identity', terminalState: 'rejected',
    }] as CampaignSnapshot['candidates'];
    active.diagnostics = [{
      diagnosticId: 'diagnostic-1', candidateId: 'candidate-1', dueAt: 9_000, attempts: 0,
      status: 'scheduled', qualificationEligible: false,
    }] as CampaignSnapshot['diagnostics'];

    expect(campaignBookUpdateWork('KXTEST', [], active, 10_000)).toEqual({
      throughput: false,
      confirmation: false,
      diagnostic: true,
    });
    expect(campaignBookUpdateWork('OTHER', [], active, 10_000).diagnostic).toBe(false);
  });

  it('coalesces a burst into one immediate and one delayed batch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const batches: Array<{ throughputTickers: string[]; confirmationTickers: string[]; diagnosticTickers: string[] }> = [];
    const scheduler = new CampaignBookTriggerScheduler(500, (batch) => batches.push(batch));

    scheduler.request('KX-A', { throughput: true, confirmation: false, diagnostic: false });
    for (let index = 0; index < 100; index += 1) {
      scheduler.request('KX-A', { throughput: true, confirmation: true, diagnostic: true });
    }
    expect(batches).toEqual([{ throughputTickers: ['KX-A'], confirmationTickers: [], diagnosticTickers: [] }]);

    vi.advanceTimersByTime(499);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([
      { throughputTickers: ['KX-A'], confirmationTickers: [], diagnosticTickers: [] },
      { throughputTickers: ['KX-A'], confirmationTickers: ['KX-A'], diagnosticTickers: ['KX-A'] },
    ]);
    scheduler.stop();
  });
});
