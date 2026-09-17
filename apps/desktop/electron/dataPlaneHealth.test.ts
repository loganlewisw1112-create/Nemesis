import {
  computeCandidateSequencedBookHealth,
  DataPlaneDegradationLatch,
  DEFAULT_DEGRADE_AFTER_MS,
  DEFAULT_RECOVER_AFTER_MS,
  DEFAULT_SEQUENCED_BOOK_THRESHOLD_MS,
  type CandidateBookSample,
  type CandidateSequencedBookHealth,
  type DataPlaneObservation,
} from './dataPlaneHealth.js';
import { describe, expect, it } from 'vitest';

const sample = (
  ticker: string,
  state: CandidateBookSample['state'],
  sequencedAgeMs: number | null,
): CandidateBookSample => ({ ticker, state, sequencedAgeMs });

/** A candidate set where `sequencedWithin` of `count` candidates have a fresh sequenced book. */
const health = (count: number, sequencedWithin: number): CandidateSequencedBookHealth =>
  computeCandidateSequencedBookHealth(
    Array.from({ length: count }, (_, index) =>
      index < sequencedWithin
        ? sample(`T-${index}`, 'sequenced', 1_000)
        : sample(`T-${index}`, 'snapshot-quarantined', null),
    ),
  );

const observation = (
  at: number,
  candidates: CandidateSequencedBookHealth,
  streamSequencedAgeMs: number | null,
): DataPlaneObservation => ({ at, health: candidates, streamSequencedAgeMs });

/** Healthy: candidates hold fresh sequenced books and the stream is delivering deltas. */
const healthyAt = (at: number): DataPlaneObservation => observation(at, health(3, 3), 2_000);
/** The 2026-07-26 shape: candidates still in flight, socket dead, no sequenced book anywhere. */
const deadAt = (at: number): DataPlaneObservation => observation(at, health(3, 0), null);

describe('computeCandidateSequencedBookHealth', () => {
  it('reports no evidence rather than perfect health for an empty candidate set', () => {
    expect(computeCandidateSequencedBookHealth([])).toEqual({
      candidateCount: 0,
      sequencedWithinCount: 0,
      fractionSequencedWithin: 0,
      maxSequencedAgeMs: null,
      minSequencedAgeMs: null,
      thresholdMs: DEFAULT_SEQUENCED_BOOK_THRESHOLD_MS,
    });
  });

  it('counts only sequenced states with a non-null age inside the threshold', () => {
    const result = computeCandidateSequencedBookHealth([
      sample('A', 'sequenced', 5_000),
      sample('B', 'sequenced', 45_000),
      sample('C', 'snapshot-quarantined', 8_000),
      sample('D', 'subscribed-awaiting-snapshot', null),
      sample('E', 'tracked-no-provenance', null),
      sample('F', 'untracked', null),
      sample('G', 'sequenced', null),
    ]);
    expect(result.candidateCount).toBe(7);
    expect(result.sequencedWithinCount).toBe(1);
    expect(result.fractionSequencedWithin).toBeCloseTo(1 / 7);
    expect(result.minSequencedAgeMs).toBe(5_000);
    expect(result.maxSequencedAgeMs).toBe(45_000);
  });

  it('leaves both age extremes null when no sample carries an age', () => {
    const result = computeCandidateSequencedBookHealth([
      sample('A', 'untracked', null),
      sample('B', 'subscribed-awaiting-snapshot', null),
    ]);
    expect(result.candidateCount).toBe(2);
    expect(result.maxSequencedAgeMs).toBeNull();
    expect(result.minSequencedAgeMs).toBeNull();
    expect(result.fractionSequencedWithin).toBe(0);
  });

  it('treats exactly thresholdMs as within, and one millisecond past it as stale', () => {
    const atBoundary = computeCandidateSequencedBookHealth([sample('A', 'sequenced', 30_000)]);
    expect(atBoundary.sequencedWithinCount).toBe(1);
    expect(atBoundary.fractionSequencedWithin).toBe(1);

    const pastBoundary = computeCandidateSequencedBookHealth([sample('A', 'sequenced', 30_001)]);
    expect(pastBoundary.sequencedWithinCount).toBe(0);
    expect(pastBoundary.fractionSequencedWithin).toBe(0);
  });

  it('honours a custom threshold', () => {
    const samples = [sample('A', 'sequenced', 8_000)];
    expect(computeCandidateSequencedBookHealth(samples, { thresholdMs: 5_000 }).sequencedWithinCount).toBe(0);
    expect(computeCandidateSequencedBookHealth(samples, { thresholdMs: 5_000 }).thresholdMs).toBe(5_000);
    expect(computeCandidateSequencedBookHealth(samples, { thresholdMs: 10_000 }).sequencedWithinCount).toBe(1);
  });

  it('de-duplicates a ticker present in both the in-flight and campaign-critical lists, keeping the freshest', () => {
    const result = computeCandidateSequencedBookHealth([
      sample('A', 'sequenced', 90_000),
      sample('A', 'sequenced', 4_000),
      sample('B', 'snapshot-quarantined', null),
      sample('B', 'sequenced', 6_000),
    ]);
    expect(result.candidateCount).toBe(2);
    expect(result.sequencedWithinCount).toBe(2);
    expect(result.fractionSequencedWithin).toBe(1);
    expect(result.maxSequencedAgeMs).toBe(6_000);
    expect(result.minSequencedAgeMs).toBe(4_000);
  });

  it('keeps the first sample when every duplicate lacks an age', () => {
    const result = computeCandidateSequencedBookHealth([
      sample('A', 'tracked-no-provenance', null),
      sample('A', 'untracked', null),
    ]);
    expect(result.candidateCount).toBe(1);
    expect(result.maxSequencedAgeMs).toBeNull();
  });
});

