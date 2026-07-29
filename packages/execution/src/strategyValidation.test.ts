import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_QUALIFICATION } from '@nemesis/core';
import {
  SHADOW_MAX_CONTAMINATED_SHARE,
  StrategyValidationTracker,
  type ShadowCandidateEvidence,
} from './strategyValidation.js';
import { calculateEntryEconomics } from './tradeEconomics.js';

const day = 24 * 60 * 60_000;
const start = Date.UTC(2026, 6, 13, 16, 0, 0);

/** Matches the tracker's own 6-digit rounding for hand-computed expectations. */
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

function candidate(index: number, at: number): ShadowCandidateEvidence {
  return {
    id: `candidate-${index}`,
    sourceSignalId: `source-${index}`,
    ticker: `KXTEST-${index}`,
    side: index % 2 ? 'yes' : 'no',
    playbook: 'flow-hunter',
    startedAt: at,
    dueAt: at + 15 * 60_000,
    contracts: 20,
    entryPrice: 0.4,
    entryFeesUsd: 0.1,
    initialNetEdge: 0.1,
    expectedRewardUsd: 2,
    plannedLossUsd: 1,
    rewardRiskRatio: 2,
    stressedExpectedNetPnlUsd: 1,
  };
}

describe('StrategyValidationTracker', () => {
  it('writes schema-2 raw economics and replays schema-1 ledgers without mutation', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 3, start, 'schema-2');
    const economics = calculateEntryEconomics({
      entryPrice: 0.4,
      entryFeesUsd: 0.34,
      contracts: 20,
      sideFairPrice: 0.55,
      marketPrice: 0.4,
      grossEdge: 0.15,
      screeningNetEdge: 0.11,
      executableEntryNetEdge: 0.13,
      spread: 0.02,
      fillSlippage: 0,
    });
    tracker.recordEntryConfirmation({
      sourceSignalId: 'source-raw',
      ticker: 'KXRAW',
      side: 'yes',
      status: 'pending',
      reason: 'collecting evidence',
      samples: 1,
      windowMs: 0,
      edgeRetention: 1,
      targetRewardUsd: economics.targetRewardUsd,
      plannedLossUsd: economics.plannedLossUsd,
      rewardRiskRatio: economics.rewardRiskRatio,
      stressedNetPnlUsd: economics.stressedNetPnlUsd,
      economics,
      at: start + 1,
    });
    const event = tracker.allEvents()[1];
    expect(event).toMatchObject({
      schemaVersion: 2,
      type: 'entry_confirmation_observed',
      targetRewardUsd: economics.targetRewardUsd,
      expectedRewardUsd: economics.targetRewardUsd,
      economics: {
        entryPrice: 0.4,
        contracts: 20,
        sideFairPrice: 0.55,
        grossEdge: 0.15,
          feeModel: 'kalshi-fixed-point-level-fees-v3',
      },
    });
    expect(StrategyValidationTracker.replay(tracker.allEvents()).integrityFailure()).toBeUndefined();

    const legacy = StrategyValidationTracker.create('shadow', 'legacy-config', 2, start, 'schema-1', 1);
    legacy.pause('archived legacy run', start + 1);
    const replayedLegacy = StrategyValidationTracker.replay(legacy.allEvents());
    expect(replayedLegacy.integrityFailure()).toBeUndefined();
    expect(replayedLegacy.snapshot(DEFAULT_ENTRY_QUALIFICATION)).toMatchObject({
      schemaVersion: 1,
      runId: 'schema-1',
      paused: true,
    });
  });

  it('replays the same shadow totals and passes only after the full stable sample', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'shadow-run');
    for (let index = 0; index < 100; index += 1) {
      const at = start + (index % 3) * day + index * 1_000;
      const row = candidate(index, at);
      tracker.startShadowCandidate(row);
      const win = index < 60;
      tracker.observeShadowCandidate(row.id, win ? 2 : -1, win ? 1 : -0.5, win ? 0.08 : -0.01, at + 1_000);
      tracker.scoreShadowCandidate(row.id, win ? 2 : -1, win ? 1 : -0.5, 'follow-up complete', at + 2_000);
    }
    const snapshot = tracker.snapshot(DEFAULT_ENTRY_QUALIFICATION);
    expect(snapshot).toMatchObject({
      shadowCandidateCount: 100,
      shadowPendingCount: 0,
      shadowWinRate: 0.6,
      shadowProfitFactor: 3,
      shadowNetPnlUsd: 80,
      shadowStressedProfitFactor: 3,
      shadowDistinctDayCount: 3,
      shadowObservationWindowMs: expect.any(Number),
      shadowCountPassed: true,
      shadowQualityPassed: true,
      shadowPassed: true,
    });
    expect(StrategyValidationTracker.replay(tracker.allEvents()).snapshot(DEFAULT_ENTRY_QUALIFICATION)).toEqual(snapshot);
  });

  it('preserves pending candidates across replay and rejects duplicate sources', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start);
    tracker.startShadowCandidate(candidate(1, start));
    const replay = StrategyValidationTracker.replay(tracker.allEvents());
    expect(replay.pendingCandidates()).toHaveLength(1);
    expect(replay.hasUsedSource('source-1')).toBe(true);
    expect(() => replay.startShadowCandidate({ ...candidate(2, start), sourceSignalId: 'source-1' })).toThrow(/already used/i);
  });

  it('fails replay closed when the append-only hash chain is changed', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start);
    tracker.startShadowCandidate(candidate(1, start));
    const events = tracker.allEvents();
    const tampered = events.map((event) => ({ ...event })) as typeof events;
    tampered[1] = { ...tampered[1], at: tampered[1].at + 1_000 } as typeof tampered[number];
    const replay = StrategyValidationTracker.replay(tampered);
    expect(replay.integrityFailure()).toMatch(/hash chain/i);
    expect(replay.snapshot(DEFAULT_ENTRY_QUALIFICATION).shadowPassed).toBe(false);
  });

  it('allows only confirmed forward stage transitions and makes a pause ineligible', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start);
    expect(() => tracker.changeStage('pilot', 'wrong')).toThrow(/confirmation/i);
    tracker.changeStage('pilot', 'ADVANCE_TO_PILOT');
    tracker.changeStage('qualification', 'ADVANCE_TO_QUALIFICATION');
    expect(tracker.snapshot(DEFAULT_ENTRY_QUALIFICATION).stage).toBe('qualification');
    expect(() => tracker.changeStage('pilot', 'ADVANCE_TO_PILOT')).toThrow(/cannot advance/i);
    tracker.pause('settings changed');
    expect(tracker.snapshot(DEFAULT_ENTRY_QUALIFICATION)).toMatchObject({ paused: true, shadowPassed: false });
  });

  it('requires 50 scored shadows across the minimum observation window before count passes', () => {
    const acceptance = {
      ...DEFAULT_ENTRY_QUALIFICATION,
      shadowMinScored: 50,
      shadowMinDistinctDays: 1,
      shadowMinObservationMs: 24 * 60 * 60_000,
    };
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'count-run');
    for (let index = 0; index < 49; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      tracker.startShadowCandidate(row);
      // Mostly losers: count clears, quality does not.
      const win = index < 2;
      tracker.scoreShadowCandidate(row.id, win ? 2 : -1, win ? 1 : -0.5, 'follow-up complete', at + 2_000);
    }
    expect(tracker.snapshot(acceptance).shadowCountPassed).toBe(false);

    const earlyRow = candidate(49, start + 50_000);
    tracker.startShadowCandidate(earlyRow);
    tracker.scoreShadowCandidate(earlyRow.id, -1, -0.5, 'follow-up complete', start + 52_000);
    expect(tracker.snapshot(acceptance)).toMatchObject({
      shadowCandidateCount: 50,
      shadowCountPassed: false,
    });

    const finalAt = start + 24 * 60 * 60_000;
    const finalRow = candidate(50, finalAt);
    tracker.startShadowCandidate(finalRow);
    tracker.scoreShadowCandidate(finalRow.id, -1, -0.5, 'follow-up complete', finalAt + 2_000);

    const snapshot = tracker.snapshot(acceptance);
    expect(snapshot.shadowCandidateCount).toBe(51);
    expect(snapshot.shadowObservationWindowMs).toBeGreaterThanOrEqual(24 * 60 * 60_000);
    expect(snapshot.shadowMinObservationMs).toBe(24 * 60 * 60_000);
    expect(snapshot.shadowCountPassed).toBe(true);
    expect(snapshot.shadowQualityPassed).toBe(false);
    expect(snapshot.shadowPassed).toBe(false);
    expect(snapshot.shadowNetPnlUsd).toBeLessThan(0);
  });
});

