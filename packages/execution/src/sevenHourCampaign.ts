import { createHash } from 'node:crypto';
import type { EntryQualificationSettings, ThesisCard } from '@nemesis/core';
import type { ConfirmationSample } from './entryConfirmation.js';
import type { DryRunOrder } from './dryRun.js';
import type { EntryEconomicsEvidence } from './tradeEconomics.js';

export type EvidenceCampaignStage = 'instrumentation' | 'seven-hour';
export type CampaignCandidateTerminalState = 'ready' | 'rejected' | 'expired';
export type CampaignRunStatus = 'active' | 'passed' | 'failed' | 'invalidated';

export interface CampaignRunManifest {
  schemaVersion: 1;
  runId: string;
  evidenceNamespace: string;
  configurationHash: string;
  gitCommit: string;
  stage: EvidenceCampaignStage;
  startedAt: number;
  enrollmentCutoffAt: number;
  cutoffAt: number;
  status: CampaignRunStatus;
  finalizedAt?: number;
  invalidationReason?: string;
}

export interface CampaignCandidateSample extends ConfirmationSample {
  observedAt: number;
  exchangeTimestamp: number;
  exchangeSequence: number;
  fillPrice: number;
  filled: number;
  fees: number;
  feePolicyKnown: boolean;
}

export interface CampaignCandidateRecord {
  candidateId: string;
  economicIdentity: string;
  originalCardId: string;
  ticker: string;
  side: 'yes' | 'no';
  configurationHash: string;
  enrolledAt: number;
  updatedAt: number;
  card: ThesisCard;
  initialFill: DryRunOrder;
  economics: EntryEconomicsEvidence;
  samples: CampaignCandidateSample[];
  terminalState?: CampaignCandidateTerminalState;
  terminalReason?: string;
  terminalAt?: number;
}

export interface CampaignDiagnosticRecord {
  diagnosticId: string;
  candidateId: string;
  dueAt: number;
  attempts: number;
  lastAttemptAt?: number;
  status: 'scheduled' | 'scored' | 'expired';
  qualificationEligible: false;
  validExecutableObservation?: boolean;
  exchangeTimestamp?: number;
  exchangeSequence?: number;
  executableFollowUpMark?: number;
  reconstructedExitFill?: DryRunOrder;
  executableNetPnlUsd?: number;
  targetAt?: number;
  lossAt?: number;
  edgeGoneAt?: number;
  completedAt?: number;
  reason?: string;
}

export interface CampaignOperationalCheck {
  name: string;
  passed: boolean;
  detail: string;
  at: number;
}

export type CampaignEventType =
  | 'run_started'
  | 'candidate_enrolled'
  | 'candidate_sampled'
  | 'candidate_terminal'
  | 'diagnostic_attempted'
  | 'diagnostic_scored'
  | 'diagnostic_expired'
  | 'safety_failure'
  | 'operational_check'
  | 'instrumentation_extended'
  | 'run_invalidated'
  | 'run_finalized';