describe('DataPlaneDegradationLatch unhealthy predicate', () => {
  it('reports the candidate clause when both clauses fire', () => {
    const latch = new DataPlaneDegradationLatch();
    expect(latch.observe(deadAt(0)).unhealthyReason).toBe('no-candidate-sequenced-book');
  });

  it('reports the stream clause when candidates are fine but the stream is stale', () => {
    const latch = new DataPlaneDegradationLatch();
    const result = latch.observe(observation(0, health(2, 2), 45_000));
    expect(result.unhealthyReason).toBe('stream-sequenced-delta-stale');
  });

  it('is healthy only when a candidate holds a fresh book and the stream is delivering', () => {
    const latch = new DataPlaneDegradationLatch();
    expect(latch.observe(observation(0, health(4, 1), 10_000)).unhealthyReason).toBeNull();
  });

  it('treats a stream age of exactly thresholdMs as fresh', () => {
    const latch = new DataPlaneDegradationLatch();
    expect(latch.observe(observation(0, health(1, 1), 30_000)).unhealthyReason).toBeNull();
    expect(latch.observe(observation(1_000, health(1, 1), 30_001)).unhealthyReason).toBe('stream-sequenced-delta-stale');
  });
});

describe('DataPlaneDegradationLatch latch-on', () => {
  it('can never latch on the first observation, however unhealthy it is', () => {
    const latch = new DataPlaneDegradationLatch();
    const first = latch.observe(deadAt(10_000_000));
    expect(first.degraded).toBe(false);
    expect(first.changed).toBe(false);
    expect(first.consecutiveUnhealthyMs).toBe(0);
    expect(latch.degraded).toBe(false);
  });

  it('requires the full degrade window and does not latch one observation early', () => {
    const latch = new DataPlaneDegradationLatch();
    let last = latch.observe(deadAt(0));
    for (let at = 30_000; at < DEFAULT_DEGRADE_AFTER_MS; at += 30_000) {
      last = latch.observe(deadAt(at));
      expect(last.degraded).toBe(false);
    }
    expect(last.consecutiveUnhealthyMs).toBe(150_000);

    const latching = latch.observe(deadAt(DEFAULT_DEGRADE_AFTER_MS));
    expect(latching.degraded).toBe(true);
    expect(latching.changed).toBe(true);
    expect(latching.degradedSince).toBe(DEFAULT_DEGRADE_AFTER_MS);
    expect(latching.episodes).toBe(1);
    expect(latching.lastTransitionAt).toBe(DEFAULT_DEGRADE_AFTER_MS);
    expect(latch.degraded).toBe(true);
  });

  it('does not re-report `changed` on subsequent degraded observations', () => {
    const latch = new DataPlaneDegradationLatch({ degradeAfterMs: 60_000 });
    latch.observe(deadAt(0));
    expect(latch.observe(deadAt(60_000)).changed).toBe(true);
    const next = latch.observe(deadAt(90_000));
    expect(next.changed).toBe(false);
    expect(next.degraded).toBe(true);
    expect(next.episodes).toBe(1);
  });

  it('resets the unhealthy streak on a single healthy observation mid-window', () => {
    const latch = new DataPlaneDegradationLatch();
    latch.observe(deadAt(0));
    latch.observe(deadAt(60_000));
    const recovered = latch.observe(healthyAt(120_000));
    expect(recovered.consecutiveUnhealthyMs).toBe(0);
    expect(recovered.consecutiveHealthyMs).toBe(60_000);

    // The window restarts from the healthy observation, so the original T+180s misses.
    expect(latch.observe(deadAt(180_000)).degraded).toBe(false);
    expect(latch.observe(deadAt(240_000)).degraded).toBe(false);
    expect(latch.observe(deadAt(300_000)).degraded).toBe(true);
  });
});