describe('StrategyValidationTracker data-plane contamination', () => {
  const openBars = {
    ...DEFAULT_ENTRY_QUALIFICATION,
    shadowMinScored: 1,
    shadowMinDistinctDays: 1,
    shadowMinObservationMs: 0,
  };

  /** Every field the acceptance gate is allowed to read. */
  const gateInputs = (snapshot: ReturnType<StrategyValidationTracker['snapshot']>) => ({
    shadowCandidateCount: snapshot.shadowCandidateCount,
    shadowWinRate: snapshot.shadowWinRate,
    shadowGrossProfitUsd: snapshot.shadowGrossProfitUsd,
    shadowGrossLossUsd: snapshot.shadowGrossLossUsd,
    shadowProfitFactor: snapshot.shadowProfitFactor,
    shadowNetPnlUsd: snapshot.shadowNetPnlUsd,
    shadowStressedNetPnlUsd: snapshot.shadowStressedNetPnlUsd,
    shadowStressedProfitFactor: snapshot.shadowStressedProfitFactor,
    shadowLargestWinShare: snapshot.shadowLargestWinShare,
    shadowDistinctDayCount: snapshot.shadowDistinctDayCount,
    shadowObservationWindowMs: snapshot.shadowObservationWindowMs,
    shadowCountPassed: snapshot.shadowCountPassed,
    shadowQualityPassed: snapshot.shadowQualityPassed,
    shadowPassed: snapshot.shadowPassed,
  });

  it('leaves a clean shadow population identical and reports zero contamination', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'clean-run');
    for (let index = 0; index < 4; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      tracker.startShadowCandidate(row);
      const win = index < 3;
      tracker.scoreShadowCandidate(row.id, win ? 2 : -1, win ? 1 : -0.5, 'follow-up complete', at + 2_000);
    }

    const snapshot = tracker.snapshot(openBars);
    expect(snapshot).toMatchObject({
      shadowCandidateCount: 4,
      shadowContaminatedCount: 0,
      shadowContaminatedNetPnlUsd: 0,
      shadowContaminatedShare: 0,
      shadowContaminationBlocked: false,
      shadowWinRate: 0.75,
      shadowGrossProfitUsd: 6,
      shadowGrossLossUsd: 1,
      shadowProfitFactor: 6,
      shadowNetPnlUsd: 5,
      shadowStressedNetPnlUsd: 2.5,
      shadowObservationWindowMs: 3_000,
    });
    // No clean event carries the new key at all, so the wire shape is unchanged.
    expect(JSON.stringify(tracker.allEvents())).not.toContain('dataPlaneDegraded');
  });

  it('excludes a shadow entered while the data plane was degraded but still records it', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'start-degraded');
    const clean = candidate(1, start);
    tracker.startShadowCandidate(clean);
    tracker.scoreShadowCandidate(clean.id, 2, 1, 'follow-up complete', start + 2_000);

    const dirty = candidate(2, start + 10_000);
    tracker.startShadowCandidate({ ...dirty, dataPlaneDegraded: true });
    tracker.scoreShadowCandidate(dirty.id, -9, -9, 'follow-up complete', start + 12_000);

    const snapshot = tracker.snapshot(openBars);
    // Recorded in the ledger...
    expect(tracker.allEvents().filter((event) => event.type === 'shadow_candidate_scored')).toHaveLength(2);
    // ...and excluded from every tally.
    expect(snapshot).toMatchObject({
      shadowCandidateCount: 1,
      shadowContaminatedCount: 1,
      shadowContaminatedNetPnlUsd: -9,
      shadowWinRate: 1,
      shadowProfitFactor: Number.POSITIVE_INFINITY,
      shadowNetPnlUsd: 2,
      shadowStressedNetPnlUsd: 1,
      shadowObservationWindowMs: 0,
    });
    expect(StrategyValidationTracker.replay(tracker.allEvents()).snapshot(openBars)).toEqual(snapshot);
  });

  it('excludes a shadow scored while the data plane was degraded even when its entry was clean', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'score-degraded');
    const clean = candidate(1, start);
    tracker.startShadowCandidate(clean);
    tracker.scoreShadowCandidate(clean.id, 2, 1, 'follow-up complete', start + 2_000);

    const dirty = candidate(2, start + 10_000);
    tracker.startShadowCandidate(dirty);
    tracker.scoreShadowCandidate(dirty.id, 40, 40, 'follow-up complete', start + 12_000, true);

    const snapshot = tracker.snapshot(openBars);
    expect(snapshot).toMatchObject({
      shadowCandidateCount: 1,
      shadowContaminatedCount: 1,
      shadowContaminatedNetPnlUsd: 40,
      shadowGrossProfitUsd: 2,
      shadowNetPnlUsd: 2,
      shadowLargestWinShare: 1,
    });
    expect(StrategyValidationTracker.replay(tracker.allEvents()).snapshot(openBars)).toEqual(snapshot);
  });

  it('computes every clean tally over the clean subset only in a mixed population', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'mixed-run');
    const score = (
      index: number,
      offsetMs: number,
      net: number,
      stressedNet: number,
      degraded?: { start?: boolean; score?: boolean },
    ) => {
      const at = start + offsetMs;
      const row = candidate(index, at);
      tracker.startShadowCandidate(degraded?.start ? { ...row, dataPlaneDegraded: true } : row);
      tracker.scoreShadowCandidate(row.id, net, stressedNet, 'follow-up complete', at + 1_000, degraded?.score === true);
    };

    score(1, 0, 2, 1);
    score(2, 60_000, 2, 1);
    score(3, 120_000, -1, -0.5);
    score(4, 180_000, 10, 10, { start: true });
    score(5, 240_000, -20, -20, { score: true });
    score(6, 300_000, 7, 7, { start: true, score: true });

    const snapshot = tracker.snapshot(openBars);
    // Clean rows are [+2, +2, -1] / stressed [+1, +1, -0.5], scored at t+1s, t+61s, t+121s.
    expect(snapshot).toMatchObject({
      shadowCandidateCount: 3,
      shadowWinRate: round6(2 / 3),
      shadowGrossProfitUsd: 4,
      shadowGrossLossUsd: 1,
      shadowProfitFactor: 4,
      shadowNetPnlUsd: 3,
      shadowStressedNetPnlUsd: 1.5,
      shadowStressedProfitFactor: 4,
      shadowLargestWinShare: 0.5,
      shadowDistinctDayCount: 1,
      shadowObservationWindowMs: 120_000,
      shadowContaminatedCount: 3,
      shadowContaminatedNetPnlUsd: -3,
    });
    expect(StrategyValidationTracker.replay(tracker.allEvents()).snapshot(openBars)).toEqual(snapshot);
  });

  it('fails a gate that would only pass by counting contaminated shadows', () => {
    const acceptance = {
      ...DEFAULT_ENTRY_QUALIFICATION,
      shadowMinScored: 10,
      shadowMinDistinctDays: 1,
      shadowMinObservationMs: 0,
    };
    const build = (degradedIndexes: Set<number>) => {
      const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, `gate-${degradedIndexes.size}`);
      for (let index = 0; index < 10; index += 1) {
        const at = start + index * 1_000;
        const row = candidate(index, at);
        tracker.startShadowCandidate(degradedIndexes.has(index) ? { ...row, dataPlaneDegraded: true } : row);
        tracker.scoreShadowCandidate(row.id, 1, 1, 'follow-up complete', at + 500);
      }
      return tracker;
    };

    // Ten equal winners: count, win rate, PF, net and concentration all clear.
    const full = build(new Set()).snapshot(acceptance);
    expect(full.shadowCandidateCount).toBe(10);
    expect(full.shadowLargestWinShare).toBe(0.1);
    expect(full.shadowContaminatedShare).toBe(0);
    expect(full.shadowPassed).toBe(true);

    // The same rows, two of them contaminated: quality still clears on the
    // clean subset, but the required scored count no longer does. Contamination
    // sits exactly on the validity bound, so the failure is the count bar
    // itself and not the bound.
    const gated = build(new Set([3, 7])).snapshot(acceptance);
    expect(gated.shadowCandidateCount).toBe(8);
    expect(gated.shadowContaminatedCount).toBe(2);
    expect(gated.shadowContaminatedShare).toBe(0.2);
    expect(gated.shadowContaminationBlocked).toBe(false);
    expect(gated.shadowQualityPassed).toBe(true);
    expect(gated.shadowCountPassed).toBe(false);
    expect(gated.shadowPassed).toBe(false);
  });

  it('replays a historical ledger with no dataPlaneDegraded fields exactly as before', () => {
    // A ledger written before the flag existed: no shadow event carries the key.
    const historical = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'historical');
    for (let index = 0; index < 5; index += 1) {
      const at = start + index * day;
      const row = candidate(index, at);
      historical.startShadowCandidate(row);
      historical.observeShadowCandidate(row.id, 2, 1, 0.08, at + 1_000);
      historical.scoreShadowCandidate(row.id, index < 4 ? 2 : -1, index < 4 ? 1 : -0.5, 'follow-up complete', at + 2_000);
    }
    // Simulate the disk round-trip the real ledger performs.
    const onDisk = JSON.parse(JSON.stringify(historical.allEvents()));
    expect(JSON.stringify(onDisk)).not.toContain('dataPlaneDegraded');

    const replayed = StrategyValidationTracker.replay(onDisk);
    expect(replayed.integrityFailure()).toBeUndefined();
    expect(replayed.snapshot(DEFAULT_ENTRY_QUALIFICATION)).toEqual(historical.snapshot(DEFAULT_ENTRY_QUALIFICATION));
    expect(replayed.snapshot(DEFAULT_ENTRY_QUALIFICATION)).toMatchObject({
      shadowCandidateCount: 5,
      shadowContaminatedCount: 0,
      shadowContaminatedNetPnlUsd: 0,
      // A ledger with no flags is wholly clean, so the validity bound is inert.
      shadowContaminatedShare: 0,
      shadowContaminationBlocked: false,
      shadowNetPnlUsd: 7,
      shadowDistinctDayCount: 5,
    });

    // Absent must be byte-identical to an explicit false, hashes included.
    const explicitFalse = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'historical');
    for (let index = 0; index < 5; index += 1) {
      const at = start + index * day;
      const row = candidate(index, at);
      explicitFalse.startShadowCandidate({ ...row, dataPlaneDegraded: false });
      explicitFalse.observeShadowCandidate(row.id, 2, 1, 0.08, at + 1_000);
      explicitFalse.scoreShadowCandidate(row.id, index < 4 ? 2 : -1, index < 4 ? 1 : -0.5, 'follow-up complete', at + 2_000, false);
    }
    expect(explicitFalse.allEvents()).toEqual(historical.allEvents());
  });

  it('reports contaminated net P&L without leaking it into any gate input', () => {
    const withContamination = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'leak-a');
    const cleanOnly = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'leak-a');
    for (const tracker of [withContamination, cleanOnly]) {
      for (let index = 0; index < 8; index += 1) {
        const at = start + index * 1_000;
        const row = candidate(index, at);
        tracker.startShadowCandidate(row);
        tracker.scoreShadowCandidate(row.id, index < 6 ? 2 : -1, index < 6 ? 1 : -0.5, 'follow-up complete', at + 500);
      }
    }
    // Only the first tracker also carries a contaminated population, sized to
    // sit on the validity bound so the bound itself cannot explain any
    // difference below. Their P&L is enormous and wildly profitable.
    for (let index = 10; index < 12; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      withContamination.startShadowCandidate({ ...row, dataPlaneDegraded: true });
      withContamination.scoreShadowCandidate(row.id, 250, 250, 'follow-up complete', at + 500);
    }

    const dirty = withContamination.snapshot(openBars);
    const clean = cleanOnly.snapshot(openBars);
    expect(dirty.shadowContaminatedCount).toBe(2);
    expect(dirty.shadowContaminatedNetPnlUsd).toBe(500);
    expect(dirty.shadowContaminatedShare).toBe(0.2);
    expect(dirty.shadowContaminationBlocked).toBe(false);
    expect(clean.shadowContaminatedNetPnlUsd).toBe(0);
    // Every gate input is identical to the ledger that never saw those rows:
    // the excluded economics reach nothing the gate reads.
    expect(gateInputs(dirty)).toEqual(gateInputs(clean));
  });

  it('keeps the hash chain verifiable with the new fields present and inside the hash', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'hash-run');
    const first = candidate(1, start);
    tracker.startShadowCandidate({ ...first, dataPlaneDegraded: true });
    tracker.scoreShadowCandidate(first.id, 3, 2, 'follow-up complete', start + 2_000, true);
    const second = candidate(2, start + 10_000);
    tracker.startShadowCandidate(second);
    tracker.scoreShadowCandidate(second.id, 1, 1, 'follow-up complete', start + 12_000);

    const events = tracker.allEvents();
    expect(JSON.stringify(events)).toContain('dataPlaneDegraded');
    expect(StrategyValidationTracker.replay(events).integrityFailure()).toBeUndefined();

    // Clearing the flag on a scored event must break the chain — proof the flag
    // is covered by the hash and cannot be edited out of a ledger after the fact.
    const tampered = events.map((event) => ({ ...event })) as typeof events;
    const scoredIndex = tampered.findIndex((event) => event.type === 'shadow_candidate_scored');
    const { dataPlaneDegraded: _dropped, ...withoutFlag } = tampered[scoredIndex] as Extract<
      typeof tampered[number],
      { type: 'shadow_candidate_scored' }
    >;
    tampered[scoredIndex] = withoutFlag as typeof tampered[number];
    expect(StrategyValidationTracker.replay(tampered).integrityFailure()).toMatch(/hash chain/i);
  });

  it('computes the contaminated share, reporting zero rather than NaN before anything is scored', () => {
    const empty = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'share-empty');
    const emptySnapshot = empty.snapshot(openBars);
    expect(emptySnapshot.shadowContaminatedShare).toBe(0);
    expect(Number.isNaN(emptySnapshot.shadowContaminatedShare)).toBe(false);
    expect(emptySnapshot.shadowContaminationBlocked).toBe(false);

    // A started-but-unscored candidate is still not a scored row.
    const started = candidate(99, start);
    empty.startShadowCandidate({ ...started, dataPlaneDegraded: true });
    expect(empty.snapshot(openBars).shadowContaminatedShare).toBe(0);

    // One contaminated of four scored.
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'share-quarter');
    for (let index = 0; index < 4; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      tracker.startShadowCandidate(index === 2 ? { ...row, dataPlaneDegraded: true } : row);
      tracker.scoreShadowCandidate(row.id, 1, 1, 'follow-up complete', at + 500);
    }
    expect(tracker.snapshot(openBars)).toMatchObject({
      shadowCandidateCount: 3,
      shadowContaminatedCount: 1,
      shadowContaminatedShare: 0.25,
    });

    // One contaminated of three scored — a repeating fraction stays finite.
    const thirds = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'share-thirds');
    for (let index = 0; index < 3; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      thirds.startShadowCandidate(index === 0 ? { ...row, dataPlaneDegraded: true } : row);
      thirds.scoreShadowCandidate(row.id, 1, 1, 'follow-up complete', at + 500);
    }
    expect(thirds.snapshot(openBars).shadowContaminatedShare).toBe(round6(1 / 3));
  });

  it('passes exactly at the contamination bound and blocks one row over it', () => {
    const acceptance = {
      ...DEFAULT_ENTRY_QUALIFICATION,
      shadowMinScored: 8,
      shadowMinDistinctDays: 1,
      shadowMinObservationMs: 0,
    };
    // Eight clean equal winners in both ledgers, so the clean subset — and
    // therefore every quality bar and the count bar — is held constant. Only
    // the size of the excluded population changes.
    const build = (contaminatedRows: number) => {
      const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, `bound-${contaminatedRows}`);
      for (let index = 0; index < 8; index += 1) {
        const at = start + index * 1_000;
        const row = candidate(index, at);
        tracker.startShadowCandidate(row);
        tracker.scoreShadowCandidate(row.id, 1, 1, 'follow-up complete', at + 500);
      }
      for (let index = 0; index < contaminatedRows; index += 1) {
        const at = start + (20 + index) * 1_000;
        const row = candidate(20 + index, at);
        tracker.startShadowCandidate({ ...row, dataPlaneDegraded: true });
        tracker.scoreShadowCandidate(row.id, -5, -5, 'follow-up complete', at + 500);
      }
      return tracker.snapshot(acceptance);
    };

    // 2 / 10 === 0.2 — exactly at the bound, which is a `>` comparison.
    const atBound = build(2);
    expect(atBound.shadowContaminatedShare).toBe(SHADOW_MAX_CONTAMINATED_SHARE);
    expect(atBound.shadowContaminationBlocked).toBe(false);
    expect(atBound.shadowCandidateCount).toBe(8);
    expect(atBound.shadowCountPassed).toBe(true);
    expect(atBound.shadowPassed).toBe(true);

    // 3 / 11 === 0.2727… — one row over, same eight clean winners.
    const overBound = build(3);
    expect(overBound.shadowContaminatedShare).toBeGreaterThan(SHADOW_MAX_CONTAMINATED_SHARE);
    expect(overBound.shadowContaminationBlocked).toBe(true);
    expect(overBound.shadowCandidateCount).toBe(8);
    expect(overBound.shadowPassed).toBe(false);
  });

  it('holds the gate closed on an over-contaminated sample while still reporting the clean subset truthfully', () => {
    const acceptance = {
      ...DEFAULT_ENTRY_QUALIFICATION,
      shadowMinScored: 8,
      shadowMinDistinctDays: 1,
      shadowMinObservationMs: 0,
    };
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 2, start, 'blocked-run');
    // Eight clean winners: on their own this is a passing sample.
    for (let index = 0; index < 8; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      tracker.startShadowCandidate(row);
      tracker.scoreShadowCandidate(row.id, 1, 1, 'follow-up complete', at + 500);
    }
    // Six loss-heavy degraded rows — the systematic bias the bound exists for.
    for (let index = 20; index < 26; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      tracker.startShadowCandidate({ ...row, dataPlaneDegraded: true });
      tracker.scoreShadowCandidate(row.id, -12, -12, 'follow-up complete', at + 500, true);
    }

    const snapshot = tracker.snapshot(acceptance);
    expect(snapshot.shadowContaminatedCount).toBe(6);
    expect(snapshot.shadowContaminatedNetPnlUsd).toBe(-72);
    expect(snapshot.shadowContaminatedShare).toBe(round6(6 / 14));
    expect(snapshot.shadowContaminationBlocked).toBe(true);
    // The sample is not a valid test, so the count bar carries the failure...
    expect(snapshot.shadowCountPassed).toBe(false);
    expect(snapshot.shadowPassed).toBe(false);
    // ...while quality keeps telling the operator what the clean rows say.
    expect(snapshot.shadowQualityPassed).toBe(true);
    expect(snapshot.shadowCandidateCount).toBe(8);
    expect(snapshot.shadowNetPnlUsd).toBe(8);
    expect(StrategyValidationTracker.replay(tracker.allEvents()).snapshot(acceptance)).toEqual(snapshot);
  });
});

