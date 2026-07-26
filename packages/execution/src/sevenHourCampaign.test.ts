import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildKalshiFeePolicy, DEFAULT_ENTRY_QUALIFICATION, type KalshiFeePolicy, type ThesisCard } from '@nemesis/core';
import { qualifyCampaignEnrollment } from './campaignEnrollment.js';
import type { DryRunOrder } from './dryRun.js';
import {
  DIAGNOSTIC_RETRY_OFFSETS_MS,
  SevenHourCampaignTracker,
  candidateEconomicIdentity,
  type CampaignEvent,
  type DiagnosticAttemptOutcome,
} from './sevenHourCampaign.js';

const startedAt = Date.UTC(2026, 6, 14, 12, 0, 0);
const productionArtifactHash = 'a'.repeat(64);
const soakVerificationReceiptHash = 'b'.repeat(64);
const feePolicy = buildKalshiFeePolicy({ multiplier: 1, accountPrecision: 'direct' });
const r9LedgerPath = path.join(
  process.env.APPDATA ?? 'C:\\Users\\logan\\AppData\\Roaming',
  '@nemesis',
  'desktop',
  'nemesis-data',
  'evidence-campaigns',
  'nemesis-instrumentation-2026-07-15-r9.jsonl',
);
const settings = {
  ...DEFAULT_ENTRY_QUALIFICATION,
  minSamples: 3,
  minWindowMs: 20,
  maxBookAgeMs: 1_000,
  shadowFollowUpMs: 10,
  campaignDurationMs: 10 * 60_000,
  campaignEnrollmentCloseoutMs: 100,
  campaignMinValidDiagnostics: 30,
  campaignMinReadyCandidates: 1,
  campaignMinFreshSampleRate: 0.95,
};

function card(index: number, overrides: Partial<ThesisCard> = {}): ThesisCard {
  return {
    id: `card-${index}`,
    ticker: `KXTEST-${index}`,
    title: `Test ${index}`,
    category: 'test',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.4,
    impliedPrice: 0.65,
    grossEdge: 0.25,
    netEdge: 0.2,
    spread: 0.02,
    depthUsd: 500,
    predictability: 0.9,
    feeEstimate: 0.02,
    signalReason: `persistent flow ${index}`,
    externalSummary: '',
    createdAt: startedAt,
    updatedAt: startedAt,
    freshnessMs: 0,
    edgeHistory: [0.2],
    drivers: [],
    invalidations: [],
    sourceMove: 'flow-driven',
    ...overrides,
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
    netEdge: 0.233,
    aborted: false,
  };
}

function start(stage: 'instrumentation' | 'seven-hour' = 'seven-hour') {
  return SevenHourCampaignTracker.start({
    runId: `run-${stage}`,
    evidenceNamespace: `evidence-${stage}`,
    configurationHash: 'cfg-a',
    gitCommit: 'abc123',
    stage,
    startedAt,
    settings,
    healthPolicyHash: 'health-a',
    runtimeSidecarPath: 'runtime.jsonl',
    productionArtifactHash,
    soakVerificationReceiptHash,
  });
}

function screen(candidate: ThesisCard, at = startedAt) {
  const initialFill = fill(candidate.ticker);
  const decision = qualifyCampaignEnrollment({
    card: candidate,
    fill: initialFill,
    bookTimestamp: at,
    bookSequence: Number(candidate.id.replace(/\D/g, '')) + 1,
    feePolicy,
    observedAt: at,
    maxSafeContracts: 10,
    entryRiskUsd: 4.17,
    settings,
  });
  if (decision.status !== 'eligible') throw new Error(decision.reason);
  return { initialFill, decision };
}

function enroll(tracker: SevenHourCampaignTracker, candidate: ThesisCard, at = startedAt) {
  const { initialFill, decision } = screen(candidate, at);
  tracker.enrollQualified({ card: candidate, initialFill, screening: decision, completedAt: at });
  return tracker.snapshot().candidates.find((item) => item.originalCardId === candidate.id)!;
}

