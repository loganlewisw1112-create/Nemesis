import { describe, expect, it } from 'vitest';
import { EvidenceRunSupervisor } from './evidenceRunSupervisor.js';

function supervisor(stage: 'instrumentation' | 'seven-hour' = 'instrumentation', restartOrdinal = 0) {
  return new EvidenceRunSupervisor({
    at: 0, runId: 'r10', evidenceNamespace: 'r10', gitCommit: 'commit',
    configurationHash: 'config', healthPolicyHash: 'health', stage,
    runtimeSidecarPath: 'runtime.jsonl', restartOrdinal,
  });
}

describe('EvidenceRunSupervisor', () => {
  it('requires ten uninterrupted healthy minutes before starting the clock', () => {
    const run = supervisor();
    expect(run.observePreflight(0, true).state).toBe('preflight');
    run.observePreflight(5 * 60_000, false);
    run.observePreflight(6 * 60_000, true);
    expect(run.observePreflight(16 * 60_000, true).state).toBe('preflight-ready');
    const started = run.start(17 * 60_000);
    expect(started.manifest.enrollmentCutoffAt).toBe(117 * 60_000);
    expect(started.manifest.cutoffAt).toBe(137 * 60_000);
  });

  it('counts healthy renderer warm-up while requiring the baseline before readiness', () => {
    const run = supervisor();
    expect(run.observePreflight(0, true, false).state).toBe('preflight');
    expect(run.observePreflight(10 * 60_000, true, false)).toMatchObject({
      state: 'preflight',
      reason: 'stable preflight window complete; waiting for final readiness gates',
    });
    expect(run.observePreflight(10 * 60_000 + 5_000, true, true).state).toBe('preflight-ready');
  });

  it('uses the fixed T+6:45 enrollment and T+7:00 cutoff for seven-hour runs', () => {
    const run = supervisor('seven-hour');
    run.observePreflight(0, true);
    run.observePreflight(10 * 60_000, true);
    const started = run.start(20 * 60_000);
    expect(started.manifest.enrollmentCutoffAt).toBe(425 * 60_000);
    expect(started.manifest.cutoffAt).toBe(440 * 60_000);
    expect(run.tick(440 * 60_000).state).toBe('closeout');
  });

  it('allows at most two isolated recovery namespaces and never restarts a finalized attempt', () => {
    expect(supervisor('instrumentation', 0).invalidate('feed').mayRestart).toBe(true);
    expect(supervisor('instrumentation', 1).invalidate('feed').mayRestart).toBe(true);
    expect(supervisor('instrumentation', 2).invalidate('feed').mayRestart).toBe(false);

    const run = supervisor();
    const finalized = run.invalidate('feed').manifest.status === 'invalidated'
      ? run.finalize('hash')
      : null;
    expect(finalized?.mayRestart).toBe(false);
    expect(run.invalidate('late signal').state).toBe('finalized');
  });
});
