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

    expect(monitor.add({ at: 230, workingSetKb: 150 * MB, rendererPid: 1 }).status).toBe('unstable-growth');
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

  it('blocks rolling ten-minute growth above ten percent', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    monitor.add({ at: 0, workingSetKb: 100 * MB, painted: true });
    const result = monitor.add({ at: 10 * 60_000, workingSetKb: 111 * MB, painted: true });
    expect(result.blocked).toBe(true);
    expect(result.growthRate).toBeCloseTo(0.11);
    expect(result.detail).toContain('rolling ten-minute window');
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

  it('still blocks sustained rolling growth when the window has many samples', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    let result = monitor.add({ at: 0, workingSetKb: 100 * MB, painted: true });
    for (let index = 1; index <= 20; index += 1) {
      result = monitor.add({
        at: index * 30_000,
        workingSetKb: (100 + (11 * index / 20)) * MB,
        painted: true,
      });
    }

    expect(result.blocked).toBe(true);
    expect(result.growthRate).toBeGreaterThan(0.10);
  });

  it('excludes the five-minute warm-up from the rolling ten-minute growth gate', () => {
    const monitor = new RendererMemoryMonitor(5 * 60_000, 1);
    monitor.add({ at: 0, workingSetKb: 80 * MB, painted: true });
    expect(monitor.add({ at: 5 * 60_000, workingSetKb: 100 * MB, painted: true }).status).toBe('stable');
    expect(monitor.add({ at: 10 * 60_000, workingSetKb: 111 * MB, painted: true }).blocked).toBe(false);
    const result = monitor.add({ at: 15 * 60_000, workingSetKb: 112 * MB, painted: true });
    expect(result.blocked).toBe(true);
    expect(result.growthRate).toBeCloseTo(0.12);
  });

  it('blocks a thirty-minute projected slope above two percent of baseline per hour', () => {
    const monitor = new RendererMemoryMonitor(0, 1);
    monitor.add({ at: 0, workingSetKb: 100 * MB, painted: true });
    const result = monitor.add({ at: 30 * 60_000, workingSetKb: 101.1 * MB, painted: true });
    expect(result.blocked).toBe(true);
    expect(result.slopePerHour).toBeGreaterThan(0.02);
    expect(result.detail).toContain('projected slope');
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
