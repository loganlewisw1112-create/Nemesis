export type EvidenceStage = 'instrumentation' | 'seven-hour';
export type EvidenceSupervisorState =
  | 'preflight'
  | 'preflight-ready'
  | 'active'
  | 'closeout'
  | 'invalidated'
  | 'finalized';

export interface CampaignRunManifestV2 {
  schemaVersion: 2;
  runId: string;
  parentRunId: string | null;
  restartOrdinal: number;
  evidenceNamespace: string;
  gitCommit: string;
  configurationHash: string;
  healthPolicyHash: string;
  stage: EvidenceStage;
  runtimeSidecarPath: string;
  startedAt: number | null;
  enrollmentCutoffAt: number | null;
  cutoffAt: number | null;
  finalRuntimeSidecarHash: string | null;
  status: EvidenceSupervisorState;
}

export interface EvidenceSupervisorDecision {
  state: EvidenceSupervisorState;
  action: 'wait' | 'ready' | 'start' | 'closeout' | 'invalidate' | 'finalized';
  reason: string;
  manifest: CampaignRunManifestV2;
  mayRestart: boolean;
}

const STAGE_TIMES = {
  instrumentation: { durationMs: 2 * 60 * 60_000, enrollmentMs: 100 * 60_000 },
  'seven-hour': { durationMs: 7 * 60 * 60_000, enrollmentMs: 405 * 60_000 },
} as const;

export class EvidenceRunSupervisor {
  private readonly preflightStartedAt: number;
  private stablePreflightAt: number | null = null;
  private manifest: CampaignRunManifestV2;

  constructor(input: {
    at: number;
    runId: string;
    parentRunId?: string | null;
    restartOrdinal?: number;
    evidenceNamespace: string;
    gitCommit: string;
    configurationHash: string;
    healthPolicyHash: string;
    stage: EvidenceStage;
    runtimeSidecarPath: string;
  }) {
    this.preflightStartedAt = input.at;
    this.manifest = {
      schemaVersion: 2,
      runId: input.runId,
      parentRunId: input.parentRunId ?? null,
      restartOrdinal: input.restartOrdinal ?? 0,
      evidenceNamespace: input.evidenceNamespace,
      gitCommit: input.gitCommit,
      configurationHash: input.configurationHash,
      healthPolicyHash: input.healthPolicyHash,
      stage: input.stage,
      runtimeSidecarPath: input.runtimeSidecarPath,
      startedAt: null,
      enrollmentCutoffAt: null,
      cutoffAt: null,
      finalRuntimeSidecarHash: null,
      status: 'preflight',
    };
  }

  observePreflight(at: number, healthy: boolean, readyForStart = healthy): EvidenceSupervisorDecision {
    if (this.manifest.status !== 'preflight') return this.decision('wait', 'preflight is no longer active');
    if (at - this.preflightStartedAt > 20 * 60_000) return this.invalidate('preflight did not stabilize within 20 minutes');
    if (!healthy) {
      this.stablePreflightAt = null;
      return this.decision('wait', 'preflight health is not continuously stable');
    }
    this.stablePreflightAt ??= at;
    if (at - this.stablePreflightAt < 10 * 60_000) return this.decision('wait', 'collecting ten continuous minutes of stable preflight');
    if (!readyForStart) return this.decision('wait', 'stable preflight window complete; waiting for final readiness gates');
    this.manifest = { ...this.manifest, status: 'preflight-ready' };
    return this.decision('ready', 'preflight passed');
  }

  start(at: number): EvidenceSupervisorDecision {
    if (this.manifest.status !== 'preflight-ready') return this.invalidate('campaign start requested before preflight passed');
    const timing = STAGE_TIMES[this.manifest.stage];
    this.manifest = {
      ...this.manifest,
      startedAt: at,
      enrollmentCutoffAt: at + timing.enrollmentMs,
      cutoffAt: at + timing.durationMs,
      status: 'active',
    };
    return this.decision('start', 'fixed campaign clock started');
  }

  tick(at: number): EvidenceSupervisorDecision {
    if (this.manifest.status === 'active' && this.manifest.cutoffAt != null && at >= this.manifest.cutoffAt) {
      this.manifest = { ...this.manifest, status: 'closeout' };
      return this.decision('closeout', 'fixed cutoff reached; evidence intake must stop');
    }
    return this.decision('wait', 'no supervisor transition');
  }

  invalidate(reason: string): EvidenceSupervisorDecision {
    if (this.manifest.status === 'finalized') return this.decision('finalized', 'finalized attempts are never restarted');
    this.manifest = { ...this.manifest, status: 'invalidated' };
    return this.decision('invalidate', reason);
  }

  finalize(finalRuntimeSidecarHash: string): EvidenceSupervisorDecision {
    if (this.manifest.status !== 'closeout' && this.manifest.status !== 'invalidated') {
      return this.invalidate('finalization requested before closeout');
    }
    this.manifest = { ...this.manifest, finalRuntimeSidecarHash, status: 'finalized' };
    return this.decision('finalized', 'attempt finalized exactly once');
  }

  snapshot(): CampaignRunManifestV2 {
    return { ...this.manifest };
  }

  private decision(action: EvidenceSupervisorDecision['action'], reason: string): EvidenceSupervisorDecision {
    return {
      state: this.manifest.status,
      action,
      reason,
      manifest: this.snapshot(),
      mayRestart: this.manifest.status === 'invalidated' && this.manifest.restartOrdinal < 2,
    };
  }
}
