/**
 * Fail-closed data-plane health (plan Phase 3, tasks 3.1/3.2).
 *
 * The 2026-07-26 paper run emitted 4,136 "confirmation requires an exchange-origin
 * book timestamp and sequence" rejections that read like an economic verdict. They
 * were not: the Kalshi orderbook socket died 13m40s in and never re-opened, so no
 * candidate could ever obtain a sequenced book. This module makes that failure
 * self-declaring — once the data plane cannot prove itself for a grace window the
 * run latches degraded, and every rejection emitted while latched is tagged so no
 * verdict generator can read "no data" as "no edge".
 *
 * Deliberately pure and deterministic: no timers, no I/O, no Date.now(). Every
 * clock reading is passed in by the caller. That is what makes the 8-hour failure
 * replayable in a unit test in milliseconds.
 */

/** Mirrors the connector's book-state union; duplicated locally to avoid a hard import cycle. */
export type CandidateBookStateName =
  | 'untracked'
  | 'tracked-no-provenance'
  | 'subscribed-awaiting-snapshot'
  | 'snapshot-quarantined'
  | 'sequenced';

export interface CandidateBookSample {
  ticker: string;
  state: CandidateBookStateName;
  sequencedAgeMs: number | null;
}

export interface CandidateSequencedBookHealth {
  candidateCount: number;
  sequencedWithinCount: number;
  /** 0 when candidateCount === 0 — callers must treat that as "no evidence", not "unhealthy". */
  fractionSequencedWithin: number;
  maxSequencedAgeMs: number | null;
  minSequencedAgeMs: number | null;
  thresholdMs: number;
}

export const DEFAULT_SEQUENCED_BOOK_THRESHOLD_MS = 30_000;
export const DEFAULT_DEGRADE_AFTER_MS = 180_000; // 3 min
export const DEFAULT_RECOVER_AFTER_MS = 120_000; // 2 min

/** The only two reasons an observation can count as unhealthy. Exported for callers that switch on them. */
export type DataPlaneUnhealthyReason = 'no-candidate-sequenced-book' | 'stream-sequenced-delta-stale';

export function computeCandidateSequencedBookHealth(
  samples: readonly CandidateBookSample[],
  options?: { thresholdMs?: number },
): CandidateSequencedBookHealth {
  const thresholdMs = options?.thresholdMs ?? DEFAULT_SEQUENCED_BOOK_THRESHOLD_MS;

  // In-flight confirmation tickers and campaign-critical tickers are two lists that
  // overlap; a ticker present in both must not count twice against the fraction.
  // Freshest wins so a duplicate carrying a stale age can never mask a live book.
  const byTicker = new Map<string, CandidateBookSample>();
  for (const sample of samples) {
    const existing = byTicker.get(sample.ticker);
    if (existing == null) {
      byTicker.set(sample.ticker, sample);
      continue;
    }
    if (sample.sequencedAgeMs == null) continue;
    if (existing.sequencedAgeMs == null || sample.sequencedAgeMs < existing.sequencedAgeMs) {
      byTicker.set(sample.ticker, sample);
    }
  }

  let sequencedWithinCount = 0;
  let maxSequencedAgeMs: number | null = null;
  let minSequencedAgeMs: number | null = null;
  for (const sample of byTicker.values()) {
    const age = sample.sequencedAgeMs;
    if (age == null) continue;
    if (sample.state === 'sequenced' && age <= thresholdMs) sequencedWithinCount += 1;
    maxSequencedAgeMs = maxSequencedAgeMs == null ? age : Math.max(maxSequencedAgeMs, age);
    minSequencedAgeMs = minSequencedAgeMs == null ? age : Math.min(minSequencedAgeMs, age);
  }

  const candidateCount = byTicker.size;
  return {
    candidateCount,
    sequencedWithinCount,
    // Exactly 0 with no candidates: an empty candidate set is an absence of evidence,
    // and 0/0 must never be reported as 1 ("everything is fine").
    fractionSequencedWithin: candidateCount === 0 ? 0 : sequencedWithinCount / candidateCount,
    maxSequencedAgeMs,
    minSequencedAgeMs,
    thresholdMs,
  };
}

export interface DataPlaneObservation {
  at: number;
  health: CandidateSequencedBookHealth;
  /** Age of the newest sequenced delta anywhere on the stream; null when none ever. */
  streamSequencedAgeMs: number | null;
}

export interface DataPlaneHealthSnapshot {
  degraded: boolean;
  /** When the current degraded episode began; null when healthy. */
  degradedSince: number | null;
  /** Cumulative degraded milliseconds across the whole session. */
  totalDegradedMs: number;
  /** How long the current unhealthy (or healthy) streak has run. */
  consecutiveUnhealthyMs: number;
  consecutiveHealthyMs: number;
  episodes: number;
  lastObservedAt: number | null;
  lastTransitionAt: number | null;
}

export interface DataPlaneObservationResult extends DataPlaneHealthSnapshot {
  /** True on the observation that flipped degraded on or off. */
  changed: boolean;
  /** Why this observation counted as unhealthy; null when healthy. */
  unhealthyReason: string | null;
}

export interface DataPlaneDegradationLatchOptions {
  degradeAfterMs?: number;
  recoverAfterMs?: number;
  thresholdMs?: number;
}