describe('campaign schema-v2 screening and lifecycle', () => {
  it('screens out future-dated source and orderbook evidence', () => {
    const sourceInFuture = card(501, { createdAt: startedAt + 1 });
    expect(qualifyCampaignEnrollment({
      card: sourceInFuture,
      fill: fill(sourceInFuture.ticker),
      bookTimestamp: startedAt,
      bookSequence: 501,
      feePolicy,
      observedAt: startedAt,
      maxSafeContracts: 10,
      entryRiskUsd: 4.17,
      settings,
    })).toMatchObject({ status: 'screened_out', reasonCode: 'source_stale' });

    const futureBook = card(502);
    expect(qualifyCampaignEnrollment({
      card: futureBook,
      fill: fill(futureBook.ticker),
      bookTimestamp: startedAt + 1,
      bookSequence: 502,
      feePolicy,
      observedAt: startedAt,
      maxSafeContracts: 10,
      entryRiskUsd: 4.17,
      settings,
    })).toMatchObject({ status: 'screened_out', reasonCode: 'book_stale' });
  });

  it.skipIf(!fs.existsSync(r9LedgerPath))('replays the immutable r9 ledger and re-screens its three real candidates under schema v2', () => {
    const events = fs.readFileSync(r9LedgerPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CampaignEvent);
    const legacy = SevenHourCampaignTracker.replay(events, settings);
    expect(legacy.snapshot()).toMatchObject({
      readOnly: true,
      integrityError: undefined,
      manifest: { schemaVersion: 1, runId: 'nemesis-instrumentation-2026-07-15-r9' },
    });

    const historical = events
      .filter((event) => event.type === 'candidate_enrolled')
      .map((event) => ({
        at: event.at,
        sequence: event.sequence,
        candidate: event.payload.candidate as unknown as {
          card: ThesisCard;
          initialFill: DryRunOrder;
          economics: { entryCostUsd: number; feePolicy: KalshiFeePolicy };
        },
      }));
    expect(historical).toHaveLength(3);
    expect(legacy.snapshot()).toMatchObject({ candidates: [{}, {}, {}], diagnostics: [{}, {}, {}] });

    const manifest = events[0]!.payload.manifest as { startedAt: number };
    const v2 = SevenHourCampaignTracker.start({
      runId: 'r9-v2-screening-replay',
      evidenceNamespace: 'r9-v2-screening-replay',
      configurationHash: 'r9-v2-screening',
      gitCommit: 'acceptance-test',
      stage: 'instrumentation',
      startedAt: manifest.startedAt,
      settings,
      productionArtifactHash,
      soakVerificationReceiptHash,
    });
    for (const item of historical) {
      const source = item.candidate;
      const normalizedFill: DryRunOrder = {
        ...source.initialFill,
        fillPrice: Number(source.initialFill.fillPrice.toFixed(4)),
        filled: Number(source.initialFill.filled.toFixed(2)),
        contracts: Number(source.initialFill.contracts.toFixed(2)),
      };
      const decision = qualifyCampaignEnrollment({
        card: source.card,
        fill: normalizedFill,
        bookTimestamp: item.at,
        bookSequence: item.sequence,
        feePolicy: source.economics.feePolicy,
        observedAt: item.at,
        maxSafeContracts: normalizedFill.contracts,
        entryRiskUsd: source.economics.entryCostUsd,
        settings,
      });
      expect(decision).toMatchObject({
        status: 'screened_out',
        reasonCode: 'target_reward_below_minimum',
      });
      if (decision.status === 'screened_out') {
        v2.recordScreenedOut({ card: source.card, decision, completedAt: item.at });
      }
    }
    const v2Snapshot = v2.snapshot();
    expect(v2Snapshot.candidates).toEqual([]);
    expect(v2Snapshot.diagnostics).toEqual([]);
    // Three historical enrollments collapse to unique economic identities
    // (ticker|side|playbook|sourceMove) — re-issued card.ids no longer fork rows.
    const screenedOccurrences = v2Snapshot.screenedOut?.reduce((sum, row) => sum + row.occurrences, 0) ?? 0;
    expect(screenedOccurrences).toBe(3);
    expect(v2Snapshot.screenedOut?.length).toBeGreaterThanOrEqual(1);
    expect(v2Snapshot.screenedOut?.length).toBeLessThanOrEqual(3);
    expect(v2Snapshot.screenedOut?.every((screening) => screening.reasonCode === 'target_reward_below_minimum')).toBe(true);
  });

  it('replays the three r9 economic candidates as screened out with no lifecycle or diagnostic', () => {
    const tracker = start('instrumentation');
    const r9 = [
      { ticker: 'KXITFWMATCH-26JUL15MASLAB-MAS', side: 'no' as const, impliedPrice: 0.98, marketPrice: 0.9, grossEdge: 0.08, netEdge: 0.0537, contracts: 11, fillPrice: 0.88, fees: 0.09 },
      { ticker: 'KXITFWMATCH-26JUL15MASLAB-MAS', side: 'no' as const, impliedPrice: 0.9587877538, marketPrice: 0.9, grossEdge: 0.0587877538, netEdge: 0.0324877538, contracts: 11, fillPrice: 0.88, fees: 0.09 },
      { ticker: 'KXWCTOTAL-26JUL15ENGARG-2', side: 'yes' as const, impliedPrice: 0.76, marketPrice: 0.68, grossEdge: 0.08, netEdge: 0.0447, contracts: 14, fillPrice: 0.68, fees: 0.22 },
    ];
    r9.forEach((source, index) => {
      const candidate = card(90 + index, {
        ticker: source.ticker,
        side: source.side,
        impliedPrice: source.impliedPrice,
        marketPrice: source.marketPrice,
        grossEdge: source.grossEdge,
        netEdge: source.netEdge,
      });
      const initialFill: DryRunOrder = {
        ...fill(candidate.ticker),
        side: source.side,
        contracts: source.contracts,
        filled: source.contracts,
        fillPrice: source.fillPrice,
        expectedPrice: source.impliedPrice,
        fees: source.fees,
        netEdge: source.impliedPrice - source.fillPrice - source.fees / source.contracts,
      };
      const decision = qualifyCampaignEnrollment({
        card: candidate,
        fill: initialFill,
        bookTimestamp: startedAt,
        bookSequence: 900 + index,
        feePolicy: buildKalshiFeePolicy({ multiplier: 1, accountPrecision: 'non_direct' }),
        observedAt: startedAt,
        maxSafeContracts: source.contracts,
        entryRiskUsd: source.fillPrice * source.contracts + source.fees,
        settings,
      });
      expect(decision).toMatchObject({ status: 'screened_out', reasonCode: 'target_reward_below_minimum' });
      if (decision.status === 'screened_out') tracker.recordScreenedOut({ card: candidate, decision });
    });
    const snapshot = tracker.snapshot();
    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.diagnostics).toEqual([]);
    // Two share ticker/side (MAS no); third is distinct — 2 identity rows, 3 occurrences.
    expect(snapshot.screenedOut).toHaveLength(2);
    expect(snapshot.screenedOut.reduce((sum, row) => sum + row.occurrences, 0)).toBe(3);
    expect(snapshot.screenedOut.every((row) => row.reasonCode === 'target_reward_below_minimum')).toBe(true);
  });

  it('screens economic failures without enrolling or scheduling diagnostics and deduplicates evidence', () => {
    const tracker = start();
    const candidate = card(1, { impliedPrice: 0.45 });
    const initialFill = fill(candidate.ticker);
    const decision = qualifyCampaignEnrollment({
      card: candidate,
      fill: initialFill,
      bookTimestamp: startedAt,
      bookSequence: 1,
      feePolicy,
      observedAt: startedAt,
      maxSafeContracts: 10,
      entryRiskUsd: 4.17,
      settings,
    });
    expect(decision).toMatchObject({ status: 'screened_out', reasonCode: 'target_reward_below_minimum' });
    if (decision.status !== 'screened_out') throw new Error('expected screened out');
    tracker.recordScreenedOut({ card: candidate, decision });
    tracker.recordScreenedOut({ card: { ...candidate, signalReason: 'changed presentation text' }, decision, completedAt: startedAt + 1 });
    const snapshot = tracker.snapshot();
    expect(snapshot.candidates).toHaveLength(0);
    expect(snapshot.diagnostics).toHaveLength(0);
    expect(snapshot.screenedOut).toMatchObject([{ occurrences: 2, reasonCode: 'target_reward_below_minimum' }]);
    expect(candidateEconomicIdentity(candidate)).toBe(candidateEconomicIdentity({ ...candidate, signalReason: 'totally different' }));
    // Re-issued flow signals get a new card.id; economic identity must stay stable
    // so confirmation and campaign enrollment accumulate rather than reset.
    expect(candidateEconomicIdentity(candidate)).toBe(candidateEconomicIdentity({ ...candidate, id: 'totally-different-signal-id' }));
  });

  it('atomically enrolls one confirming candidate with its first exchange sample and one diagnostic', async () => {
    const tracker = start();
    const candidate = card(2);
    const qualified = screen(candidate);
    await Promise.all(Array.from({ length: 10 }, async () => tracker.enrollQualified({
      card: candidate,
      initialFill: qualified.initialFill,
      screening: qualified.decision,
      completedAt: startedAt,
    })));
    const snapshot = tracker.snapshot();
    expect(snapshot.manifest.schemaVersion).toBe(2);
    expect(snapshot.candidates).toMatchObject([{ lifecycleState: 'confirming', samples: [{ exchangeSequence: 3 }] }]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]).toMatchObject({ attempts: 0, nextAttemptAt: startedAt + 10 });
    expect(snapshot.eventCount).toBe(2);
  });

  it('replays confirmation state and permits exactly one terminal state and one valid diagnostic', () => {
    const tracker = start();
    const candidate = enroll(tracker, card(3));
    tracker.recordSample(candidate.candidateId, {
      ...candidate.samples[0]!,
      at: startedAt + 10,
      observedAt: startedAt + 10,
      bookTimestamp: startedAt + 10,
      bookSequence: 44,
      exchangeTimestamp: startedAt + 10,
      exchangeSequence: 44,
    });
    const restarted = SevenHourCampaignTracker.replay(tracker.allEvents(), settings);
    restarted.terminalize(candidate.candidateId, 'ready', 'confirmed', startedAt + 20);
    restarted.terminalize(candidate.candidateId, 'rejected', 'ignored duplicate', startedAt + 21);
    const diagnostic = restarted.snapshot().diagnostics[0]!;
    restarted.completeDiagnostic({
      diagnosticId: diagnostic.diagnosticId,
      validExecutableObservation: true,
      exchangeTimestamp: startedAt + 20,
      exchangeSequence: 45,
      executableFollowUpMark: 0.5,
      reconstructedExitFill: { ...candidate.initialFill, fillPrice: 0.5 },
      executableNetPnlUsd: 0.8,
      reason: 'valid executable observation',
      completedAt: startedAt + 20,
    });
    restarted.completeDiagnostic({ diagnosticId: diagnostic.diagnosticId, validExecutableObservation: true, reason: 'ignored duplicate', completedAt: startedAt + 21 });
    expect(restarted.snapshot().candidates[0]!.terminalState).toBe('ready');
    expect(restarted.snapshot().diagnostics[0]!.status).toBe('scored');
    expect(restarted.allEvents().filter((event) => event.type === 'candidate_terminal')).toHaveLength(1);
    expect(restarted.allEvents().filter((event) => event.type === 'diagnostic_scored')).toHaveLength(1);
  });

  it('enforces the bounded retry schedule and aggregates typed failures', () => {
    const tracker = start();
    const candidate = enroll(tracker, card(4));
    const diagnostic = tracker.snapshot().diagnostics[0]!;
    for (const offset of DIAGNOSTIC_RETRY_OFFSETS_MS) {
      tracker.recordDiagnosticAttempt({
        diagnosticId: diagnostic.diagnosticId,
        outcome: 'no_delta',
        detail: 'no newer sequenced exchange delta',
        completedAt: diagnostic.dueAt + offset,
      });
    }
    const result = tracker.snapshot().diagnostics[0]!;
    expect(result).toMatchObject({ attempts: 6, status: 'expired' });
    expect(result.attemptSummaries).toMatchObject([{ outcome: 'no_delta', count: 6 }]);
    expect(tracker.dueDiagnostics(diagnostic.dueAt + 301_000)).toHaveLength(0);
    expect(candidate.initialFill.filled).toBe(10);
  });

  it('records every diagnostic failure code and then scores one exact valid delta per diagnostic', () => {
    const tracker = start();
    const outcomes: Exclude<DiagnosticAttemptOutcome, 'valid_observation'>[] = [
      'no_delta',
      'book_fetch_failed',
      'missing_provenance',
      'stale_book',
      'fee_unknown',
      'insufficient_depth',
      'partial_fill',
      'slippage_exceeded',
    ];
    outcomes.forEach((outcome, index) => {
      const candidate = enroll(tracker, card(200 + index));
      const diagnostic = tracker.snapshot().diagnostics.find((item) => item.candidateId === candidate.candidateId)!;
      tracker.recordDiagnosticAttempt({
        diagnosticId: diagnostic.diagnosticId,
        outcome,
        detail: `${outcome} fixture`,
        completedAt: diagnostic.dueAt,
      });
      tracker.completeDiagnostic({
        diagnosticId: diagnostic.diagnosticId,
        validExecutableObservation: true,
        exchangeTimestamp: diagnostic.dueAt + 1,
        exchangeSequence: 5_000 + index,
        executableFollowUpMark: 0.5,
        reconstructedExitFill: { ...candidate.initialFill, fillPrice: 0.5 },
        executableNetPnlUsd: 0.8,
        reason: 'valid exchange delta after typed failure',
        completedAt: diagnostic.dueAt + 1,
      });
    });
    const diagnostics = tracker.snapshot().diagnostics;
    expect(diagnostics).toHaveLength(outcomes.length);
    expect(diagnostics.every((diagnostic) => diagnostic.status === 'scored' && diagnostic.validExecutableObservation)).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.attemptSummaries[0]!.outcome)).toEqual(outcomes);
    expect(tracker.allEvents().filter((event) => event.type === 'diagnostic_scored')).toHaveLength(outcomes.length);
  });

  it('uses completion times for T+1:40 instrumentation enrollment and fixed campaign cutoffs', () => {
    const instrumentationSettings = { ...settings, instrumentationDurationMs: 2 * 60 * 60_000 };
    const tracker = SevenHourCampaignTracker.start({
      runId: 'run-instrumentation-cutoff', evidenceNamespace: 'v2', configurationHash: 'cfg', gitCommit: 'abc',
      stage: 'instrumentation', startedAt, settings: instrumentationSettings,
      productionArtifactHash, soakVerificationReceiptHash,
    });
    expect(tracker.snapshot().manifest.enrollmentCutoffAt).toBe(startedAt + 100 * 60_000);
    const onTimeAt = startedAt + 100 * 60_000;
    const onTime = card(5, { createdAt: onTimeAt, updatedAt: onTimeAt });
    const q1 = screen(onTime, onTimeAt);
    tracker.enrollQualified({ card: onTime, initialFill: q1.initialFill, screening: q1.decision, completedAt: onTimeAt });
    const lateAt = onTimeAt + 1;
    const late = card(6, { createdAt: lateAt, updatedAt: lateAt });
    const q2 = screen(late, lateAt);
    tracker.enrollQualified({ card: late, initialFill: q2.initialFill, screening: q2.decision, completedAt: lateAt });
    expect(tracker.snapshot().candidates).toHaveLength(1);
    tracker.terminalize(tracker.snapshot().candidates[0]!.candidateId, 'ready', 'late completion', tracker.snapshot().manifest.cutoffAt + 1);
    expect(tracker.snapshot().candidates[0]).toMatchObject({ terminalState: 'expired', terminalReason: 'candidate completed after campaign cutoff' });
    tracker.prepareCloseout(tracker.snapshot().manifest.cutoffAt + 2);
    expect(tracker.snapshot().manifest.status).toBe('closeout');
    expect(tracker.allEvents().at(-1)?.type).toBe('run_closeout_ready');
  });

  it('does not count a future-dated exchange timestamp as a fresh confirmation sample', () => {
    const tracker = start();
    const candidate = enroll(tracker, card(500));
    tracker.recordSample(candidate.candidateId, {
      ...candidate.samples[0]!,
      at: startedAt + 10,
      observedAt: startedAt + 10,
      bookTimestamp: startedAt + 11,
      bookSequence: 50_001,
      exchangeTimestamp: startedAt + 11,
      exchangeSequence: 50_001,
    });

    expect(tracker.snapshot().freshConfirmationRate).toBe(0.5);
    expect(tracker.snapshot().reasons).toContain('exchange-book freshness below 95%');
  });

  it('requires exchange-book operational proof to be current at closeout', () => {
    const stale = start();
    const staleCloseoutAt = stale.snapshot().manifest.cutoffAt;
    stale.recordOperationalCheck(
      'exchange_book_time_available',
      true,
      'historical exchange delta',
      staleCloseoutAt - 60_001,
    );
    stale.prepareCloseout(staleCloseoutAt);
    stale.finalize(staleCloseoutAt);
    expect(stale.snapshot().reasons)
      .toContain('current exchange-origin book timestamp and sequence were not proven at closeout');

    const current = start();
    const currentCloseoutAt = current.snapshot().manifest.cutoffAt;
    current.recordOperationalCheck(
      'exchange_book_time_available',
      true,
      'current exchange delta',
      currentCloseoutAt - 60_000,
    );
    current.prepareCloseout(currentCloseoutAt);
    current.finalize(currentCloseoutAt);
    expect(current.snapshot().reasons)
      .not.toContain('current exchange-origin book timestamp and sequence were not proven at closeout');
  });

  it('fails qualification for a supervisor recovery restart namespace', () => {
    const tracker = SevenHourCampaignTracker.start({
      runId: 'run-recovery-1',
      evidenceNamespace: 'run-recovery-1',
      configurationHash: 'cfg-a',
      gitCommit: 'abc123',
      stage: 'instrumentation',
      startedAt,
      settings,
      restartOrdinal: 1,
      productionArtifactHash,
      soakVerificationReceiptHash,
    });

    expect(tracker.snapshot().reasons).toContain('campaign attempt used a supervisor recovery restart');
  });

  it('accepts a completed diagnostic at the five-minute boundary and expires one completed a millisecond late', () => {
    const tracker = start();
    const onTimeCandidate = enroll(tracker, card(501));
    const lateCandidate = enroll(tracker, card(502));
    const onTime = tracker.snapshot().diagnostics.find((item) => item.candidateId === onTimeCandidate.candidateId)!;
    const late = tracker.snapshot().diagnostics.find((item) => item.candidateId === lateCandidate.candidateId)!;
    expect(onTime.expiresAt - onTime.dueAt).toBe(5 * 60_000);

    tracker.completeDiagnostic({
      diagnosticId: onTime.diagnosticId,
      validExecutableObservation: true,
      exchangeTimestamp: onTime.expiresAt,
      exchangeSequence: 90_001,
      executableFollowUpMark: 0.5,
      reconstructedExitFill: { ...onTimeCandidate.initialFill, fillPrice: 0.5 },
      executableNetPnlUsd: 0.8,
      reason: 'completed exactly at fixed observation cutoff',
      completedAt: onTime.expiresAt,
    });
    tracker.completeDiagnostic({
      diagnosticId: late.diagnosticId,
      validExecutableObservation: true,
      exchangeTimestamp: late.expiresAt,
      exchangeSequence: 90_002,
      executableFollowUpMark: 0.5,
      reconstructedExitFill: { ...lateCandidate.initialFill, fillPrice: 0.5 },
      executableNetPnlUsd: 0.8,
      reason: 'completed after fixed observation cutoff',
      completedAt: late.expiresAt + 1,
    });

    expect(tracker.snapshot().diagnostics.find((item) => item.diagnosticId === onTime.diagnosticId))
      .toMatchObject({ status: 'scored', completedAt: onTime.expiresAt });
    expect(tracker.snapshot().diagnostics.find((item) => item.diagnosticId === late.diagnosticId))
      .toMatchObject({
        status: 'expired',
        completedAt: late.expiresAt + 1,
        reason: 'valid observation completed after its fixed cutoff',
      });
  });

  it('replays schema-v1 ledgers for history but refuses every mutation', () => {
    const manifest = {
      schemaVersion: 1 as const, runId: 'r9', evidenceNamespace: 'r9', configurationHash: 'cfg-r9', gitCommit: 'old',
      stage: 'instrumentation' as const, startedAt, enrollmentCutoffAt: startedAt, cutoffAt: startedAt + 1, status: 'failed' as const,
    };
    const body: Omit<CampaignEvent, 'hash'> = {
      schemaVersion: 1, runId: 'r9', configurationHash: 'cfg-r9', sequence: 1, at: startedAt,
      type: 'run_started', payload: { manifest }, previousHash: 'GENESIS',
    };
    const event: CampaignEvent = { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
    const replayed = SevenHourCampaignTracker.replay([event], settings);
    expect(replayed.snapshot()).toMatchObject({ readOnly: true, integrityError: undefined, manifest: { schemaVersion: 1, runId: 'r9' } });
    expect(() => replayed.recordSafetyFailure('must not mutate')).toThrow(/read-only/i);
    expect(replayed.allEvents()).toEqual([event]);
  });

  it('invalidates pending lifecycles before configuration samples can mix', () => {
    const tracker = start();
    const candidate = enroll(tracker, card(7));
    tracker.ensureConfiguration('cfg-b', startedAt + 1);
    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({
      manifest: { status: 'invalidated' },
      candidates: [{ candidateId: candidate.candidateId, terminalState: 'expired' }],
      passed: false,
    });
    expect(snapshot.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('configuration hash changed'),
    ]));
  });
});
