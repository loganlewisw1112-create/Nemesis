/**
 * Rolling health attestations: each sample asserts "this subsystem was healthy
 * at time T and that claim is good until validUntil", and the tracker reports
 * what fraction of the expected samples actually arrived healthy.
 *
 * Renamed from `OperationalLeaseTracker` on 2026-07-31. "Lease" invited the
 * reading that this grants exclusive ownership of something and would stop a
 * second process running -- it does not, and never did. Mutual exclusion is
 * `app.requestSingleInstanceLock()` in main.ts. The `lease` field name in
 * `RuntimeHealthSnapshot` is deliberately unchanged, because that one is
 * broadcast and persisted.
 */
export type HealthAttestationStatus = 'healthy' | 'degraded' | 'failed';

export interface CampaignHealthAttestationV2 {
  schemaVersion: 2;
  name: string;
  status: HealthAttestationStatus;
  observedAt: number;
  validUntil: number;
  metrics: Readonly<Record<string, number | string | boolean | null>>;
  action: string;
  stickyFailure: boolean;
}

export interface HealthAttestationCoverage {
  expectedSamples: number;
  observedSamples: number;
  healthySamples: number;
  sampleCoverage: number;
  healthyCoverage: number;
  current: CampaignHealthAttestationV2 | null;
  qualificationReady: boolean;
}

export class HealthAttestationTracker {
  private readonly samples: CampaignHealthAttestationV2[] = [];
  private stickyFailure = false;

  constructor(
    private readonly name: string,
    private readonly ttlMs = 15_000,
    private readonly maxRetainedSamples = 10_000,
  ) {}

  issue(input: {
    status: HealthAttestationStatus;
    observedAt?: number;
    metrics?: CampaignHealthAttestationV2['metrics'];
    action?: string;
    stickyFailure?: boolean;
  }): CampaignHealthAttestationV2 {
    const observedAt = input.observedAt ?? Date.now();
    this.stickyFailure ||= input.stickyFailure === true || input.status === 'failed';
    const lease: CampaignHealthAttestationV2 = Object.freeze({
      schemaVersion: 2,
      name: this.name,
      status: this.stickyFailure ? 'failed' : input.status,
      observedAt,
      validUntil: observedAt + this.ttlMs,
      metrics: Object.freeze({ ...(input.metrics ?? {}) }),
      action: input.action ?? 'none',
      stickyFailure: this.stickyFailure,
    });
    this.samples.push(lease);
    if (this.samples.length > this.maxRetainedSamples) {
      this.samples.splice(0, this.samples.length - this.maxRetainedSamples);
    }
    return lease;
  }

  current(now = Date.now()): CampaignHealthAttestationV2 | null {
    const latest = this.samples.at(-1) ?? null;
    if (!latest || latest.validUntil < now) return null;
    return latest;
  }

  coverage(runStartedAt: number, now: number, expectedIntervalMs = 5_000): HealthAttestationCoverage {
    const expectedSamples = Math.max(1, Math.floor(Math.max(0, now - runStartedAt) / expectedIntervalMs) + 1);
    const observed = this.samples.filter((sample) => sample.observedAt >= runStartedAt && sample.observedAt <= now);
    const healthySamples = observed.filter((sample) => sample.status === 'healthy' && !sample.stickyFailure).length;
    const sampleCoverage = Math.min(1, observed.length / expectedSamples);
    const healthyCoverage = Math.min(1, healthySamples / expectedSamples);
    const current = this.current(now);
    return {
      expectedSamples,
      observedSamples: observed.length,
      healthySamples,
      sampleCoverage,
      healthyCoverage,
      current,
      qualificationReady: sampleCoverage >= 0.95
        && healthyCoverage >= 0.95
        && current?.status === 'healthy'
        && !current.stickyFailure,
    };
  }

  history(): readonly CampaignHealthAttestationV2[] {
    return this.samples;
  }
}
