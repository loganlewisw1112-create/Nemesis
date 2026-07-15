export interface RendererMemorySample {
  at: number;
  workingSetKb: number;
  rendererPid?: number;
  heartbeatAgeMs?: number;
  unresponsiveForMs?: number;
  painted?: boolean;
}

export interface RendererMemoryPolicy {
  warningWorkingSetKb: number;
  blockingWorkingSetKb: number;
  consecutiveWarningSamples: number;
  trendWindowMs: number;
  trendGrowthLimit: number;
  slopeWindowMs: number;
  slopeLimitPerHour: number;
  baselineMultiplierLimit: number;
  heartbeatMaxAgeMs: number;
  unresponsiveMaxMs: number;
  maxRetainedSamples: number;
}

export interface RendererMemoryAssessment {
  status: 'warming' | 'stable' | 'unstable-growth';
  sampleCount: number;
  growthRate: number;
  detail: string;
  blocked: boolean;
  reasons: string[];
  baselineKb: number | null;
  workingSetKb: number | null;
  p95WorkingSetKb: number | null;
  slopePerHour: number;
  rendererPid: number | null;
}

export const DEFAULT_RENDERER_MEMORY_POLICY: Readonly<RendererMemoryPolicy> = Object.freeze({
  warningWorkingSetKb: 384 * 1024,
  blockingWorkingSetKb: 512 * 1024,
  consecutiveWarningSamples: 3,
  trendWindowMs: 10 * 60_000,
  trendGrowthLimit: 0.10,
  slopeWindowMs: 30 * 60_000,
  slopeLimitPerHour: 0.02,
  baselineMultiplierLimit: 1.5,
  heartbeatMaxAgeMs: 15_000,
  unresponsiveMaxMs: 10_000,
  maxRetainedSamples: 2_000,
});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function endpointGrowth(samples: readonly RendererMemorySample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!.workingSetKb;
  return first > 0 ? (samples.at(-1)!.workingSetKb - first) / first : 0;
}

/** Returns the least-squares working-set slope, normalized to baseline per hour. */
function normalizedSlopePerHour(samples: readonly RendererMemorySample[], baselineKb: number): number {
  if (samples.length < 2 || baselineKb <= 0) return 0;
  const origin = samples[0]!.at;
  const xs = samples.map((sample) => (sample.at - origin) / 3_600_000);
  const ys = samples.map((sample) => sample.workingSetKb);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index]! - meanX) * (ys[index]! - meanY);
    denominator += (xs[index]! - meanX) ** 2;
  }
  return denominator > 0 ? (numerator / denominator) / baselineKb : 0;
}

/**
 * Continuously evaluates renderer memory. A stable result is a current lease,
 * never a permanent pass: callers must keep sampling for the whole app session.
 */
export class RendererMemoryMonitor {
  private readonly samples: RendererMemorySample[] = [];
  private readonly policy: RendererMemoryPolicy;
  private baselineKb: number | null = null;
  private rendererPid: number | null = null;
  private stickyReasons = new Set<string>();

