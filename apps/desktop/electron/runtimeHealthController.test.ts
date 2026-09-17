import { describe, expect, it } from 'vitest';
import type { RendererMemoryAssessment } from './rendererMemoryMonitor.js';
import { RuntimeHealthController, type RuntimeComponentHealth } from './runtimeHealthController.js';

const renderer: RendererMemoryAssessment = {
  status: 'stable', sampleCount: 10, growthRate: 0, detail: 'stable', blocked: false,
  reasons: [], baselineKb: 100, workingSetKb: 100, p95WorkingSetKb: 100,
  slopePerHour: 0, slopeWindowComplete: false, slopeWindowMs: 0, rendererPid: 1,
};

function components(at: number): RuntimeComponentHealth[] {
  return ['rest-markets', 'trade-tape', 'ticker-websocket', 'orderbook-websocket', 'bridge', 'gea'].map((name) => ({
    name: name as RuntimeComponentHealth['name'], connected: true, qualificationReady: true, lastSuccessAt: at,
  }));
}

describe('RuntimeHealthController', () => {
  it('keeps startup warming paused without counting it as a recovery', () => {
    const controller = new RuntimeHealthController();
    const unready = components(0);
    unready[0]!.qualificationReady = false;

    expect(controller.observe({
      at: 0,
      components: unready,
      renderer,
      process: { geaRunning: true, nemesisResponsive: true },
    })).toMatchObject({ state: 'warming', action: 'pause', recoveryCount: 0 });
    expect(controller.observe({
      at: 60_000,
      components: unready,
      renderer,
      process: { geaRunning: true, nemesisResponsive: true },
    })).toMatchObject({ state: 'warming', invalidated: false, recoveryCount: 0 });
    expect(controller.observe({
      at: 65_000,
      components: components(65_000),
      renderer,
      process: { geaRunning: true, nemesisResponsive: true },
    })).toMatchObject({ state: 'healthy', action: 'resume', recoveryCount: 0 });
  });

  it('pauses on a stale component and resumes after three healthy snapshots', () => {
    const controller = new RuntimeHealthController();
    controller.observe({ at: 0, components: components(0), renderer, process: { geaRunning: true, nemesisResponsive: true } });
    const stale = components(0);
    stale[1]!.lastSuccessAt = -20_000;
    expect(controller.observe({ at: 1, components: stale, renderer, process: { geaRunning: true, nemesisResponsive: true } }).action).toBe('pause');
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
    controller.observe({ at: 0, components: components(0), renderer, process: { geaRunning: true, nemesisResponsive: true } });
    const stale = components(0);
    stale[0]!.qualificationReady = false;
    controller.observe({ at: 1, components: stale, renderer, process: { geaRunning: true, nemesisResponsive: true } });
    const result = controller.observe({ at: 30_001, components: stale, renderer, process: { geaRunning: true, nemesisResponsive: true } });
    expect(result.invalidated).toBe(true);
    expect(result.lease.stickyFailure).toBe(true);
  });

  it('invalidates on the third post-startup recovery while excluding warming', () => {
    const controller = new RuntimeHealthController();
    const observeHealthy = (at: number) => controller.observe({
      at,
      components: components(at),
      renderer,
      process: { geaRunning: true, nemesisResponsive: true },
    });
    const observeFault = (at: number) => {
      const failed = components(at);
      failed[0]!.qualificationReady = false;
      return controller.observe({
        at,
        components: failed,
        renderer,
        process: { geaRunning: true, nemesisResponsive: true },
      });
    };

    expect(observeHealthy(0).recoveryCount).toBe(0);
    expect(observeFault(1_000)).toMatchObject({ state: 'recovering', recoveryCount: 1 });
    observeHealthy(6_000);
    observeHealthy(11_000);
    expect(observeHealthy(16_000).state).toBe('healthy');
    expect(observeFault(20_000)).toMatchObject({ state: 'recovering', recoveryCount: 2 });
    observeHealthy(25_000);
    observeHealthy(30_000);
    expect(observeHealthy(35_000).state).toBe('healthy');
    expect(observeFault(40_000)).toMatchObject({ state: 'invalidated', recoveryCount: 3, invalidated: true });
  });

  it('invalidates immediately on renderer, GEA, or NEMESIS process failures', () => {
    const controller = new RuntimeHealthController();
    const blocked = { ...renderer, blocked: true, status: 'unstable-growth' as const, reasons: ['memory blocked'] };
    const result = controller.observe({ at: 0, components: components(0), renderer: blocked, process: { geaRunning: false, nemesisResponsive: false } });
    expect(result.action).toBe('invalidate');
    expect(result.reasons).toEqual(['memory blocked', 'GEA process exited', 'NEMESIS became unresponsive']);
  });
});
