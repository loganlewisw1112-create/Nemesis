import type { RendererMemoryAssessment } from './rendererMemoryMonitor.js';
import { OperationalLeaseTracker, type CampaignOperationalLeaseV2 } from './operationalLease.js';

export type RuntimeComponentName =
  | 'rest-markets'
  | 'trade-tape'
  | 'ticker-websocket'
  | 'orderbook-websocket'
  | 'bridge'
  | 'gea';

export interface RuntimeComponentHealth {
  name: RuntimeComponentName;
  connected: boolean;
  qualificationReady: boolean;
  /** Orderbook-specific readiness: the complete unique live tracking set exists. */
  trackingReady?: boolean;
  lastSuccessAt: number | null;
  lastPingAt?: number | null;
  lastPongAt?: number | null;
  retryAt?: number | null;
  failureClass?: string | null;
  successes?: number;
  failures?: number;
  /** Component-specific evidence TTL. REST/trades are 30s, WebSockets 25s, bridge/GEA 15s. */
  maxAgeMs?: number;
}

export interface RuntimeProcessHealth {
  nemesisResponsive: boolean;
  geaRunning: boolean;
}

export type RuntimeControlState = 'warming' | 'healthy' | 'recovering' | 'invalidated';

export interface RuntimeHealthDecision {
  state: RuntimeControlState;
  pauseEvidence: boolean;
  invalidated: boolean;
  reasons: string[];
  action: 'none' | 'pause' | 'resume' | 'invalidate';
  lease: CampaignOperationalLeaseV2;
  recoveryCount: number;
}

export interface RuntimeHealthPolicy {
  componentMaxAgeMs: number;
  recoveryTimeoutMs: number;
  recoveryWindowMs: number;
  maxRecoveriesPerWindow: number;
  healthySnapshotsToResume: number;
  leaseTtlMs: number;
}

const DEFAULT_POLICY: Readonly<RuntimeHealthPolicy> = Object.freeze({
  componentMaxAgeMs: 15_000,
  recoveryTimeoutMs: 30_000,
  recoveryWindowMs: 10 * 60_000,
  maxRecoveriesPerWindow: 3,
  healthySnapshotsToResume: 3,
  leaseTtlMs: 15_000,
});

export class RuntimeHealthController {
  private readonly policy: RuntimeHealthPolicy;
  private readonly leases: OperationalLeaseTracker;
  private state: RuntimeControlState = 'warming';
  private recoveringAt: number | null = null;
  private healthyStreak = 0;
  private recoveryStarts: number[] = [];
  private totalRecoveryCount = 0;
  private invalidationReasons: string[] = [];

  constructor(policy: Partial<RuntimeHealthPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.leases = new OperationalLeaseTracker('runtime_health', this.policy.leaseTtlMs);
  }

  observe(input: {
    at?: number;
    components: readonly RuntimeComponentHealth[];
    renderer: RendererMemoryAssessment;
    process: RuntimeProcessHealth;
  }): RuntimeHealthDecision {
    const at = input.at ?? Date.now();
    const recoverableReasons = input.components.flatMap((component) => {
      const age = component.lastSuccessAt == null ? Number.POSITIVE_INFINITY : at - component.lastSuccessAt;
      const maxAgeMs = component.maxAgeMs ?? this.policy.componentMaxAgeMs;
      return component.connected && component.qualificationReady && age <= maxAgeMs
        ? []
        : [`${component.name} is not qualification-ready${Number.isFinite(age) ? ` (${Math.round(age)}ms old)` : ''}`];
    });
    const blockingReasons = [
      ...(input.renderer.blocked ? input.renderer.reasons : []),
      ...(!input.process.geaRunning ? ['GEA process exited'] : []),
      ...(!input.process.nemesisResponsive ? ['NEMESIS became unresponsive'] : []),
    ];

    if (blockingReasons.length > 0) {
      return this.invalidate(at, blockingReasons);
    }
    if (this.state === 'invalidated') return this.decision(at, 'invalidate', this.invalidationReasons);

    // Startup is not a recovery. Qualification remains paused until every
    // required component has established one complete healthy snapshot.
    if (this.state === 'warming') {
      if (recoverableReasons.length > 0) {
        return this.decision(at, 'pause', recoverableReasons);
      }
      this.state = 'healthy';
      return this.decision(at, 'resume', []);
    }

    if (recoverableReasons.length > 0) {
      this.healthyStreak = 0;
      if (this.state !== 'recovering') {
        this.state = 'recovering';
        this.recoveringAt = at;
        this.recoveryStarts.push(at);
        this.totalRecoveryCount += 1;
        this.recoveryStarts = this.recoveryStarts.filter((startedAt) => at - startedAt <= this.policy.recoveryWindowMs);
      }
      if (this.recoveryStarts.length >= this.policy.maxRecoveriesPerWindow) {
        return this.invalidate(at, [`${this.recoveryStarts.length} recoveries occurred within ten minutes`]);
      }
      if (this.recoveringAt != null && at - this.recoveringAt >= this.policy.recoveryTimeoutMs) {
        return this.invalidate(at, [`runtime recovery exceeded ${this.policy.recoveryTimeoutMs}ms`, ...recoverableReasons]);
      }
      return this.decision(at, 'pause', recoverableReasons);
    }

    if (this.state === 'recovering') {
      this.healthyStreak += 1;
      if (this.healthyStreak < this.policy.healthySnapshotsToResume) {
        return this.decision(at, 'pause', [`waiting for ${this.policy.healthySnapshotsToResume - this.healthyStreak} healthy snapshots`]);
      }
      this.state = 'healthy';
      this.recoveringAt = null;
      this.healthyStreak = 0;
      return this.decision(at, 'resume', []);
    }
    return this.decision(at, 'none', []);
  }

  private invalidate(at: number, reasons: string[]): RuntimeHealthDecision {
    this.state = 'invalidated';
    this.invalidationReasons = [...new Set([...this.invalidationReasons, ...reasons])];
    return this.decision(at, 'invalidate', this.invalidationReasons);
  }

  private decision(at: number, action: RuntimeHealthDecision['action'], reasons: string[]): RuntimeHealthDecision {
    const status = this.state === 'invalidated'
      ? 'failed'
      : this.state === 'recovering' || this.state === 'warming'
        ? 'degraded'
        : 'healthy';
    const lease = this.leases.issue({
      status,
      observedAt: at,
      metrics: { recoveryCount: this.totalRecoveryCount, recentRecoveryCount: this.recoveryStarts.length, reasonCount: reasons.length },
      action,
      stickyFailure: this.state === 'invalidated',
    });
    return {
      state: this.state,
      pauseEvidence: this.state !== 'healthy',
      invalidated: this.state === 'invalidated',
      reasons,
      action,
      lease,
      recoveryCount: this.totalRecoveryCount,
    };
  }
}