describe('DataPlaneDegradationLatch latch-off', () => {
  const drive = (latch: DataPlaneDegradationLatch, from: number, to: number, step: number,
    make: (at: number) => DataPlaneObservation) => {
    for (let at = from; at <= to; at += step) latch.observe(make(at));
  };

  it('stays latched until the full recover window of healthy observations elapses', () => {
    const latch = new DataPlaneDegradationLatch();
    drive(latch, 0, DEFAULT_DEGRADE_AFTER_MS, 30_000, deadAt);
    expect(latch.degraded).toBe(true);

    const recoveryStart = DEFAULT_DEGRADE_AFTER_MS;
    for (let at = recoveryStart + 30_000; at < recoveryStart + DEFAULT_RECOVER_AFTER_MS; at += 30_000) {
      const result = latch.observe(healthyAt(at));
      expect(result.degraded).toBe(true);
      expect(result.degradedSince).toBe(recoveryStart);
    }

    const unlatched = latch.observe(healthyAt(recoveryStart + DEFAULT_RECOVER_AFTER_MS));
    expect(unlatched.degraded).toBe(false);
    expect(unlatched.changed).toBe(true);
    expect(unlatched.degradedSince).toBeNull();
    expect(unlatched.lastTransitionAt).toBe(recoveryStart + DEFAULT_RECOVER_AFTER_MS);
    expect(unlatched.episodes).toBe(1);
  });

  it('resets the healthy streak if the data plane flickers during recovery', () => {
    const latch = new DataPlaneDegradationLatch();
    drive(latch, 0, DEFAULT_DEGRADE_AFTER_MS, 30_000, deadAt);
    latch.observe(healthyAt(210_000));
    latch.observe(healthyAt(240_000));
    const flicker = latch.observe(deadAt(270_000));
    expect(flicker.consecutiveHealthyMs).toBe(0);
    expect(flicker.degraded).toBe(true);
    // Full recover window has to be earned again from scratch.
    latch.observe(healthyAt(300_000));
    expect(latch.observe(healthyAt(360_000)).degraded).toBe(true);
    expect(latch.observe(healthyAt(390_000)).degraded).toBe(false);
  });

  it('accrues total degraded time across two separate episodes', () => {
    const latch = new DataPlaneDegradationLatch({ degradeAfterMs: 60_000, recoverAfterMs: 120_000 });
    // Episode 1: latches at t=60_000, clears at t=180_000 → 120_000ms latched.
    latch.observe(deadAt(0));
    latch.observe(deadAt(30_000));
    expect(latch.observe(deadAt(60_000)).changed).toBe(true);
    latch.observe(healthyAt(90_000));
    latch.observe(healthyAt(120_000));
    latch.observe(healthyAt(150_000));
    const firstClear = latch.observe(healthyAt(180_000));
    expect(firstClear.degraded).toBe(false);
    expect(firstClear.totalDegradedMs).toBe(120_000);
    expect(firstClear.episodes).toBe(1);

    // Episode 2: latches at t=240_000, clears at t=360_000 → another 120_000ms.
    latch.observe(deadAt(210_000));
    const secondLatch = latch.observe(deadAt(240_000));
    expect(secondLatch.changed).toBe(true);
    expect(secondLatch.episodes).toBe(2);
    expect(secondLatch.degradedSince).toBe(240_000);
    latch.observe(healthyAt(270_000));
    latch.observe(healthyAt(300_000));
    latch.observe(healthyAt(330_000));
    const secondClear = latch.observe(healthyAt(360_000));
    expect(secondClear.degraded).toBe(false);
    expect(secondClear.totalDegradedMs).toBe(240_000);
    expect(secondClear.episodes).toBe(2);
  });
});