export interface CampaignEvent {
  schemaVersion: 1;
  runId: string;
  configurationHash: string;
  sequence: number;
  at: number;
  type: CampaignEventType;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface CampaignGateResult {
  passed: boolean;
  reasons: string[];
  validDiagnosticOutcomes: number;
  readyCandidates: number;
  terminalCoverage: number;
  diagnosticSchedulingCoverage: number;
  validDiagnosticCoverage: number;
  freshConfirmationRate: number;
}

export interface CampaignSnapshot extends CampaignGateResult {
  manifest: CampaignRunManifest;
  candidates: CampaignCandidateRecord[];
  diagnostics: CampaignDiagnosticRecord[];
  safetyFailures: string[];
  operationalChecks: CampaignOperationalCheck[];
  eventCount: number;
  lastSequence: number;
  lastHash: string;
  integrityError?: string;
}

export interface StartCampaignOptions {
  runId: string;
  evidenceNamespace: string;
  configurationHash: string;
  gitCommit: string;
  stage: EvidenceCampaignStage;
  startedAt?: number;
  settings: EntryQualificationSettings;
}

export interface EnrollCampaignCandidateInput {
  card: ThesisCard;
  initialFill: DryRunOrder;
  economics: EntryEconomicsEvidence;
  enrolledAt?: number;
  diagnosticDueAt?: number;
}

export interface CompleteDiagnosticInput {
  diagnosticId: string;
  validExecutableObservation: boolean;
  exchangeTimestamp?: number;
  exchangeSequence?: number;
  executableFollowUpMark?: number;
  reconstructedExitFill?: DryRunOrder;
  executableNetPnlUsd?: number;
  targetAt?: number;
  lossAt?: number;
  edgeGoneAt?: number;
  reason: string;
  completedAt?: number;
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function eventHash(event: Omit<CampaignEvent, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 20);
}

export function candidateEconomicIdentity(card: ThesisCard): string {
  const normalizedReason = card.signalReason.trim().toLowerCase().replace(/\s+/g, ' ');
  return [card.ticker, card.side, card.playbook, card.sourceMove ?? 'unknown', normalizedReason].join('|');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class SevenHourCampaignTracker {
  private readonly events: CampaignEvent[] = [];
  private readonly candidates = new Map<string, CampaignCandidateRecord>();
  private readonly diagnostics = new Map<string, CampaignDiagnosticRecord>();
  private readonly safetyFailures: string[] = [];
  private readonly operationalChecks: CampaignOperationalCheck[] = [];
  private integrityError?: string;
  private manifest!: CampaignRunManifest;

  private constructor(private readonly settings: EntryQualificationSettings) {}

  static start(options: StartCampaignOptions): SevenHourCampaignTracker {
    const tracker = new SevenHourCampaignTracker(options.settings);
    const startedAt = options.startedAt ?? Date.now();
    const duration = options.stage === 'instrumentation'
      ? options.settings.instrumentationDurationMs
      : options.settings.campaignDurationMs;
    const closeout = options.stage === 'instrumentation' ? 0 : options.settings.campaignEnrollmentCloseoutMs;
    tracker.append('run_started', {
      manifest: {
        schemaVersion: 1,
        runId: options.runId,
        evidenceNamespace: options.evidenceNamespace,
        configurationHash: options.configurationHash,
        gitCommit: options.gitCommit,
        stage: options.stage,
        startedAt,
        enrollmentCutoffAt: startedAt + duration - closeout,
        cutoffAt: startedAt + duration,
        status: 'active',
      } satisfies CampaignRunManifest,
    }, startedAt, options.runId, options.configurationHash);
    return tracker;
  }

  static replay(events: CampaignEvent[], settings: EntryQualificationSettings): SevenHourCampaignTracker {
    const tracker = new SevenHourCampaignTracker(settings);
    let previousHash = 'GENESIS';
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      const expectedSequence = i + 1;
      const expectedHash = eventHash({ ...event, hash: undefined } as unknown as Omit<CampaignEvent, 'hash'>);
      if (event.schemaVersion !== 1
        || event.sequence !== expectedSequence
        || event.previousHash !== previousHash
        || event.hash !== expectedHash) {
        tracker.integrityError = `campaign ledger integrity failure at sequence ${expectedSequence}`;
        break;
      }
      try {
        tracker.apply(event);
        tracker.events.push(clone(event));
      } catch (error) {
        tracker.integrityError = error instanceof Error ? error.message : String(error);
        break;
      }
      previousHash = event.hash;
    }
    if (!tracker.manifest) {
      const first = events[0];
      tracker.manifest = {
        schemaVersion: 1,
        runId: first?.runId ?? 'unreadable',
        evidenceNamespace: 'unreadable',
        configurationHash: first?.configurationHash ?? 'unreadable',
        gitCommit: 'unknown',
        stage: 'seven-hour',
        startedAt: 0,
        enrollmentCutoffAt: 0,
        cutoffAt: 0,
        status: 'invalidated',
        invalidationReason: tracker.integrityError ?? 'campaign ledger is empty',
      };
    }
    if (events.length === 0) tracker.integrityError = 'campaign ledger is empty';
    return tracker;
  }

  allEvents(): CampaignEvent[] {
    return clone(this.events);
  }

  private append(
    type: CampaignEventType,
    payload: Record<string, unknown>,
    at = Date.now(),
    initialRunId?: string,
    initialConfigurationHash?: string,
  ): CampaignEvent[] {
    if (this.integrityError) throw new Error(this.integrityError);
    const runId = initialRunId ?? this.manifest.runId;
    const configurationHash = initialConfigurationHash ?? this.manifest.configurationHash;
    const body: Omit<CampaignEvent, 'hash'> = {
      schemaVersion: 1,
      runId,
      configurationHash,
      sequence: this.events.length + 1,
      at,
      type,
      payload: clone(payload),
      previousHash: this.events.at(-1)?.hash ?? 'GENESIS',
    };
    const event: CampaignEvent = { ...body, hash: eventHash(body) };
    this.apply(event);
    this.events.push(event);
    return [clone(event)];
  }

  private apply(event: CampaignEvent): void {
    if (event.type !== 'run_started' && (!this.manifest || event.runId !== this.manifest.runId)) {
      throw new Error('campaign event run identity mismatch');
    }
    if (event.type !== 'run_started' && event.configurationHash !== this.manifest.configurationHash) {
      throw new Error('campaign event configuration hash mismatch');
    }
    switch (event.type) {
      case 'run_started': {
        if (this.manifest) throw new Error('duplicate campaign run_started event');
        this.manifest = clone(event.payload.manifest as CampaignRunManifest);
        break;
      }
      case 'candidate_enrolled': {
        const candidate = clone(event.payload.candidate as CampaignCandidateRecord);
        const diagnostic = clone(event.payload.diagnostic as CampaignDiagnosticRecord);
        if (this.candidates.has(candidate.candidateId)) throw new Error('duplicate candidate enrollment');
        this.candidates.set(candidate.candidateId, candidate);
        this.diagnostics.set(diagnostic.diagnosticId, diagnostic);
        break;
      }
      case 'candidate_sampled': {
        const candidate = this.requiredCandidate(String(event.payload.candidateId));
        if (candidate.terminalState) throw new Error('sample after terminal candidate state');
        const sample = clone(event.payload.sample as CampaignCandidateSample);
        if (candidate.samples.some((existing) => existing.exchangeSequence === sample.exchangeSequence)) {
          throw new Error('duplicate confirmation sequence');
        }
        candidate.samples.push(sample);
        candidate.updatedAt = event.at;
        break;
      }
      case 'candidate_terminal': {
        const candidate = this.requiredCandidate(String(event.payload.candidateId));
        if (candidate.terminalState) throw new Error('duplicate terminal candidate transition');
        candidate.terminalState = event.payload.state as CampaignCandidateTerminalState;
        candidate.terminalReason = String(event.payload.reason);
        candidate.terminalAt = event.at;
        candidate.updatedAt = event.at;
        break;
      }
      case 'diagnostic_attempted': {
        const diagnostic = this.requiredDiagnostic(String(event.payload.diagnosticId));
        if (diagnostic.status !== 'scheduled') throw new Error('diagnostic attempt after terminal state');
        diagnostic.attempts += 1;
        diagnostic.lastAttemptAt = event.at;
        diagnostic.reason = String(event.payload.reason ?? 'follow-up attempted');
        break;
      }
      case 'diagnostic_scored': {
        const diagnostic = this.requiredDiagnostic(String(event.payload.diagnosticId));
        if (diagnostic.status !== 'scheduled') throw new Error('duplicate diagnostic terminal transition');
        Object.assign(diagnostic, clone(event.payload.result as Partial<CampaignDiagnosticRecord>), {
          status: 'scored',
          qualificationEligible: false,
          completedAt: event.at,
        });
        break;
      }
      case 'diagnostic_expired': {
        const diagnostic = this.requiredDiagnostic(String(event.payload.diagnosticId));
        if (diagnostic.status !== 'scheduled') throw new Error('duplicate diagnostic terminal transition');
        diagnostic.status = 'expired';
        diagnostic.reason = String(event.payload.reason);
        diagnostic.completedAt = event.at;
        break;
      }
      case 'safety_failure':
        this.safetyFailures.push(String(event.payload.reason));
        break;
      case 'operational_check':
        this.operationalChecks.push(clone(event.payload.check as CampaignOperationalCheck));
        break;
      case 'instrumentation_extended': {
        if (this.manifest.stage !== 'instrumentation') throw new Error('only instrumentation can be extended');
        this.manifest.enrollmentCutoffAt = Number(event.payload.cutoffAt);
        this.manifest.cutoffAt = Number(event.payload.cutoffAt);
        break;
      }
      case 'run_invalidated':
        this.manifest.status = 'invalidated';
        this.manifest.invalidationReason = String(event.payload.reason);
        this.manifest.finalizedAt = event.at;
        break;
      case 'run_finalized':
        this.manifest.status = event.payload.passed ? 'passed' : 'failed';
        this.manifest.finalizedAt = event.at;
        break;
    }
  }

  private requiredCandidate(candidateId: string): CampaignCandidateRecord {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`campaign candidate not found: ${candidateId}`);
    return candidate;
  }

