import { describe, expect, it } from 'vitest';
import { HealthAttestationTracker } from './healthAttestation.js';

describe('HealthAttestationTracker', () => {
  it('expires evidence instead of treating an old pass as current', () => {
    const tracker = new HealthAttestationTracker('runtime', 15_000);
    tracker.issue({ status: 'healthy', observedAt: 1_000 });
    expect(tracker.current(16_000)?.status).toBe('healthy');
    expect(tracker.current(16_001)).toBeNull();
  });

  it('keeps blocking failures sticky for the attempt', () => {
    const tracker = new HealthAttestationTracker('runtime');
    tracker.issue({ status: 'failed', observedAt: 1_000, stickyFailure: true, action: 'invalidate' });
    const next = tracker.issue({ status: 'healthy', observedAt: 2_000 });
    expect(next.status).toBe('failed');
    expect(next.stickyFailure).toBe(true);
  });

  it('requires current evidence and 95 percent sample and health coverage', () => {
    const tracker = new HealthAttestationTracker('runtime', 10_000);
    for (let index = 0; index < 20; index += 1) {
      tracker.issue({ status: 'healthy', observedAt: index * 5_000 });
    }
    const coverage = tracker.coverage(0, 95_000, 5_000);
    expect(coverage.sampleCoverage).toBe(1);
    expect(coverage.healthyCoverage).toBe(1);
    expect(coverage.qualificationReady).toBe(true);
  });
});
