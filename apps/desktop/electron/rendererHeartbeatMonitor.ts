export interface RendererHeartbeatSnapshot {
  loadStartedAt: number;
  loadFinishedAt: number | null;
  monitoringStartedAt: number | null;
  loadingGraceUntil: number;
  lastHeartbeatAt: number | null;
  firstHeartbeatAt: number | null;
  firstPaintedAt: number | null;
  lastRendererReportedAt: number | null;
  lastHeartbeatSequence: number | null;
  heartbeatAgeMs: number;
  unresponsiveForMs: number;
  heartbeatSendFailures: number;
  lastProbeSentAt: number | null;
  lastProbeResponseAt: number | null;
  lastProbeSequence: number | null;
  probeAgeMs: number;
  probeResponseReceived: boolean;
  painted: boolean;
  blocked: boolean;
  reasons: string[];
}

export interface RendererHeartbeatPolicy {
  heartbeatMaxAgeMs: number;
  probeMaxAgeMs: number;
  unresponsiveMaxMs: number;
  startupGraceMs: number;
}

export const DEFAULT_RENDERER_HEARTBEAT_POLICY: Readonly<RendererHeartbeatPolicy> = Object.freeze({
  heartbeatMaxAgeMs: 15_000,
  probeMaxAgeMs: 15_000,
  unresponsiveMaxMs: 10_000,
  startupGraceMs: 30_000,
});

/** Main-renderer liveness evidence with sticky incident capture between memory samples. */
export class RendererHeartbeatMonitor {
  private readonly policy: RendererHeartbeatPolicy;
  private loadStartedAt: number;
  private loadFinishedAt: number | null = null;
  private monitoringStartedAt: number | null = null;
  private lastHeartbeatAt: number | null = null;
  private firstHeartbeatAt: number | null = null;
  private firstPaintedAt: number | null = null;
  private lastRendererReportedAt: number | null = null;
  private lastHeartbeatSequence: number | null = null;
  private unresponsiveAt: number | null = null;
  private heartbeatSendFailures = 0;
  private lastProbeSentAt: number | null = null;
  private lastProbeResponseAt: number | null = null;
  private lastProbeSequence: number | null = null;
  private lastProbeResponseSequence: number | null = null;
  private readonly sentProbes = new Map<number, number>();
  private painted = false;
  private readonly stickyReasons = new Set<string>();

  constructor(startedAt = Date.now(), policy: Partial<RendererHeartbeatPolicy> = {}) {
    this.loadStartedAt = startedAt;
    this.policy = { ...DEFAULT_RENDERER_HEARTBEAT_POLICY, ...policy };
  }

  reset(startedAt = Date.now()): void {
    this.loadStartedAt = startedAt;
    this.loadFinishedAt = null;
    this.monitoringStartedAt = null;
    this.lastHeartbeatAt = null;
    this.firstHeartbeatAt = null;
    this.firstPaintedAt = null;
    this.lastRendererReportedAt = null;
    this.lastHeartbeatSequence = null;
    this.unresponsiveAt = null;
    this.heartbeatSendFailures = 0;
    this.lastProbeSentAt = null;
    this.lastProbeResponseAt = null;
    this.lastProbeSequence = null;
    this.lastProbeResponseSequence = null;
    this.sentProbes.clear();
    this.painted = false;
    this.stickyReasons.clear();
  }

  markLoadFinished(at = Date.now()): void {
    this.loadFinishedAt = at;
    this.monitoringStartedAt = at;
  }

  markLoadFailed(reason = 'renderer failed to finish loading'): void {
    this.stickyReasons.add(reason);
  }

  recordHeartbeat(input: {
    receivedAt?: number;
    reportedAt?: number;
    painted?: boolean;
    sequence?: number;
  } = {}): void {
    const receivedAt = input.receivedAt ?? Date.now();
    const monitoring = this.loadFinishedAt != null;
    if (monitoring && this.lastHeartbeatAt != null && receivedAt - this.lastHeartbeatAt > this.policy.heartbeatMaxAgeMs) {
      this.stickyReasons.add('renderer heartbeat gap exceeded 15 seconds');
    }
    if (Number.isInteger(input.sequence) && input.sequence! > 0) {
      if (this.lastHeartbeatSequence != null && input.sequence! <= this.lastHeartbeatSequence) {
        this.stickyReasons.add('renderer heartbeat sequence regressed or duplicated');
      }
      this.lastHeartbeatSequence = input.sequence!;
    }
    const reportedAt = Number.isFinite(input.reportedAt) && input.reportedAt! > 0
      && input.reportedAt! <= receivedAt + 5_000
      ? input.reportedAt!
      : null;
    if (reportedAt != null) {
      if (monitoring && receivedAt - reportedAt > this.policy.heartbeatMaxAgeMs) {
        this.stickyReasons.add('renderer heartbeat IPC delivery exceeded 15 seconds');
      }
      if (this.lastRendererReportedAt != null
        && reportedAt > this.lastRendererReportedAt
        && reportedAt - this.lastRendererReportedAt > this.policy.heartbeatMaxAgeMs) {
        if (monitoring) this.stickyReasons.add('renderer-reported heartbeat gap exceeded 15 seconds');
      }
      if (this.lastRendererReportedAt == null || reportedAt > this.lastRendererReportedAt) {
        this.lastRendererReportedAt = reportedAt;
      }
    }
    this.firstHeartbeatAt ??= receivedAt;
    if (!this.painted && input.painted === true) this.firstPaintedAt = receivedAt;
    this.lastHeartbeatAt = receivedAt;
    this.painted ||= input.painted === true;
  }

  recordHeartbeatSendFailure(): void {
    this.heartbeatSendFailures += 1;
    this.stickyReasons.add('renderer heartbeat send failed');
  }

