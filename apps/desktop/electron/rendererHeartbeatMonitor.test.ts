import { describe, expect, it } from 'vitest';
import { RendererHeartbeatMonitor } from './rendererHeartbeatMonitor.js';

describe('RendererHeartbeatMonitor', () => {
  it('uses an explicit startup grace and requires a real heartbeat afterward', () => {
    const monitor = new RendererHeartbeatMonitor(1_000, { startupGraceMs: 30_000 });
    monitor.markLoadFinished(1_000);
    expect(monitor.snapshot(31_000).blocked).toBe(false);
    expect(monitor.snapshot(31_001)).toMatchObject({ blocked: true, lastHeartbeatAt: null });
  });

  it('starts the startup grace at page load completion', () => {
    const monitor = new RendererHeartbeatMonitor(1_000, { startupGraceMs: 30_000 });
    monitor.markLoadFinished(20_000);

    expect(monitor.snapshot(49_999)).toMatchObject({
      loadFinishedAt: 20_000,
      monitoringStartedAt: 20_000,
      loadingGraceUntil: 50_000,
      blocked: false,
    });
    expect(monitor.snapshot(50_001).reasons).toContain('renderer heartbeat was absent after the startup loading grace');
  });

  it('records the first heartbeat and first painted heartbeat with ordered sequences', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.markLoadFinished(100);
    monitor.recordHeartbeat({ receivedAt: 200, reportedAt: 200, sequence: 1, painted: false });
    monitor.recordHeartbeat({ receivedAt: 5_200, reportedAt: 5_200, sequence: 2, painted: true });

    expect(monitor.snapshot(5_201)).toMatchObject({
      firstHeartbeatAt: 200,
      firstPaintedAt: 5_200,
      lastHeartbeatSequence: 2,
      heartbeatAgeMs: 1,
      painted: true,
      blocked: false,
    });
  });

  it('latches duplicate or regressed heartbeat sequences', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.recordHeartbeat({ receivedAt: 1_000, sequence: 2 });
    monitor.recordHeartbeat({ receivedAt: 2_000, sequence: 2 });

    expect(monitor.snapshot(2_001).reasons).toContain('renderer heartbeat sequence regressed or duplicated');
  });

  it('requires a fresh response to each renderer probe', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.markLoadFinished(1);
    monitor.recordProbeSent(1_000, 7);
    expect(monitor.snapshot(15_999)).toMatchObject({
      probeResponseReceived: false,
      blocked: false,
    });

    monitor.recordProbeResponse({ receivedAt: 2_000, sentAt: 1_000, sequence: 7 });
    expect(monitor.snapshot(2_001)).toMatchObject({
      probeResponseReceived: true,
      lastProbeResponseAt: 2_000,
      probeAgeMs: 1,
      blocked: false,
    });

    expect(monitor.snapshot(17_001).reasons).toContain('renderer probe response was absent or stale');
  });

  it('captures probe sequence mismatches and heartbeat send failures', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.recordProbeSent(1_000, 3);
    monitor.recordProbeResponse({ receivedAt: 1_100, sentAt: 1_000, sequence: 2 });
    monitor.recordHeartbeatSendFailure();

    expect(monitor.snapshot(1_101)).toMatchObject({ heartbeatSendFailures: 1, blocked: true });
    expect(monitor.snapshot(1_101).reasons).toEqual(expect.arrayContaining([
      'renderer probe sequence did not match the latest probe',
      'renderer heartbeat send failed',
    ]));
  });

  it('latches a renderer restart as an invalidating failure', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.recordHeartbeat({ receivedAt: 1_000, sequence: 1 });
    monitor.markRendererGone();

    expect(monitor.snapshot(1_001).reasons).toContain('renderer process exited');
    expect(monitor.snapshot(1_001).blocked).toBe(true);
  });

  it('latches an inter-heartbeat gap even after a fresh heartbeat arrives', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.recordHeartbeat({ receivedAt: 1_000, reportedAt: 1_000 });
    monitor.recordHeartbeat({ receivedAt: 17_000, reportedAt: 17_000, painted: true });
    const snapshot = monitor.snapshot(17_001);
    expect(snapshot.heartbeatAgeMs).toBe(1);
    expect(snapshot.painted).toBe(true);
    expect(snapshot.blocked).toBe(true);
    expect(snapshot.reasons).toContain('renderer heartbeat gap exceeded 15 seconds');
  });

  it('latches a completed unresponsive incident longer than ten seconds', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.recordHeartbeat({ receivedAt: 1_000 });
    monitor.markLoadFinished(1_000);
    monitor.markUnresponsive(2_000);
    monitor.markResponsive(12_001);
    expect(monitor.snapshot(12_002).reasons).toContain('renderer was unresponsive for more than 10 seconds');
  });

  it('does not block on a short completed unresponsive incident', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.recordHeartbeat({ receivedAt: 1_000 });
    monitor.markLoadFinished(1_000);
    monitor.markUnresponsive(2_000);
    monitor.markResponsive(11_999);
    expect(monitor.snapshot(12_000).blocked).toBe(false);
  });
});