describe('StrategyValidationTracker shadow abandonment', () => {
  const acceptance = { ...DEFAULT_ENTRY_QUALIFICATION, shadowMinScored: 1, shadowMinDistinctDays: 1 };

  it('abandons a candidate whose market closed, and it counts nowhere', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 3, start);
    const row = candidate(0, start);
    tracker.startShadowCandidate(row);

    tracker.abandonShadowCandidate(row.id, 'shadow abandoned: no executable book before extended deadline', start + 60_000);

    const snapshot = tracker.snapshot(acceptance);
    expect(snapshot.shadowAbandonedCount).toBe(1);
    expect(snapshot.shadowPendingCount).toBe(0);
    expect(snapshot.shadowCandidateCount).toBe(0);
    expect(snapshot.shadowContaminatedCount).toBe(0);
    expect(snapshot.shadowNetPnlUsd).toBe(0);
    expect(snapshot.shadowWinRate).toBe(0);
  });

  it('an abandoned candidate cannot also be scored', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 3, start);
    const row = candidate(0, start);
    tracker.startShadowCandidate(row);
    tracker.abandonShadowCandidate(row.id, 'shadow abandoned: no executable book before extended deadline', start + 60_000);

    expect(() => tracker.scoreShadowCandidate(row.id, 1, 1, 'follow-up complete', start + 90_000))
      .toThrow('shadow candidate is not pending');
  });

  it('cannot abandon a candidate twice, or one already scored', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 3, start);
    const scored = candidate(0, start);
    const abandoned = candidate(1, start);
    tracker.startShadowCandidate(scored);
    tracker.startShadowCandidate(abandoned);
    tracker.scoreShadowCandidate(scored.id, 1, 1, 'follow-up complete', start + 500);
    tracker.abandonShadowCandidate(abandoned.id, 'shadow abandoned: no executable book before extended deadline', start + 500);

    expect(() => tracker.abandonShadowCandidate(scored.id, 'late', start + 1_000))
      .toThrow('shadow candidate is not pending');
    expect(() => tracker.abandonShadowCandidate(abandoned.id, 'twice', start + 1_000))
      .toThrow('shadow candidate is not pending');
  });

  it('mixed ledger: abandoned rows are invisible to every acceptance tally, only the count reports them', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 3, start);
    for (let index = 0; index < 3; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      tracker.startShadowCandidate(row);
      tracker.scoreShadowCandidate(row.id, 2, 1, 'follow-up complete', at + 500);
    }
    for (let index = 10; index < 18; index += 1) {
      const at = start + index * 1_000;
      const row = candidate(index, at);
      tracker.startShadowCandidate(row);
      tracker.abandonShadowCandidate(row.id, 'shadow abandoned: no executable book before extended deadline', at + 500);
    }

    const snapshot = tracker.snapshot(acceptance);
    expect(snapshot.shadowAbandonedCount).toBe(8);
    expect(snapshot.shadowCandidateCount).toBe(3);
    expect(snapshot.shadowContaminatedCount).toBe(0);
    expect(snapshot.shadowNetPnlUsd).toBe(6);
    expect(snapshot.shadowWinRate).toBe(1);
    // Not counted toward contamination share either -- abandonment is a
    // different kind of exclusion (no evidence) from contamination (bad
    // evidence), and must not inflate the denominator that bound reads.
    expect(snapshot.shadowContaminatedShare).toBe(0);
    expect(snapshot.shadowContaminationBlocked).toBe(false);
  });

  it('replays identically, including the abandoned count', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 3, start);
    const row = candidate(0, start);
    tracker.startShadowCandidate(row);
    tracker.abandonShadowCandidate(row.id, 'shadow abandoned: no executable book before extended deadline', start + 60_000);

    const replayed = StrategyValidationTracker.replay(tracker.allEvents());
    expect(replayed.snapshot(acceptance)).toEqual(tracker.snapshot(acceptance));
  });

  it('a pre-existing ledger with no abandonments reports zero, not undefined', () => {
    const tracker = StrategyValidationTracker.create('shadow', 'config-a', 3, start);
    const row = candidate(0, start);
    tracker.startShadowCandidate(row);
    tracker.scoreShadowCandidate(row.id, 1, 1, 'follow-up complete', start + 500);

    expect(tracker.snapshot(acceptance).shadowAbandonedCount).toBe(0);
  });
});