  private requiredDiagnostic(diagnosticId: string): CampaignDiagnosticRecord {
    const diagnostic = this.diagnostics.get(diagnosticId);
    if (!diagnostic) throw new Error(`campaign diagnostic not found: ${diagnosticId}`);
    return diagnostic;
  }

  ensureConfiguration(configurationHash: string, at = Date.now()): CampaignEvent[] {
    if (configurationHash === this.manifest.configurationHash || this.manifest.status !== 'active') return [];
    return this.invalidate('configuration hash changed; samples from different configurations cannot be combined', at);
  }

  enroll(input: EnrollCampaignCandidateInput): CampaignEvent[] {
    const at = input.enrolledAt ?? Date.now();
    if (this.manifest.status !== 'active' || at > this.manifest.enrollmentCutoffAt) return [];
    const economicIdentity = candidateEconomicIdentity(input.card);
    const candidateId = `${this.manifest.runId}:${stableHash(economicIdentity)}`;
    if (this.candidates.has(candidateId)) return [];
    const candidate: CampaignCandidateRecord = {
      candidateId,
      economicIdentity,
      originalCardId: input.card.id,
      ticker: input.card.ticker,
      side: input.card.side,
      configurationHash: this.manifest.configurationHash,
      enrolledAt: at,
      updatedAt: at,
      card: clone(input.card),
      initialFill: clone(input.initialFill),
      economics: clone(input.economics),
      samples: [],
    };
    const diagnostic: CampaignDiagnosticRecord = {
      diagnosticId: `diag:${candidateId}`,
      candidateId,
      dueAt: input.diagnosticDueAt ?? at + this.settings.shadowFollowUpMs,
      attempts: 0,
      status: 'scheduled',
      qualificationEligible: false,
    };
    return this.append('candidate_enrolled', { candidate, diagnostic }, at);
  }