  recordProbeSent(sentAt = Date.now(), sequence = 0): void {
    this.lastProbeSentAt = sentAt;
    if (sequence > 0) {
      this.lastProbeSequence = sequence;
      this.sentProbes.set(sequence, sentAt);
      while (this.sentProbes.size > 16) {
        const oldest = this.sentProbes.keys().next().value;
        if (oldest == null) break;
        this.sentProbes.delete(oldest);
      }
    }
  }

  recordProbeResponse(input: { receivedAt?: number; sentAt?: number; sequence?: number } = {}): void {
    const receivedAt = input.receivedAt ?? Date.now();
    const sequence = Number.isInteger(input.sequence) ? input.sequence! : null;
    const expectedSentAt = sequence == null ? null : this.sentProbes.get(sequence) ?? null;
    // IPC delivery can reorder responses when the renderer is busy. Validate
    // the response against a probe that was actually sent, not only the most
    // recently sent sequence. Unknown sequences remain a blocking failure.
    if (sequence != null && expectedSentAt == null) {
      this.stickyReasons.add('renderer probe sequence did not match the latest probe');
      return;
    }
    const effectiveSentAt = expectedSentAt ?? input.sentAt ?? null;
    if (input.sentAt != null && expectedSentAt != null && input.sentAt !== expectedSentAt) {
      this.stickyReasons.add('renderer probe sequence did not match the latest probe');
      return;
    }
    if (effectiveSentAt != null && receivedAt - effectiveSentAt > this.policy.probeMaxAgeMs) {
      this.stickyReasons.add('renderer probe response exceeded 15 seconds');
    }
    if (sequence == null || this.lastProbeResponseSequence == null || sequence >= this.lastProbeResponseSequence) {
      this.lastProbeResponseAt = receivedAt;
      this.lastProbeResponseSequence = sequence;
    }
  }

  markUnresponsive(at = Date.now()): void {
    this.unresponsiveAt ??= at;
  }

  markResponsive(at = Date.now()): void {
    if (this.loadFinishedAt != null
      && this.unresponsiveAt != null
      && at - this.unresponsiveAt > this.policy.unresponsiveMaxMs) {
      this.stickyReasons.add('renderer was unresponsive for more than 10 seconds');
    }
    this.unresponsiveAt = null;
  }

  markRendererGone(): void {
    this.stickyReasons.add('renderer process exited');
  }

  snapshot(now = Date.now()): RendererHeartbeatSnapshot {
    const loadingGraceUntil = (this.monitoringStartedAt ?? this.loadStartedAt) + this.policy.startupGraceMs;
    const heartbeatAgeMs = this.lastHeartbeatAt == null
      ? Math.max(0, now - (this.monitoringStartedAt ?? this.loadStartedAt))
      : Math.max(0, now - this.lastHeartbeatAt);
    const probeAgeMs = this.lastProbeResponseAt == null
      ? (this.lastProbeSentAt == null ? 0 : Math.max(0, now - this.lastProbeSentAt))
      : Math.max(0, now - this.lastProbeResponseAt);
    const unresponsiveForMs = this.unresponsiveAt == null ? 0 : Math.max(0, now - this.unresponsiveAt);
    // The heartbeat grace window begins only after did-finish-load. A load
    // failure is recorded by the browser event; a slow load must not be
    // mistaken for a stale heartbeat before the page exists.
    if (this.loadFinishedAt != null && this.lastHeartbeatAt == null && now > loadingGraceUntil) {
      this.stickyReasons.add('renderer heartbeat was absent after the startup loading grace');
    } else if (this.lastHeartbeatAt != null && heartbeatAgeMs > this.policy.heartbeatMaxAgeMs) {
      this.stickyReasons.add('renderer heartbeat gap exceeded 15 seconds');
    }
    // A probe is allowed its normal response window.  Treat a missing response
    // as stale only after the elapsed time since the latest probe exceeds the
    // limit; otherwise the first probe would invalidate startup immediately.
    const latestProbeWasAnswered = this.lastProbeSequence == null
      || this.lastProbeResponseSequence === this.lastProbeSequence;
    const latestProbeAgeMs = this.lastProbeSentAt == null ? 0 : Math.max(0, now - this.lastProbeSentAt);
    if (this.lastProbeSentAt != null
      && ((!latestProbeWasAnswered && latestProbeAgeMs > this.policy.probeMaxAgeMs)
        || probeAgeMs > this.policy.probeMaxAgeMs)) {
      this.stickyReasons.add('renderer probe response was absent or stale');
    }
    if (this.loadFinishedAt != null && unresponsiveForMs > this.policy.unresponsiveMaxMs) {
      this.stickyReasons.add('renderer was unresponsive for more than 10 seconds');
    }
    return {
      loadStartedAt: this.loadStartedAt,
      loadFinishedAt: this.loadFinishedAt,
      monitoringStartedAt: this.monitoringStartedAt,
      loadingGraceUntil,
      lastHeartbeatAt: this.lastHeartbeatAt,
      firstHeartbeatAt: this.firstHeartbeatAt,
      firstPaintedAt: this.firstPaintedAt,
      lastRendererReportedAt: this.lastRendererReportedAt,
      lastHeartbeatSequence: this.lastHeartbeatSequence,
      heartbeatAgeMs,
      unresponsiveForMs,
      heartbeatSendFailures: this.heartbeatSendFailures,
      lastProbeSentAt: this.lastProbeSentAt,
      lastProbeResponseAt: this.lastProbeResponseAt,
      lastProbeSequence: this.lastProbeSequence,
      probeAgeMs,
      probeResponseReceived: this.lastProbeResponseAt != null,
      painted: this.painted,
      blocked: this.stickyReasons.size > 0,
      reasons: [...this.stickyReasons],
    };
  }
}
