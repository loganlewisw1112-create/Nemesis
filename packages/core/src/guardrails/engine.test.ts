import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHUTDOWN_COUNTERS,
  shouldShutdownSession,
} from './engine.js';

describe('shouldShutdownSession', () => {
  it('does not shutdown below thresholds', () => {
    expect(shouldShutdownSession(DEFAULT_SHUTDOWN_COUNTERS)).toBe(false);
    expect(
      shouldShutdownSession({
        ...DEFAULT_SHUTDOWN_COUNTERS,
        consecutiveInvalidations: 4,
        abnormalExecutions: 2,
      }),
    ).toBe(false);
  });

  it('shuts down at consecutive invalidation threshold', () => {
    expect(
      shouldShutdownSession({
        ...DEFAULT_SHUTDOWN_COUNTERS,
        consecutiveInvalidations: 5,
      }),
    ).toBe(true);
  });

  it('shuts down at abnormal execution threshold', () => {
    expect(
      shouldShutdownSession({
        ...DEFAULT_SHUTDOWN_COUNTERS,
        abnormalExecutions: 3,
      }),
    ).toBe(true);
  });

  it('shuts down at manual override threshold', () => {
    expect(
      shouldShutdownSession({
        ...DEFAULT_SHUTDOWN_COUNTERS,
        manualOverrides: 3,
      }),
    ).toBe(true);
  });

  it('shuts down at api degraded minutes threshold', () => {
    expect(
      shouldShutdownSession({
        ...DEFAULT_SHUTDOWN_COUNTERS,
        apiDegradedMinutes: 10,
      }),
    ).toBe(true);
  });
});