describe('DataPlaneDegradationLatch zero-candidate windows', () => {
  const idle = health(0, 0);

  it('does not latch while no candidates are in flight and the stream is fresh', () => {
    const latch = new DataPlaneDegradationLatch();
    for (let at = 0; at <= 600_000; at += 30_000) {
      const result = latch.observe(observation(at, idle, 5_000));
      expect(result.unhealthyReason).toBeNull();
      expect(result.degraded).toBe(false);
    }
  });

  it('latches on an idle-candidate window when the stream never produced a sequenced delta', () => {
    const latch = new DataPlaneDegradationLatch();
    for (let at = 0; at < DEFAULT_DEGRADE_AFTER_MS; at += 30_000) {
      expect(latch.observe(observation(at, idle, null)).degraded).toBe(false);
    }
    const latched = latch.observe(observation(DEFAULT_DEGRADE_AFTER_MS, idle, null));
    expect(latched.degraded).toBe(true);
    expect(latched.unhealthyReason).toBe('stream-sequenced-delta-stale');
  });

  it('latches on an idle-candidate window when the stream delta is stale', () => {
    const latch = new DataPlaneDegradationLatch();
    for (let at = 0; at <= DEFAULT_DEGRADE_AFTER_MS; at += 30_000) {
      latch.observe(observation(at, idle, 600_000));
    }
    expect(latch.degraded).toBe(true);
  });
});

describe('DataPlaneDegradationLatch clock robustness', () => {
  it('never accrues negative or double time from out-of-order or duplicate observations', () => {
    const latch = new DataPlaneDegradationLatch({ degradeAfterMs: 60_000 });
    latch.observe(deadAt(0));
    const forward = latch.observe(deadAt(30_000));
    expect(forward.consecutiveUnhealthyMs).toBe(30_000);

    const duplicate = latch.observe(deadAt(30_000));
    expect(duplicate.consecutiveUnhealthyMs).toBe(30_000);
    expect(duplicate.degraded).toBe(false);

    const backwards = latch.observe(deadAt(10_000));
    expect(backwards.consecutiveUnhealthyMs).toBe(30_000);
    expect(backwards.degraded).toBe(false);
    expect(backwards.lastObservedAt).toBe(30_000);

    // The next in-order observation accrues from 30_000, not from the rewound 10_000.
    const resumed = latch.observe(deadAt(60_000));
    expect(resumed.consecutiveUnhealthyMs).toBe(60_000);
    expect(resumed.degraded).toBe(true);
  });

  it('does not let a rewound clock inflate total degraded time', () => {
    const latch = new DataPlaneDegradationLatch({ degradeAfterMs: 30_000 });
    latch.observe(deadAt(0));
    latch.observe(deadAt(30_000));
    expect(latch.degraded).toBe(true);
    const rewound = latch.observe(deadAt(5_000));
    expect(rewound.totalDegradedMs).toBe(0);
    expect(latch.observe(deadAt(60_000)).totalDegradedMs).toBe(30_000);
  });

  it('accrues a long freeze at full length rather than capping it', () => {
    const latch = new DataPlaneDegradationLatch();
    latch.observe(deadAt(0));
    const afterFreeze = latch.observe(deadAt(3_600_000));
    expect(afterFreeze.consecutiveUnhealthyMs).toBe(3_600_000);
    expect(afterFreeze.degraded).toBe(true);
    const later = latch.observe(deadAt(7_200_000));
    expect(later.totalDegradedMs).toBe(3_600_000);
  });
});

