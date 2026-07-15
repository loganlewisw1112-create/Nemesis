export interface RendererMemorySample {
  at: number;
  workingSetKb: number;
}

export interface RendererMemoryAssessment {
  status: 'warming' | 'stable' | 'unstable-growth';
  sampleCount: number;
  growthRate: number;
  detail: string;
}

export class RendererMemoryMonitor {
  private readonly samples: RendererMemorySample[] = [];

  constructor(
    private readonly warmupMs = 5 * 60_000,
    private readonly requiredPostWarmupSamples = 10,
  ) {}

  add(sample: RendererMemorySample): RendererMemoryAssessment {
    if (!Number.isFinite(sample.workingSetKb) || sample.workingSetKb <= 0) {
      return { status: 'warming', sampleCount: this.samples.length, growthRate: 0, detail: 'invalid renderer memory sample ignored' };
    }
    this.samples.push(sample);
    const firstAt = this.samples[0]!.at;
    const postWarmup = this.samples.filter((item) => item.at - firstAt >= this.warmupMs);
    if (postWarmup.length < this.requiredPostWarmupSamples) {
      return {
        status: 'warming',
        sampleCount: postWarmup.length,
        growthRate: 0,
        detail: `waiting for ${this.requiredPostWarmupSamples} post-warm-up samples`,
      };
    }
    const window = postWarmup.slice(-this.requiredPostWarmupSamples);
    const first = window[0]!.workingSetKb;
    const last = window.at(-1)!.workingSetKb;
    const growthRate = (last - first) / first;
    const monotonic = window.slice(1).every((item, index) => item.workingSetKb > window[index]!.workingSetKb);
    if (growthRate > 0.1) {
      return {
        status: 'unstable-growth',
        sampleCount: window.length,
        growthRate,
        detail: monotonic
          ? `renderer working set grew ${(growthRate * 100).toFixed(1)}% monotonically`
          : `renderer working set ended ${(growthRate * 100).toFixed(1)}% above its post-warm-up baseline`,
      };
    }
    return {
      status: 'stable',
      sampleCount: window.length,
      growthRate,
      detail: `renderer working set stabilized within ${(Math.abs(growthRate) * 100).toFixed(1)}% endpoint growth`,
    };
  }
}
