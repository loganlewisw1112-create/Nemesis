import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_QUALIFICATION, type ThesisCard } from '@nemesis/core';
import type { DryRunOrder } from './dryRun.js';
import { calculateEntryEconomics } from './tradeEconomics.js';
import { SevenHourCampaignTracker } from './sevenHourCampaign.js';

const startedAt = Date.UTC(2026, 6, 14, 12, 0, 0);
const settings = {
  ...DEFAULT_ENTRY_QUALIFICATION,
  minSamples: 3,
  minWindowMs: 20,
  maxBookAgeMs: 1_000,
  shadowFollowUpMs: 10,
  campaignDurationMs: 1_000,
  campaignEnrollmentCloseoutMs: 100,
  campaignMinValidDiagnostics: 30,
  campaignMinReadyCandidates: 1,
  campaignMinFreshSampleRate: 0.95,
};

function card(index: number): ThesisCard {
  return {
    id: `card-${index}`,
    ticker: `KXTEST-${index}`,
    title: `Test ${index}`,
    category: 'test',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.4,
    impliedPrice: 0.6,
    grossEdge: 0.2,
    netEdge: 0.15,
    spread: 0.02,
    depthUsd: 500,
    predictability: 0.9,
    feeEstimate: 0.02,
    signalReason: `persistent flow ${index}`,
    externalSummary: '',
    createdAt: startedAt,
    updatedAt: startedAt,
    freshnessMs: 0,
    edgeHistory: [0.15],
    drivers: [],
    invalidations: [],
    sourceMove: 'flow-driven',
  };
}

function fill(ticker: string): DryRunOrder {
  return {
    ticker,
    side: 'yes',
    contracts: 10,
    expectedPrice: 0.4,
    fillPrice: 0.4,
    filled: 10,
    fillLevels: [{ price: 0.4, quantity: 10, cost: 4 }],
    slippage: 0,
    fees: 0.17,
    feePolicyKnown: true,
    netEdge: 0.183,
    aborted: false,
  };
}

function economics(candidate: ThesisCard, initialFill: DryRunOrder) {
  return calculateEntryEconomics({
    entryPrice: initialFill.fillPrice,
    entryFeesUsd: initialFill.fees,
    contracts: initialFill.filled,
    sideFairPrice: candidate.impliedPrice,
    marketPrice: candidate.marketPrice,
    grossEdge: candidate.grossEdge,
    screeningNetEdge: candidate.netEdge,
    executableEntryNetEdge: initialFill.netEdge,
    spread: candidate.spread,
    fillSlippage: initialFill.slippage,
  });
}

function start() {
  return SevenHourCampaignTracker.start({
    runId: 'run-7h',
    evidenceNamespace: 'evidence-7h',
    configurationHash: 'cfg-a',
    gitCommit: 'abc123',
    stage: 'seven-hour',
    startedAt,
    settings,
  });
}