  recordSample(candidateId: string, sample: CampaignCandidateSample): CampaignEvent[] {
    const candidate = this.requiredCandidate(candidateId);
    if (candidate.terminalState) return [];
    if (candidate.samples.some((existing) => existing.exchangeSequence === sample.exchangeSequence)) return [];
    return this.append('candidate_sampled', { candidateId, sample }, sample.observedAt);
  }

  terminalize(candidateId: string, state: CampaignCandidateTerminalState, reason: string, at = Date.now()): CampaignEvent[] {
    const candidate = this.requiredCandidate(candidateId);
    if (candidate.terminalState) return [];
    return this.append('candidate_terminal', { candidateId, state, reason }, at);
  }

  recordDiagnosticAttempt(diagnosticId: string, reason: string, at = Date.now()): CampaignEvent[] {
    const diagnostic = this.requiredDiagnostic(diagnosticId);
    if (diagnostic.status !== 'scheduled') return [];
    return this.append('diagnostic_attempted', { diagnosticId, reason }, at);
  }

  completeDiagnostic(input: CompleteDiagnosticInput): CampaignEvent[] {
    const diagnostic = this.requiredDiagnostic(input.diagnosticId);
    if (diagnostic.status !== 'scheduled') return [];
    const at = input.completedAt ?? Date.now();
    const result: Partial<CampaignDiagnosticRecord> = {
      validExecutableObservation: input.validExecutableObservation,
      exchangeTimestamp: input.exchangeTimestamp,
      exchangeSequence: input.exchangeSequence,
      executableFollowUpMark: input.executableFollowUpMark,
      reconstructedExitFill: clone(input.reconstructedExitFill),
      executableNetPnlUsd: input.executableNetPnlUsd,
      targetAt: input.targetAt,
      lossAt: input.lossAt,
      edgeGoneAt: input.edgeGoneAt,
      reason: input.reason,
    };
    return this.append('diagnostic_scored', { diagnosticId: input.diagnosticId, result }, at);
  }