  constructor(
    private readonly warmupMs = 5 * 60_000,
    private readonly requiredBaselineSamples = 10,
    policy: Partial<RendererMemoryPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_RENDERER_MEMORY_POLICY, ...policy };
  }

  add(sample: RendererMemorySample): RendererMemoryAssessment {
    if (!Number.isFinite(sample.at) || !Number.isFinite(sample.workingSetKb) || sample.workingSetKb <= 0) {
      return this.assessment('warming', ['invalid renderer memory sample ignored']);
    }

    const reasons: string[] = [];
    if (sample.rendererPid != null) {
      if (this.rendererPid != null && sample.rendererPid !== this.rendererPid) {
        reasons.push(`renderer PID changed from ${this.rendererPid} to ${sample.rendererPid}`);
      }
      this.rendererPid ??= sample.rendererPid;
    }
    if ((sample.heartbeatAgeMs ?? 0) > this.policy.heartbeatMaxAgeMs) {
      reasons.push(`renderer heartbeat is ${Math.round(sample.heartbeatAgeMs!)}ms old`);
    }
    if ((sample.unresponsiveForMs ?? 0) > this.policy.unresponsiveMaxMs) {
      reasons.push(`renderer has been unresponsive for ${Math.round(sample.unresponsiveForMs!)}ms`);
    }

    this.samples.push(sample);
    if (this.samples.length > this.policy.maxRetainedSamples) {
      this.samples.splice(0, this.samples.length - this.policy.maxRetainedSamples);
    }

    const firstAt = this.samples[0]!.at;
    const baselineCandidates = this.samples.filter((item) => item.at - firstAt >= this.warmupMs);
    if (this.baselineKb == null && baselineCandidates.length >= this.requiredBaselineSamples) {
      this.baselineKb = median(baselineCandidates.slice(0, this.requiredBaselineSamples).map((item) => item.workingSetKb));
    }

    if (sample.painted !== false && sample.workingSetKb > this.policy.blockingWorkingSetKb) {
      reasons.push(`renderer working set ${Math.round(sample.workingSetKb / 1024)}MB exceeds the 512MB hard limit`);
    }
    if (this.baselineKb != null && sample.workingSetKb > this.baselineKb * this.policy.baselineMultiplierLimit) {
      reasons.push(`renderer working set exceeds ${(this.policy.baselineMultiplierLimit * 100).toFixed(0)}% of baseline`);
    }

    const consecutive = this.samples.slice(-this.policy.consecutiveWarningSamples);
    if (
      consecutive.length === this.policy.consecutiveWarningSamples
      && consecutive.every((item) => item.workingSetKb > this.policy.warningWorkingSetKb)
    ) {
      reasons.push(`renderer working set exceeded 384MB for ${this.policy.consecutiveWarningSamples} consecutive samples`);
    }

    const trendStart = sample.at - this.policy.trendWindowMs;
    const trend = this.samples.filter((item) => item.at >= trendStart);
    const trendSpan = trend.length > 1 ? trend.at(-1)!.at - trend[0]!.at : 0;
    const growthRate = trendSpan >= this.policy.trendWindowMs * 0.9 ? endpointGrowth(trend) : 0;
    if (growthRate > this.policy.trendGrowthLimit) {
      reasons.push(`renderer working set grew ${(growthRate * 100).toFixed(1)}% over the rolling ten-minute window`);
    }

    let slopePerHour = 0;
    if (this.baselineKb != null) {
      const slopeStart = sample.at - this.policy.slopeWindowMs;
      const slopeWindow = this.samples.filter((item) => item.at >= slopeStart);
      const slopeSpan = slopeWindow.length > 1 ? slopeWindow.at(-1)!.at - slopeWindow[0]!.at : 0;
      if (slopeSpan >= this.policy.slopeWindowMs * 0.9) {
        slopePerHour = normalizedSlopePerHour(slopeWindow, this.baselineKb);
        if (slopePerHour > this.policy.slopeLimitPerHour) {
          reasons.push(`renderer projected slope ${(slopePerHour * 100).toFixed(2)}% of baseline per hour exceeds 2%`);
        }
      }
    }

    for (const reason of reasons) this.stickyReasons.add(reason);
    if (this.stickyReasons.size > 0) {
      return this.assessment('unstable-growth', [...this.stickyReasons], growthRate, slopePerHour);
    }
    if (this.baselineKb == null) {
      return this.assessment(
        'warming',
        [`waiting for ${this.requiredBaselineSamples} samples after the five-minute warm-up`],
        growthRate,
        slopePerHour,
      );
    }
    return this.assessment('stable', [], growthRate, slopePerHour);
  }

  snapshot(): RendererMemoryAssessment {
    if (this.stickyReasons.size > 0) return this.assessment('unstable-growth', [...this.stickyReasons]);
    if (this.baselineKb == null) return this.assessment('warming', ['renderer baseline is not established']);
    return this.assessment('stable', []);
  }

  private assessment(
    status: RendererMemoryAssessment['status'],
    reasons: string[],
    growthRate = 0,
    slopePerHour = 0,
  ): RendererMemoryAssessment {
    const workingSetKb = this.samples.at(-1)?.workingSetKb ?? null;
    const detail = status === 'stable'
      ? `renderer memory lease healthy; baseline ${Math.round((this.baselineKb ?? 0) / 1024)}MB, current ${Math.round((workingSetKb ?? 0) / 1024)}MB`
      : reasons.join('; ');
    return {
      status,
      sampleCount: this.samples.length,
      growthRate,
      detail,
      blocked: status === 'unstable-growth',
      reasons,
      baselineKb: this.baselineKb,
      workingSetKb,
      p95WorkingSetKb: percentile95(this.samples.map((item) => item.workingSetKb)),
      slopePerHour,
      rendererPid: this.rendererPid,
    };
  }
}
