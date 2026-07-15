import { describe, expect, it } from 'vitest';
import { RendererMemoryMonitor } from './rendererMemoryMonitor.js';

describe('RendererMemoryMonitor', () => {
  it('detects monotonic post-warm-up growth', () => {
    const monitor = new RendererMemoryMonitor(100, 4);
    monitor.add({ at: 0, workingSetKb: 100 });
    monitor.add({ at: 100, workingSetKb: 110 });
    monitor.add({ at: 110, workingSetKb: 115 });
    monitor.add({ at: 120, workingSetKb: 120 });
    expect(monitor.add({ at: 130, workingSetKb: 125 }).status).toBe('unstable-growth');
  });

  it('accepts a non-monotonic stabilized window', () => {
    const monitor = new RendererMemoryMonitor(100, 4);
    monitor.add({ at: 0, workingSetKb: 100 });
    monitor.add({ at: 100, workingSetKb: 110 });
    monitor.add({ at: 110, workingSetKb: 108 });
    monitor.add({ at: 120, workingSetKb: 111 });
    expect(monitor.add({ at: 130, workingSetKb: 109 }).status).toBe('stable');
  });

  it('rejects large endpoint growth even when the path is not monotonic', () => {
    const monitor = new RendererMemoryMonitor(100, 4);
    monitor.add({ at: 0, workingSetKb: 100 });
    monitor.add({ at: 100, workingSetKb: 100 });
    monitor.add({ at: 110, workingSetKb: 250 });
    monitor.add({ at: 120, workingSetKb: 180 });
    const assessment = monitor.add({ at: 130, workingSetKb: 220 });
    expect(assessment.status).toBe('unstable-growth');
    expect(assessment.growthRate).toBeCloseTo(1.2);
  });
});