describe('DataPlaneDegradationLatch snapshot', () => {
  it('is empty before any observation', () => {
    const latch = new DataPlaneDegradationLatch();
    expect(latch.snapshot(500_000)).toEqual({
      degraded: false,
      degradedSince: null,
      totalDegradedMs: 0,
      consecutiveUnhealthyMs: 0,
      consecutiveHealthyMs: 0,
      episodes: 0,
      lastObservedAt: null,
      lastTransitionAt: null,
    });
  });

  it('projects degraded time forward to now without mutating or latching', () => {
    const latch = new DataPlaneDegradationLatch({ degradeAfterMs: 60_000 });
    latch.observe(deadAt(0));
    latch.observe(deadAt(60_000));
    const projected = latch.snapshot(180_000);
    expect(projected.degraded).toBe(true);
    expect(projected.totalDegradedMs).toBe(120_000);
    expect(projected.consecutiveUnhealthyMs).toBe(180_000);
    // Projection is read-only: observing at the same instant yields the same numbers.
    expect(latch.snapshot(180_000)).toEqual(projected);
    expect(latch.observe(deadAt(180_000)).totalDegradedMs).toBe(120_000);
  });

  it('projects the healthy streak while latched and clamps a backwards `now`', () => {
    const latch = new DataPlaneDegradationLatch({ degradeAfterMs: 60_000, recoverAfterMs: 120_000 });
    latch.observe(deadAt(0));
    latch.observe(deadAt(60_000));
    latch.observe(healthyAt(90_000));
    const projected = latch.snapshot(150_000);
    expect(projected.consecutiveHealthyMs).toBe(90_000);
    expect(projected.consecutiveUnhealthyMs).toBe(0);
    // Still latched: only observe() may unlatch, and only after the full window.
    expect(projected.degraded).toBe(true);
    expect(latch.snapshot(10_000).totalDegradedMs).toBe(latch.snapshot(90_000).totalDegradedMs);
  });
});

describe('DataPlaneDegradationLatch replay of the 2026-07-26 run', () => {
  // Measured shape (plan §0.2): last orderbook application frame at T+13m40s, then
  // 7.9h with no sequenced book anywhere while candidates kept attempting entry.
  const HEALTH_TICK_MS = 15_000;
  const DATA_PLANE_DIED_AT = 820_000; // 13m40s
  const RUN_END_MS = 29_340_000; // 8.15h

  it('latches within ~3 minutes of the socket dying and never recovers', () => {
    const latch = new DataPlaneDegradationLatch();
    let latchedAt: number | null = null;
    let transitions = 0;
    const taggedRejections: number[] = [];

    for (let at = 0; at <= RUN_END_MS; at += HEALTH_TICK_MS) {
      const alive = at <= DATA_PLANE_DIED_AT;
      const result = latch.observe(alive ? healthyAt(at) : deadAt(at));
      if (result.changed) {
        transitions += 1;
        if (result.degraded) latchedAt = at;
      }
      // Every confirmation rejection on this tick would carry dataPlaneDegraded.
      if (result.degraded) taggedRejections.push(at);
    }

    expect(latchedAt).not.toBeNull();
    const delayMs = (latchedAt as number) - DATA_PLANE_DIED_AT;
    expect(delayMs).toBeGreaterThan(DEFAULT_DEGRADE_AFTER_MS - HEALTH_TICK_MS * 2);
    expect(delayMs).toBeLessThanOrEqual(DEFAULT_DEGRADE_AFTER_MS);
    expect(latchedAt).toBe(990_000); // T+16.5m, matching the plan's "degraded from ~T+16m"

    // One transition only: the run never recovered, so nothing may be read as economic.
    expect(transitions).toBe(1);
    expect(latch.degraded).toBe(true);

    const final = latch.snapshot(RUN_END_MS);
    expect(final.episodes).toBe(1);
    expect(final.degradedSince).toBe(990_000);
    expect(final.totalDegradedMs).toBe(RUN_END_MS - 990_000);
    expect(final.totalDegradedMs / RUN_END_MS).toBeGreaterThan(0.9);
    expect(taggedRejections.length).toBeGreaterThan(1_800);
    expect(taggedRejections[0]).toBe(990_000);
  });

  it('would not have latched had the socket recovered inside the grace window', () => {
    const latch = new DataPlaneDegradationLatch();
    for (let at = 0; at <= DATA_PLANE_DIED_AT; at += HEALTH_TICK_MS) latch.observe(healthyAt(at));
    for (let at = DATA_PLANE_DIED_AT + HEALTH_TICK_MS; at < DATA_PLANE_DIED_AT + 150_000; at += HEALTH_TICK_MS) {
      expect(latch.observe(deadAt(at)).degraded).toBe(false);
    }
    for (let at = DATA_PLANE_DIED_AT + 150_000; at <= DATA_PLANE_DIED_AT + 600_000; at += HEALTH_TICK_MS) {
      latch.observe(healthyAt(at));
    }
    expect(latch.degraded).toBe(false);
    expect(latch.snapshot(RUN_END_MS).episodes).toBe(0);
    expect(latch.snapshot(RUN_END_MS).totalDegradedMs).toBe(0);
  });
});
