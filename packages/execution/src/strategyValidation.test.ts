import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_QUALIFICATION } from '@nemesis/core';
import { StrategyValidationTracker, type ShadowCandidateEvidence } from './strategyValidation.js';

const day = 24 * 60 * 60_000;
const start = Date.UTC(2026, 6, 13, 16, 0, 0);

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
});
