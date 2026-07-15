import { describe, expect, it } from 'vitest';
import type { RendererMemoryAssessment } from './rendererMemoryMonitor.js';
import { RuntimeHealthController, type RuntimeComponentHealth } from './runtimeHealthController.js';

const renderer: RendererMemoryAssessment = {
  status: 'stable', sampleCount: 10, growthRate: 0, detail: 'stable', blocked: false,
  reasons: [], baselineKb: 100, workingSetKb: 100, p95WorkingSetKb: 100,
  slopePerHour: 0, rendererPid: 1,
};

function components(at: number): RuntimeComponentHealth[] {
  return ['rest-markets', 'trade-tape', 'ticker-websocket', 'orderbook-websocket', 'bridge', 'gea'].map((name) => ({
    name: name as RuntimeComponentHealth['name'], connected: true, qualificationReady: true, lastSuccessAt: at,
  }));
}

describe('RuntimeHealthController', () => {
  it('pauses on a stale component and resumes after three healthy snapshots', () => {
    const controller = new RuntimeHealthController();
    const stale = components(0);
    stale[1]!.lastSuccessAt = -20_000;
    expect(controller.observe({ at: 0, components: stale, renderer, process: { geaRunning: true, nemesisResponsive: true } }).action).toBe('pause');
    expect(controller.observe({ at: 5_000, components: components(5_000), renderer, process: { geaRunning: true, nemesisResponsive: true } }).action).toBe('pause');
    expect(controller.observe({ at: 10_000, components: components(10_000), renderer, process: { geaRunning: true, nemesisResponsive: true } }).action).toBe('pause');
    expect(controller.observe({ at: 15_000, components: components(15_000), renderer, process: { geaRunning: true, nemesisResponsive: true } }).action).toBe('resume');
  });

  it('uses component-specific evidence ages without expiring a valid 30-second REST lease at 15 seconds', () => {
    const controller = new RuntimeHealthController();
    const health = components(0);
    health[0]!.maxAgeMs = 30_000;
    health[1]!.maxAgeMs = 30_000;
    health.slice(2).forEach((component) => { component.lastSuccessAt = 20_000; });
    expect(controller.observe({
      at: 20_000,
      components: health,
      renderer,
      process: { geaRunning: true, nemesisResponsive: true },
    }).state).toBe('healthy');
  });

  it('invalidates after a 30-second recovery', () => {
    const controller = new RuntimeHealthController();
    const stale = components(0);
    stale[0]!.qualificationReady = false;
    controller.observe({ at: 0, components: stale, renderer, process: { geaRunning: true, nemesisResponsive: true } });
    const result = controller.observe({ at: 30_000, components: stale, renderer, process: { geaRunning: true, nemesisResponsive: true } });
    expect(result.invalidated).toBe(true);
    expect(result.lease.stickyFailure).toBe(true);
  });

  it('invalidates immediately on renderer, GEA, or NEMESIS process failures', () => {
    const controller = new RuntimeHealthController();
    const blocked = { ...renderer, blocked: true, status: 'unstable-growth' as const, reasons: ['memory blocked'] };
    const result = controller.observe({ at: 0, components: components(0), renderer: blocked, process: { geaRunning: false, nemesisResponsive: false } });
    expect(result.action).toBe('invalidate');
    expect(result.reasons).toEqual(['memory blocked', 'GEA process exited', 'NEMESIS became unresponsive']);
  });
});
