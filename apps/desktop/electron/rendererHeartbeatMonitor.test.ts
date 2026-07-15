import { describe, expect, it } from 'vitest';
import { RendererHeartbeatMonitor } from './rendererHeartbeatMonitor.js';

describe('RendererHeartbeatMonitor', () => {
  it('uses an explicit startup grace and requires a real heartbeat afterward', () => {
    const monitor = new RendererHeartbeatMonitor(1_000, { startupGraceMs: 30_000 });
    expect(monitor.snapshot(31_000).blocked).toBe(false);
    expect(monitor.snapshot(31_001)).toMatchObject({ blocked: true, lastHeartbeatAt: null });
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
    monitor.markUnresponsive(2_000);
    monitor.markResponsive(12_001);
    expect(monitor.snapshot(12_002).reasons).toContain('renderer was unresponsive for more than 10 seconds');
  });

  it('does not block on a short completed unresponsive incident', () => {
    const monitor = new RendererHeartbeatMonitor(0);
    monitor.recordHeartbeat({ receivedAt: 1_000 });
    monitor.markUnresponsive(2_000);
    monitor.markResponsive(11_999);
    expect(monitor.snapshot(12_000).blocked).toBe(false);
  });
});
