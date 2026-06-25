import type { BrainRole } from '@nemesis/bridge-contracts';
import type { BrainClusterSnapshot, BrainFailoverEvent, BrainInstance } from './types.js';

export interface HealthSupervisorOptions {
  heartbeatTimeoutMs?: number;
  maxMissedHeartbeats?: number;
}

const FAILOVER_ORDER: BrainRole[] = ['standby-a', 'standby-b', 'standby-c', 'emergency'];

export class HealthSupervisor {
  private readonly instances = new Map<string, BrainInstance>();
  private activeRole: BrainRole | 'standalone' = 'primary';
  private readonly failoverEvents: BrainFailoverEvent[] = [];
  private readonly heartbeatTimeoutMs: number;
  private readonly maxMissedHeartbeats: number;

  constructor(instances: BrainInstance[], options: HealthSupervisorOptions = {}) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 5_000;
    this.maxMissedHeartbeats = options.maxMissedHeartbeats ?? 3;
    for (const instance of instances) this.instances.set(instance.id, { ...instance });
  }

  recordHeartbeat(
    id: string,
    now = Date.now(),
    metrics: Partial<Pick<BrainInstance, 'latency_ms' | 'packet_rate' | 'error_rate'>> = {},
  ): BrainInstance | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    instance.last_heartbeat = now;
    instance.missed_heartbeats = 0;
    instance.latency_ms = metrics.latency_ms ?? instance.latency_ms;
    instance.packet_rate = metrics.packet_rate ?? instance.packet_rate;
    instance.error_rate = metrics.error_rate ?? instance.error_rate;
    if (instance.status === 'STALE' || instance.status === 'DEGRADED') {
      instance.status = instance.role === this.activeRole ? 'HEALTHY' : 'STANDBY_READY';
    }
    return { ...instance };
  }

  quarantine(id: string, reason: string, now = Date.now()): BrainFailoverEvent | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    instance.status = 'QUARANTINED';
    if (instance.role === this.activeRole) return this.promote(instance.role, reason, now);
    return null;
  }

  checkHealth(now = Date.now()): BrainClusterSnapshot {
    for (const instance of this.instances.values()) {
      if (now - instance.last_heartbeat <= this.heartbeatTimeoutMs) continue;
      instance.missed_heartbeats = Math.max(
        instance.missed_heartbeats,
        Math.floor((now - instance.last_heartbeat) / this.heartbeatTimeoutMs),
      );
      if (
        instance.role === this.activeRole
        && instance.missed_heartbeats >= this.maxMissedHeartbeats
        && instance.status !== 'QUARANTINED'
      ) {
        instance.status = 'STALE';
      }
    }

    const active = this.findByRole(this.activeRole);
    if (!active || ['STALE', 'OFFLINE', 'UNSAFE', 'QUARANTINED'].includes(active.status)) {
      this.promote((active?.role ?? 'primary') as BrainRole, `${active?.role ?? 'primary'} missed ${this.maxMissedHeartbeats} heartbeats`, now);
    }

    return this.snapshot();
  }

  snapshot(): BrainClusterSnapshot {
    return {
      activeRole: this.activeRole,
      instances: [...this.instances.values()].map((instance) => ({ ...instance })),
      failoverEvents: [...this.failoverEvents],
    };
  }

  private promote(fromRole: BrainRole, reason: string, now: number): BrainFailoverEvent {
    const target = FAILOVER_ORDER
      .map((role) => this.findByRole(role))
      .find((instance): instance is BrainInstance => {
        if (!instance) return false;
        return instance.status === 'HEALTHY'
          || instance.status === 'STANDBY_READY'
          || instance.status === 'PROMOTED';
      });
    this.activeRole = target?.role ?? 'standalone';
    if (target) target.status = 'PROMOTED';
    const event: BrainFailoverEvent = {
      id: `failover-${now}-${this.failoverEvents.length + 1}`,
      from_role: fromRole,
      to_role: this.activeRole,
      reason,
      timestamp: now,
    };
    this.failoverEvents.push(event);
    return event;
  }

  private findByRole(role: BrainRole | 'standalone'): BrainInstance | undefined {
    if (role === 'standalone') return undefined;
    return [...this.instances.values()].find((instance) => instance.role === role);
  }
}