export class DataPlaneDegradationLatch {
  private readonly degradeAfterMs: number;
  private readonly recoverAfterMs: number;
  private readonly thresholdMs: number;

  private latched = false;
  private degradedSince: number | null = null;
  private totalDegradedMs = 0;
  private unhealthyStreakMs = 0;
  private healthyStreakMs = 0;
  private episodeCount = 0;
  private lastObservedAt: number | null = null;
  private lastTransitionAt: number | null = null;
  /** null until the first observation; tells `snapshot` which streak to project. */
  private lastUnhealthy: boolean | null = null;

  constructor(options: DataPlaneDegradationLatchOptions = {}) {
    this.degradeAfterMs = options.degradeAfterMs ?? DEFAULT_DEGRADE_AFTER_MS;
    this.recoverAfterMs = options.recoverAfterMs ?? DEFAULT_RECOVER_AFTER_MS;
    this.thresholdMs = options.thresholdMs ?? DEFAULT_SEQUENCED_BOOK_THRESHOLD_MS;
  }

  get degraded(): boolean {
    return this.latched;
  }

  observe(observation: DataPlaneObservation): DataPlaneObservationResult {
    const reason = this.classify(observation);
    const unhealthy = reason != null;

    // Clamp to >= 0 so a replayed, duplicated, or clock-stepped-backwards `at`
    // can neither rewind accrued time nor count an interval twice. A gap larger
    // than degradeAfterMs is NOT capped: if the process was frozen for an hour,
    // an hour of book delivery really was missed, and pretending otherwise would
    // hide exactly the class of failure this latch exists to surface.
    const elapsedMs = this.lastObservedAt == null ? 0 : Math.max(0, observation.at - this.lastObservedAt);

    // Accrue against the state that held over the interval — i.e. the state as of
    // the previous observation — before evaluating any transition for this one.
    if (this.latched) this.totalDegradedMs += elapsedMs;

    if (unhealthy) {
      this.unhealthyStreakMs += elapsedMs;
      this.healthyStreakMs = 0;
    } else {
      this.healthyStreakMs += elapsedMs;
      this.unhealthyStreakMs = 0;
    }

    let changed = false;
    if (!this.latched && unhealthy && this.unhealthyStreakMs >= this.degradeAfterMs) {
      this.latched = true;
      this.degradedSince = observation.at;
      this.episodeCount += 1;
      this.lastTransitionAt = observation.at;
      changed = true;
    } else if (this.latched && !unhealthy && this.healthyStreakMs >= this.recoverAfterMs) {
      this.latched = false;
      this.degradedSince = null;
      this.lastTransitionAt = observation.at;
      changed = true;
    }

    // Monotonic: an out-of-order observation is evaluated but never moves the clock
    // backwards, otherwise the next in-order observation would double-accrue.
    this.lastObservedAt = this.lastObservedAt == null ? observation.at : Math.max(this.lastObservedAt, observation.at);
    this.lastUnhealthy = unhealthy;

    return { ...this.state(), changed, unhealthyReason: reason };
  }

  /**
   * Read-only projection to `now`. Extends the accrued counters by the elapsed time
   * since the last observation so a status/report reader sees true degraded minutes
   * rather than a figure frozen at the last health tick. It never latches or
   * unlatches — only `observe` may change latch state — and never mutates.
   */
  snapshot(now: number): DataPlaneHealthSnapshot {
    const base = this.state();
    if (this.lastObservedAt == null || this.lastUnhealthy == null) return base;
    const elapsedMs = Math.max(0, now - this.lastObservedAt);
    if (elapsedMs === 0) return base;
    return {
      ...base,
      totalDegradedMs: base.totalDegradedMs + (this.latched ? elapsedMs : 0),
      consecutiveUnhealthyMs: this.lastUnhealthy ? base.consecutiveUnhealthyMs + elapsedMs : base.consecutiveUnhealthyMs,
      consecutiveHealthyMs: this.lastUnhealthy ? base.consecutiveHealthyMs : base.consecutiveHealthyMs + elapsedMs,
    };
  }

  /**
   * Candidates with no sequenced book is the stronger, more specific signal, so it
   * wins when both clauses fire. Zero candidates alone is deliberately NOT unhealthy:
   * with nothing in flight there are no rejections to mislabel. The stream-level
   * clause is what still catches an idle-candidate window over a dead socket.
   */
  private classify(observation: DataPlaneObservation): DataPlaneUnhealthyReason | null {
    const { health, streamSequencedAgeMs } = observation;
    if (health.candidateCount > 0 && health.sequencedWithinCount === 0) return 'no-candidate-sequenced-book';
    if (streamSequencedAgeMs == null || streamSequencedAgeMs > this.thresholdMs) return 'stream-sequenced-delta-stale';
    return null;
  }

  private state(): DataPlaneHealthSnapshot {
    return {
      degraded: this.latched,
      degradedSince: this.degradedSince,
      totalDegradedMs: this.totalDegradedMs,
      consecutiveUnhealthyMs: this.unhealthyStreakMs,
      consecutiveHealthyMs: this.healthyStreakMs,
      episodes: this.episodeCount,
      lastObservedAt: this.lastObservedAt,
      lastTransitionAt: this.lastTransitionAt,
    };
  }
}
