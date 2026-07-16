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
  slopeWindowComplete: boolean;
  slopeWindowMs: number;
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

function rollingWindowGrowth(samples: readonly RendererMemorySample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples.at(-1)!;
  if (samples.length < 6) {
    return first.workingSetKb > 0
      ? (last.workingSetKb - first.workingSetKb) / first.workingSetKb
      : 0;
  }

  // A renderer working-set sample can briefly fall during garbage collection.
  // Comparing one endpoint to another turns that harmless trough into a sticky
  // failure ten minutes later. Split-half medians retain the ten-minute growth
  // meaning while making the gate resistant to one-sample GC noise.
  const midpointAt = first.at + ((last.at - first.at) / 2);
  const early = samples.filter((sample) => sample.at <= midpointAt);
  const late = samples.filter((sample) => sample.at > midpointAt);
  if (early.length === 0 || late.length === 0) return 0;

  const earlyWorkingSet = median(early.map((sample) => sample.workingSetKb));
  const lateWorkingSet = median(late.map((sample) => sample.workingSetKb));
  const earlyAt = median(early.map((sample) => sample.at));
  const lateAt = median(late.map((sample) => sample.at));
  const centerSpanMs = lateAt - earlyAt;
  const fullSpanMs = last.at - first.at;
  if (earlyWorkingSet <= 0 || centerSpanMs <= 0 || fullSpanMs <= 0) return 0;

  return ((lateWorkingSet - earlyWorkingSet) / earlyWorkingSet) * (fullSpanMs / centerSpanMs);
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
  private latestSlopePerHour = 0;
  private latestSlopeWindowMs = 0;

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
    const warmupCutoffAt = firstAt + this.warmupMs;
    const baselineCandidates = this.samples.filter((item) => item.at >= warmupCutoffAt);
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
    // Startup allocation is intentionally excluded. The ten-minute growth gate
    // becomes eligible only after a full post-warm-up trend window exists.
    const trend = this.samples.filter((item) => item.at >= Math.max(trendStart, warmupCutoffAt));
    const trendSpan = trend.length > 1 ? trend.at(-1)!.at - trend[0]!.at : 0;
    const growthRate = trendSpan >= this.policy.trendWindowMs * 0.9 ? rollingWindowGrowth(trend) : 0;
    if (growthRate > this.policy.trendGrowthLimit) {
      reasons.push(`renderer working set grew ${(growthRate * 100).toFixed(1)}% over the rolling ten-minute window`);
    }

    let slopePerHour = 0;
    if (this.baselineKb != null) {
      // The projected slope describes sustained post-warm-up behavior. Startup
      // allocation must not enter this regression, and the gate is not eligible
      // until a complete thirty-minute observation window exists.
      const slopeStart = Math.max(sample.at - this.policy.slopeWindowMs, warmupCutoffAt);
      const postWarmupSamples = this.samples.filter((item) => item.at >= warmupCutoffAt);
      const firstInsideIndex = postWarmupSamples.findIndex((item) => item.at >= slopeStart);
      // Scheduler jitter can put the first boundary sample milliseconds before
      // the nominal cutoff. Retain that one predecessor so a genuinely complete
      // window cannot flap back to incomplete at the next sample.
      const slopeWindow = firstInsideIndex <= 0
        ? postWarmupSamples
        : postWarmupSamples.slice(firstInsideIndex - 1);
      const slopeSpan = slopeWindow.length > 1 ? slopeWindow.at(-1)!.at - slopeWindow[0]!.at : 0;
      this.latestSlopeWindowMs = slopeSpan;
      if (slopeSpan >= this.policy.slopeWindowMs) {
        slopePerHour = normalizedSlopePerHour(slopeWindow, this.baselineKb);
        if (slopePerHour > this.policy.slopeLimitPerHour) {
          reasons.push(`renderer projected slope ${(slopePerHour * 100).toFixed(2)}% of baseline per hour exceeds 2%`);
        }
      }
    }
    this.latestSlopePerHour = slopePerHour;

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
    if (this.stickyReasons.size > 0) {
      return this.assessment('unstable-growth', [...this.stickyReasons], 0, this.latestSlopePerHour);
    }
    if (this.baselineKb == null) {
      return this.assessment('warming', ['renderer baseline is not established'], 0, this.latestSlopePerHour);
    }
    return this.assessment('stable', [], 0, this.latestSlopePerHour);
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
      slopeWindowComplete: this.latestSlopeWindowMs >= this.policy.slopeWindowMs,
      slopeWindowMs: this.latestSlopeWindowMs,
      rendererPid: this.rendererPid,
    };
  }
}