  recordSafetyFailure(reason: string, at = Date.now()): CampaignEvent[] {
    return this.append('safety_failure', { reason }, at);
  }

  recordOperationalCheck(name: string, passed: boolean, detail: string, at = Date.now()): CampaignEvent[] {
    return this.append('operational_check', { check: { name, passed, detail, at } satisfies CampaignOperationalCheck }, at);
  }

  extendInstrumentation(cutoffAt: number, at = Date.now()): CampaignEvent[] {
    if (this.manifest.stage !== 'instrumentation' || cutoffAt <= this.manifest.cutoffAt) return [];
    return this.append('instrumentation_extended', { cutoffAt }, at);
  }

  expireAtCutoff(at = Date.now()): CampaignEvent[] {
    if (this.manifest.status !== 'active' || at < this.manifest.cutoffAt) return [];
    const created: CampaignEvent[] = [];
    for (const candidate of this.candidates.values()) {
      if (!candidate.terminalState) created.push(...this.terminalize(candidate.candidateId, 'expired', 'campaign cutoff reached with insufficient evidence', at));
    }
    for (const diagnostic of this.diagnostics.values()) {
      if (diagnostic.status === 'scheduled') {
        created.push(...this.append('diagnostic_expired', {
          diagnosticId: diagnostic.diagnosticId,
          reason: 'campaign cutoff reached without a valid executable follow-up',
        }, at));
      }
    }
    return created;
  }

  invalidate(reason: string, at = Date.now()): CampaignEvent[] {
    if (this.manifest.status !== 'active') return [];
    const created: CampaignEvent[] = [];
    for (const candidate of this.candidates.values()) {
      if (!candidate.terminalState) created.push(...this.terminalize(candidate.candidateId, 'expired', reason, at));
    }
    for (const diagnostic of this.diagnostics.values()) {
      if (diagnostic.status === 'scheduled') created.push(...this.append('diagnostic_expired', { diagnosticId: diagnostic.diagnosticId, reason }, at));
    }
    created.push(...this.append('run_invalidated', { reason }, at));
    return created;
  }

  finalize(at = Date.now()): CampaignEvent[] {
    if (this.manifest.status !== 'active' || at < this.manifest.cutoffAt) return [];
    const created = this.expireAtCutoff(at);
    const gate = this.evaluateGates();
    created.push(...this.append('run_finalized', { passed: gate.passed, reasons: gate.reasons }, at));
    return created;
  }