describe('SevenHourCampaignTracker', () => {
  it('invalidates pending lifecycles before samples can mix across configuration hashes', () => {
    const tracker = start();
    const candidate = card(99);
    const initialFill = fill(candidate.ticker);
    tracker.enroll({ card: candidate, initialFill, economics: economics(candidate, initialFill), enrolledAt: startedAt });
    tracker.ensureConfiguration('cfg-b', startedAt + 1);
    const snapshot = tracker.snapshot();
    expect(snapshot.manifest.status).toBe('invalidated');
    expect(snapshot.candidates[0]!.terminalState).toBe('expired');
    expect(snapshot.manifest.invalidationReason).toMatch(/cannot be combined/i);
  });

  it('deduplicates ten concurrent deliveries into one lifecycle and one diagnostic', async () => {
    const tracker = start();
    const candidate = card(1);
    const initialFill = fill(candidate.ticker);
    await Promise.all(Array.from({ length: 10 }, async () => tracker.enroll({
      card: candidate,
      initialFill,
      economics: economics(candidate, initialFill),
      enrolledAt: startedAt,
    })));
    const snapshot = tracker.snapshot();
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.eventCount).toBe(2);
  });

  it('replays three samples after restart and permits exactly one terminal and diagnostic event', () => {
    const tracker = start();
    const candidate = card(2);
    const initialFill = fill(candidate.ticker);
    tracker.enroll({ card: candidate, initialFill, economics: economics(candidate, initialFill), enrolledAt: startedAt });
    const candidateId = tracker.snapshot().candidates[0]!.candidateId;
    for (let index = 0; index < 3; index += 1) {
      tracker.recordSample(candidateId, {
        at: startedAt + index * 10,
        observedAt: startedAt + index * 10,
        netEdge: 0.18,
        spread: 0.02,
        bookTimestamp: startedAt + index * 10,
        bookSequence: index + 1,
        exchangeTimestamp: startedAt + index * 10,
        exchangeSequence: index + 1,
        fillPrice: 0.4,
        filled: 10,
        fees: 0.17,
        feePolicyKnown: true,
      });
    }

    const restarted = SevenHourCampaignTracker.replay(tracker.allEvents(), settings);
    expect(restarted.snapshot().integrityError).toBeUndefined();
    expect(restarted.snapshot().candidates[0]!.samples).toHaveLength(3);
    restarted.terminalize(candidateId, 'ready', 'confirmed', startedAt + 30);
    restarted.terminalize(candidateId, 'rejected', 'duplicate ignored', startedAt + 31);
    const diagnosticId = restarted.snapshot().diagnostics[0]!.diagnosticId;
    restarted.completeDiagnostic({
      diagnosticId,
      validExecutableObservation: true,
      exchangeTimestamp: startedAt + 40,
      exchangeSequence: 4,
      executableFollowUpMark: 0.5,
      reconstructedExitFill: { ...initialFill, fillPrice: 0.5 },
      executableNetPnlUsd: 0.8,
      reason: 'valid',
      completedAt: startedAt + 40,
    });
    restarted.completeDiagnostic({ diagnosticId, validExecutableObservation: true, reason: 'duplicate', completedAt: startedAt + 41 });
    expect(restarted.snapshot().candidates[0]!.terminalState).toBe('ready');
    expect(restarted.snapshot().diagnostics[0]!.status).toBe('scored');
    expect(restarted.allEvents().filter((event) => event.type === 'candidate_terminal')).toHaveLength(1);
    expect(restarted.allEvents().filter((event) => event.type === 'diagnostic_scored')).toHaveLength(1);
  });

  it('enforces T+6:45 enrollment stop, fixed cutoff, 30 diagnostics, and one ready candidate', () => {
    const tracker = start();
    tracker.recordOperationalCheck('renderer_memory_stable', true, 'stable', startedAt + 100);
    tracker.recordOperationalCheck('bridge_bidirectional_traffic', true, 'recent traffic', startedAt + 100);
    tracker.recordOperationalCheck('exchange_book_time_available', true, 'exchange timestamp and sequence observed', startedAt + 100);
    for (let index = 0; index < 30; index += 1) {
      const candidate = card(index);
      const initialFill = fill(candidate.ticker);
      tracker.enroll({ card: candidate, initialFill, economics: economics(candidate, initialFill), enrolledAt: startedAt + 899 });
      const record = tracker.snapshot().candidates.at(-1)!;
      tracker.recordSample(record.candidateId, {
        at: startedAt + 899,
        observedAt: startedAt + 899,
        netEdge: 0.18,
        spread: 0.02,
        bookTimestamp: startedAt + 899,
        bookSequence: index + 1,
        exchangeTimestamp: startedAt + 899,
        exchangeSequence: index + 1,
        fillPrice: 0.4,
        filled: 10,
        fees: 0.17,
        feePolicyKnown: true,
      });
      tracker.terminalize(record.candidateId, index === 0 ? 'ready' : 'rejected', index === 0 ? 'confirmed' : 'not feasible', startedAt + 900);
      tracker.completeDiagnostic({
        diagnosticId: `diag:${record.candidateId}`,
        validExecutableObservation: true,
        exchangeTimestamp: startedAt + 900,
        exchangeSequence: index + 31,
        executableFollowUpMark: 0.5,
        reconstructedExitFill: { ...initialFill, fillPrice: 0.5 },
        executableNetPnlUsd: 0.8,
        reason: 'valid',
        completedAt: startedAt + 900,
      });
    }
    const late = card(31);
    const lateFill = fill(late.ticker);
    tracker.enroll({ card: late, initialFill: lateFill, economics: economics(late, lateFill), enrolledAt: startedAt + 901 });
    expect(tracker.snapshot().candidates).toHaveLength(30);
    tracker.finalize(startedAt + 1_000);
    const snapshot = tracker.snapshot();
    expect(snapshot.manifest.status).toBe('passed');
    expect(snapshot.validDiagnosticOutcomes).toBe(30);
    expect(snapshot.readyCandidates).toBe(1);
    expect(snapshot.terminalCoverage).toBe(1);
  });
});
