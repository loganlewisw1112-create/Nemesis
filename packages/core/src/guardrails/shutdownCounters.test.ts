import { describe, expect, it } from 'vitest';
import {
  applyApiDegradedElapsed,
  isRiskSettingOverride,
  recordAbnormalExecution,
  recordInvalidation,
  recordManualOverride,
  resetInvalidationStreak,
} from './shutdownCounters.js';
import { DEFAULT_SHUTDOWN_COUNTERS } from './engine.js';

describe('shutdownCounters', () => {
  it('tracks invalidation streak', () => {
    const c = { ...DEFAULT_SHUTDOWN_COUNTERS };
    recordInvalidation(c);
    expect(c.consecutiveInvalidations).toBe(1);
    resetInvalidationStreak(c);
    expect(c.consecutiveInvalidations).toBe(0);
  });

  it('tracks abnormal executions and manual overrides', () => {
    const c = { ...DEFAULT_SHUTDOWN_COUNTERS };
    recordAbnormalExecution(c);
    recordManualOverride(c);
    expect(c.abnormalExecutions).toBe(1);
    expect(c.manualOverrides).toBe(1);
  });

  it('accumulates api degraded minutes from elapsed ms', () => {
    const c = { ...DEFAULT_SHUTDOWN_COUNTERS };
    applyApiDegradedElapsed(c, true, 125_000);
    expect(c.apiDegradedMinutes).toBe(2);
    applyApiDegradedElapsed(c, false, 60_000);
    expect(c.apiDegradedMinutes).toBe(2);
  });

  it('detects risk setting overrides', () => {
    expect(isRiskSettingOverride({ maxPositionUsd: 20 })).toBe(true);
    expect(isRiskSettingOverride({ demoMode: false })).toBe(false);
  });
});
