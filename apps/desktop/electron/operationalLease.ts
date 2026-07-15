export type OperationalLeaseStatus = 'healthy' | 'degraded' | 'failed';

export interface CampaignOperationalLeaseV2 {
  schemaVersion: 2;
  name: string;
  status: OperationalLeaseStatus;
  observedAt: number;
  validUntil: number;
  metrics: Readonly<Record<string, number | string | boolean | null>>;
  action: string;
  stickyFailure: boolean;
}

export interface OperationalLeaseCoverage {
  expectedSamples: number;
  observedSamples: number;
  healthySamples: number;
  sampleCoverage: number;
  healthyCoverage: number;
  current: CampaignOperationalLeaseV2 | null;
  qualificationReady: boolean;
}

export class OperationalLeaseTracker {
  private readonly samples: CampaignOperationalLeaseV2[] = [];
  private stickyFailure = false;

  constructor(
    private readonly name: string,
    private readonly ttlMs = 15_000,
    private readonly maxRetainedSamples = 10_000,
  ) {}

  issue(input: {
    status: OperationalLeaseStatus;
    observedAt?: number;
    metrics?: CampaignOperationalLeaseV2['metrics'];
    action?: string;
    stickyFailure?: boolean;
  }): CampaignOperationalLeaseV2 {
    const observedAt = input.observedAt ?? Date.now();
    this.stickyFailure ||= input.stickyFailure === true || input.status === 'failed';
    const lease: CampaignOperationalLeaseV2 = Object.freeze({
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

  current(now = Date.now()): CampaignOperationalLeaseV2 | null {
    const latest = this.samples.at(-1) ?? null;
    if (!latest || latest.validUntil < now) return null;
    return latest;
  }

  coverage(runStartedAt: number, now: number, expectedIntervalMs = 5_000): OperationalLeaseCoverage {
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

  history(): readonly CampaignOperationalLeaseV2[] {
    return this.samples;
  }
}
