import { describe, expect, it } from 'vitest';
import { RendererMemoryMonitor } from './rendererMemoryMonitor.js';

const MB = 1024;

describe('RendererMemoryMonitor', () => {
  it('establishes a median baseline and keeps assessing after the first stable result', () => {
    const monitor = new RendererMemoryMonitor(100, 4, {
      trendWindowMs: 100,
      slopeWindowMs: 1_000,
    });
    monitor.add({ at: 0, workingSetKb: 100 * MB, rendererPid: 1 });
    monitor.add({ at: 100, workingSetKb: 110 * MB, rendererPid: 1 });
    monitor.add({ at: 110, workingSetKb: 108 * MB, rendererPid: 1 });
    monitor.add({ at: 120, workingSetKb: 111 * MB, rendererPid: 1 });
    expect(monitor.add({ at: 130, workingSetKb: 109 * MB, rendererPid: 1 }).status).toBe('stable');
    expect(monitor.snapshot().baselineKb).toBe(109.5 * MB);

    expect(monitor.add({ at: 230, workingSetKb: 109 * MB, rendererPid: 1 }).status).toBe('stable');
    // Above 150% of the 109.5MB baseline, so it trips the baseline bound.
    expect(monitor.add({ at: 330, workingSetKb: 170 * MB, rendererPid: 1 }).status).toBe('unstable-growth');
  });

  it('blocks three consecutive samples above 384MB', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    monitor.add({ at: 0, workingSetKb: 390 * MB });
    monitor.add({ at: 30_000, workingSetKb: 391 * MB });
    const result = monitor.add({ at: 60_000, workingSetKb: 392 * MB });
    expect(result.blocked).toBe(true);
    expect(result.reasons.join(' ')).toContain('3 consecutive');
  });

  it('blocks a post-paint sample above 512MB immediately', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    const result = monitor.add({ at: 0, workingSetKb: 513 * MB, painted: true });
    expect(result.blocked).toBe(true);
    expect(result.detail).toContain('512MB');
  });

  it('reports rolling ten-minute growth as evidence without blocking on it', () => {
    // The rate is phase-sensitive: a ten-minute window can straddle opposite
    // phases of a longer allocate/collect cycle. Measured in a soak it swung
    // -22% to +17.6% in six minutes with no net growth, so it is recorded as
    // evidence and leak detection is left to the phase-independent gates.
    const monitor = new RendererMemoryMonitor(0, 1);
    monitor.add({ at: 0, workingSetKb: 100 * MB, painted: true });
    const result = monitor.add({ at: 10 * 60_000, workingSetKb: 111 * MB, painted: true });
    expect(result.growthRate).toBeCloseTo(0.11);
    expect(result.blocked).toBe(false);
  });

  it('does not turn a one-sample garbage-collection trough into rolling growth', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    let result = monitor.add({ at: 0, workingSetKb: 90 * MB, painted: true });
    for (let index = 1; index <= 20; index += 1) {
      result = monitor.add({
        at: index * 30_000,
        workingSetKb: (100 + (index % 3)) * MB,
        painted: true,
      });
    }

    expect(result.status).toBe('stable');
    expect(result.growthRate).toBeLessThan(0.10);
  });

  it('catches sustained growth through the baseline bound rather than the rolling window', () => {
    // Sustained growth is still caught, by an instrument that does not depend
    // on window phase: 150% of the established baseline.
    const monitor = new RendererMemoryMonitor(0, 1);
    let result = monitor.add({ at: 0, workingSetKb: 100 * MB, painted: true });
    for (let index = 1; index <= 20; index += 1) {
      result = monitor.add({
        at: index * 30_000,
        workingSetKb: (100 + (3 * index)) * MB,
        painted: true,
      });
    }

    expect(result.blocked).toBe(true);
    expect(result.detail).toContain('150% of baseline');
  });

  it('excludes warm-up allocation from the reported rolling growth rate', () => {
    const monitor = new RendererMemoryMonitor(5 * 60_000, 1);
    monitor.add({ at: 0, workingSetKb: 80 * MB, painted: true });
    expect(monitor.add({ at: 5 * 60_000, workingSetKb: 100 * MB, painted: true }).status).toBe('stable');
    // The 80MB -> 100MB warm-up ramp must not appear as post-baseline growth.
    expect(monitor.add({ at: 10 * 60_000, workingSetKb: 111 * MB, painted: true }).growthRate).toBe(0);
    const result = monitor.add({ at: 15 * 60_000, workingSetKb: 112 * MB, painted: true });
    expect(result.blocked).toBe(false);
  });

  it('blocks a thirty-minute projected slope above two percent of baseline per hour', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    monitor.add({ at: 0, workingSetKb: 100 * MB, painted: true });
    const result = monitor.add({ at: 30 * 60_000, workingSetKb: 101.1 * MB, painted: true });
    expect(result.blocked).toBe(true);
    expect(result.slopePerHour).toBeGreaterThan(0.02);
    expect(result.detail).toContain('projected slope');
  });

  it('excludes warm-up allocation and waits for a full thirty-minute slope window', () => {
    const monitor = new RendererMemoryMonitor(5 * 60_000, 1);
    monitor.add({ at: 0, workingSetKb: 80 * MB, painted: true });
    monitor.add({ at: 5 * 60_000, workingSetKb: 100 * MB, painted: true });
    for (let minute = 10; minute <= 30; minute += 5) {
      monitor.add({ at: minute * 60_000, workingSetKb: 100 * MB, painted: true });
    }

    const early = monitor.add({ at: 32 * 60_000, workingSetKb: 101 * MB, painted: true });
    expect(early.status).toBe('stable');
    expect(early.slopePerHour).toBe(0);
    expect(early.slopeWindowComplete).toBe(false);
    expect(early.slopeWindowMs).toBe(27 * 60_000);

    const complete = monitor.add({ at: 35 * 60_000, workingSetKb: 100 * MB, painted: true });
    expect(complete.status).toBe('stable');
    expect(complete.slopePerHour).toBeLessThanOrEqual(0.02);
    expect(complete.slopeWindowComplete).toBe(true);
    expect(complete.slopeWindowMs).toBe(30 * 60_000);
    expect(monitor.snapshot()).toMatchObject({
      slopeWindowComplete: true,
      slopeWindowMs: 30 * 60_000,
      slopePerHour: complete.slopePerHour,
    });
  });

  it('keeps a complete slope window when sampling jitter crosses the boundary', () => {
    const monitor = new RendererMemoryMonitor(5 * 60_000, 1);
    monitor.add({ at: 0, workingSetKb: 80 * MB, painted: true });
    let result = monitor.add({ at: 5 * 60_000 + 10, workingSetKb: 100 * MB, painted: true });
    for (let index = 1; index <= 60; index += 1) {
      result = monitor.add({
        at: 5 * 60_000 + 10 + (index * 30_001),
        workingSetKb: 100 * MB,
        painted: true,
      });
    }

    expect(result.slopeWindowComplete).toBe(true);
    expect(result.slopeWindowMs).toBeGreaterThanOrEqual(30 * 60_000);
    const next = monitor.add({ at: 35 * 60_000 + 30_071, workingSetKb: 100 * MB, painted: true });
    expect(next.slopeWindowComplete).toBe(true);
    expect(next.slopeWindowMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('blocks a post-paint sample more than fifty percent above baseline', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    monitor.add({ at: 0, workingSetKb: 100 * MB, painted: true });
    const result = monitor.add({ at: 30_000, workingSetKb: 151 * MB, painted: true });
    expect(result.blocked).toBe(true);
    expect(result.detail).toContain('150% of baseline');
  });

  it('blocks PID changes, stale heartbeats, and prolonged unresponsiveness', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    monitor.add({ at: 0, workingSetKb: 100 * MB, rendererPid: 10 });
    const result = monitor.add({
      at: 30_000,
      workingSetKb: 101 * MB,
      rendererPid: 11,
      heartbeatAgeMs: 15_001,
      unresponsiveForMs: 10_001,
    });
    expect(result.reasons).toHaveLength(3);
    expect(result.detail).toContain('PID changed');
    expect(result.detail).toContain('heartbeat');
    expect(result.detail).toContain('unresponsive');
  });

  it('ignores malformed samples without corrupting the baseline', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    expect(monitor.add({ at: 0, workingSetKb: Number.NaN }).status).toBe('warming');
    expect(monitor.add({ at: 1, workingSetKb: 100 * MB }).status).toBe('stable');
    expect(monitor.snapshot().sampleCount).toBe(1);
  });
});
