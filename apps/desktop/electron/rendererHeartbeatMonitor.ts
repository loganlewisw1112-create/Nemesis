export interface RendererHeartbeatSnapshot {
  monitoringStartedAt: number;
  loadingGraceUntil: number;
  lastHeartbeatAt: number | null;
  lastRendererReportedAt: number | null;
  heartbeatAgeMs: number;
  unresponsiveForMs: number;
  painted: boolean;
  blocked: boolean;
  reasons: string[];
}

export interface RendererHeartbeatPolicy {
  heartbeatMaxAgeMs: number;
  unresponsiveMaxMs: number;
  startupGraceMs: number;
}

export const DEFAULT_RENDERER_HEARTBEAT_POLICY: Readonly<RendererHeartbeatPolicy> = Object.freeze({
  heartbeatMaxAgeMs: 15_000,
  unresponsiveMaxMs: 10_000,
  startupGraceMs: 30_000,
});

/** Main-renderer liveness evidence with sticky incident capture between memory samples. */
export class RendererHeartbeatMonitor {
  private readonly policy: RendererHeartbeatPolicy;
  private monitoringStartedAt: number;
  private lastHeartbeatAt: number | null = null;
  private lastRendererReportedAt: number | null = null;
  private unresponsiveAt: number | null = null;
  private painted = false;
  private readonly stickyReasons = new Set<string>();

  constructor(startedAt = Date.now(), policy: Partial<RendererHeartbeatPolicy> = {}) {
    this.monitoringStartedAt = startedAt;
    this.policy = { ...DEFAULT_RENDERER_HEARTBEAT_POLICY, ...policy };
  }

  reset(startedAt = Date.now()): void {
    this.monitoringStartedAt = startedAt;
    this.lastHeartbeatAt = null;
    this.lastRendererReportedAt = null;
    this.unresponsiveAt = null;
    this.painted = false;
    this.stickyReasons.clear();
  }

  recordHeartbeat(input: { receivedAt?: number; reportedAt?: number; painted?: boolean } = {}): void {
    const receivedAt = input.receivedAt ?? Date.now();
    if (this.lastHeartbeatAt != null && receivedAt - this.lastHeartbeatAt > this.policy.heartbeatMaxAgeMs) {
      this.stickyReasons.add('renderer heartbeat gap exceeded 15 seconds');
    }
    const reportedAt = Number.isFinite(input.reportedAt) && input.reportedAt! > 0
      && input.reportedAt! <= receivedAt + 5_000
      ? input.reportedAt!
      : null;
    if (reportedAt != null) {
      if (receivedAt - reportedAt > this.policy.heartbeatMaxAgeMs) {
        this.stickyReasons.add('renderer heartbeat IPC delivery exceeded 15 seconds');
      }
      if (this.lastRendererReportedAt != null
        && reportedAt > this.lastRendererReportedAt
        && reportedAt - this.lastRendererReportedAt > this.policy.heartbeatMaxAgeMs) {
        this.stickyReasons.add('renderer-reported heartbeat gap exceeded 15 seconds');
      }
      if (this.lastRendererReportedAt == null || reportedAt > this.lastRendererReportedAt) {
        this.lastRendererReportedAt = reportedAt;
      }
    }
    this.lastHeartbeatAt = receivedAt;
    this.painted ||= input.painted === true;
  }

  markUnresponsive(at = Date.now()): void {
    this.unresponsiveAt ??= at;
  }

  markResponsive(at = Date.now()): void {
    if (this.unresponsiveAt != null && at - this.unresponsiveAt > this.policy.unresponsiveMaxMs) {
      this.stickyReasons.add('renderer was unresponsive for more than 10 seconds');
    }
    this.unresponsiveAt = null;
  }

  markRendererGone(): void {
    this.stickyReasons.add('renderer process exited');
  }

  snapshot(now = Date.now()): RendererHeartbeatSnapshot {
    const loadingGraceUntil = this.monitoringStartedAt + this.policy.startupGraceMs;
    const heartbeatAgeMs = this.lastHeartbeatAt == null
      ? Math.max(0, now - this.monitoringStartedAt)
      : Math.max(0, now - this.lastHeartbeatAt);
    const unresponsiveForMs = this.unresponsiveAt == null ? 0 : Math.max(0, now - this.unresponsiveAt);
    if (this.lastHeartbeatAt == null && now > loadingGraceUntil) {
      this.stickyReasons.add('renderer heartbeat was absent after the startup loading grace');
    } else if (this.lastHeartbeatAt != null && heartbeatAgeMs > this.policy.heartbeatMaxAgeMs) {
      this.stickyReasons.add('renderer heartbeat gap exceeded 15 seconds');
    }
    if (unresponsiveForMs > this.policy.unresponsiveMaxMs) {
      this.stickyReasons.add('renderer was unresponsive for more than 10 seconds');
    }
    return {
      monitoringStartedAt: this.monitoringStartedAt,
      loadingGraceUntil,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastRendererReportedAt: this.lastRendererReportedAt,
      heartbeatAgeMs,
      unresponsiveForMs,
      painted: this.painted,
      blocked: this.stickyReasons.size > 0,
      reasons: [...this.stickyReasons],
    };
  }
}