  private evaluateGates(): CampaignGateResult {
    const candidates = [...this.candidates.values()];
    const diagnostics = [...this.diagnostics.values()];
    const terminalCount = candidates.filter((candidate) => candidate.terminalState).length;
    const readyCandidates = candidates.filter((candidate) => candidate.terminalState === 'ready').length;
    const scheduledCount = diagnostics.length;
    const validDiagnosticOutcomes = diagnostics.filter((diagnostic) => diagnostic.status === 'scored' && diagnostic.validExecutableObservation).length;
    const allSamples = candidates.flatMap((candidate) => candidate.samples);
    const freshSamples = allSamples.filter((sample) => sample.observedAt - sample.exchangeTimestamp <= this.settings.maxBookAgeMs).length;
    const terminalCoverage = candidates.length > 0 ? terminalCount / candidates.length : 0;
    const diagnosticSchedulingCoverage = candidates.length > 0 ? scheduledCount / candidates.length : 0;
    const validDiagnosticCoverage = scheduledCount > 0 ? validDiagnosticOutcomes / scheduledCount : 0;
    const freshConfirmationRate = allSamples.length > 0 ? freshSamples / allSamples.length : 0;
    const failedOperationalChecks = this.operationalChecks.filter((check) => !check.passed);
    const rendererMemoryCheck = this.operationalChecks.find((check) => check.name === 'renderer_memory_stable' && check.passed);
    const bridgeTrafficCheck = this.operationalChecks.find((check) => check.name === 'bridge_bidirectional_traffic' && check.passed);
    const reasons: string[] = [];

    if (this.integrityError) reasons.push(this.integrityError);
    if (this.safetyFailures.length > 0) reasons.push(`${this.safetyFailures.length} blocking safety failure(s)`);
    if (failedOperationalChecks.length > 0) reasons.push(`${failedOperationalChecks.length} operational check(s) failed`);
    if (!rendererMemoryCheck) reasons.push('renderer memory stabilization was not proven');
    if (!bridgeTrafficCheck) reasons.push('recent bidirectional bridge traffic was not proven');
    if (this.manifest.stage === 'instrumentation') {
      if (candidates.length < this.settings.instrumentationMinUniqueCandidates) reasons.push('fewer than 20 unique economically viable candidates');
      if (terminalCoverage < this.settings.instrumentationMinTerminalCoverage) reasons.push('terminal lifecycle coverage below 100%');
      if (diagnosticSchedulingCoverage < this.settings.instrumentationMinDiagnosticSchedulingCoverage) reasons.push('diagnostic scheduling coverage below 95%');
      if (validDiagnosticCoverage < this.settings.instrumentationMinValidDiagnosticCoverage) reasons.push('valid diagnostic coverage below 90%');
    } else {
      if (validDiagnosticOutcomes < this.settings.campaignMinValidDiagnostics) reasons.push('fewer than 30 valid diagnostic outcomes');
      if (readyCandidates < this.settings.campaignMinReadyCandidates) reasons.push('zero ready candidates');
      if (terminalCoverage < 1) reasons.push('candidate provenance or terminal lifecycle coverage is incomplete');
    }
    if (freshConfirmationRate < this.settings.campaignMinFreshSampleRate) reasons.push('exchange-book freshness below 95%');

    return {
      passed: reasons.length === 0,
      reasons,
      validDiagnosticOutcomes,
      readyCandidates,
      terminalCoverage: round(terminalCoverage),
      diagnosticSchedulingCoverage: round(diagnosticSchedulingCoverage),
      validDiagnosticCoverage: round(validDiagnosticCoverage),
      freshConfirmationRate: round(freshConfirmationRate),
    };
  }

  snapshot(): CampaignSnapshot {
    const gate = this.evaluateGates();
    return {
      manifest: clone(this.manifest),
      candidates: clone([...this.candidates.values()]),
      diagnostics: clone([...this.diagnostics.values()]),
      safetyFailures: clone(this.safetyFailures),
      operationalChecks: clone(this.operationalChecks),
      eventCount: this.events.length,
      lastSequence: this.events.at(-1)?.sequence ?? 0,
      lastHash: this.events.at(-1)?.hash ?? 'GENESIS',
      integrityError: this.integrityError,
      ...gate,
    };
  }
}
