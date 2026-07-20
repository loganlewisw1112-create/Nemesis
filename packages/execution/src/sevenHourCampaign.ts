import { createHash } from 'node:crypto';
import type { EntryQualificationSettings, ThesisCard } from '@nemesis/core';
import {
  campaignEconomicIdentity,
  type CampaignInitialSampleEvidence,
  type CampaignScreenedOut,
  type CampaignScreeningEligible,
} from './campaignEnrollment.js';
import type { ConfirmationSample } from './entryConfirmation.js';
import type { DryRunOrder } from './dryRun.js';
import type { EntryEconomicsEvidence } from './tradeEconomics.js';

export type EvidenceCampaignStage = 'instrumentation' | 'seven-hour';
export type CampaignCandidateTerminalState = 'ready' | 'rejected' | 'expired';
export type CampaignRunStatus = 'active' | 'closeout' | 'passed' | 'failed' | 'invalidated';
export type CampaignCandidateLifecycleState = 'confirming' | CampaignCandidateTerminalState;

interface CampaignManifestBase {
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

export interface CampaignRunManifestV1 extends CampaignManifestBase {
  schemaVersion: 1;
}

export interface CampaignRunManifestV2 extends CampaignManifestBase {
  schemaVersion: 2;
  parentRunId?: string;
  restartOrdinal: number;
  healthPolicyHash: string;
  productionArtifactHash: string;
  soakVerificationReceiptHash: string;
  runtimeSidecarPath: string;
  finalRuntimeSidecarHash?: string;
}

export type CampaignRunManifest = CampaignRunManifestV1 | CampaignRunManifestV2;

export interface CampaignCandidateSample extends ConfirmationSample, CampaignInitialSampleEvidence {}

export interface CampaignCandidateRecord {
  candidateId: string;
  economicIdentity: string;
  originalCardId: string;
  ticker: string;
  side: 'yes' | 'no';
  configurationHash: string;
  enrolledAt: number;
  updatedAt: number;
  lifecycleState: CampaignCandidateLifecycleState;
  card: ThesisCard;
  initialFill: DryRunOrder;
  economics: EntryEconomicsEvidence;
  samples: CampaignCandidateSample[];
  terminalState?: CampaignCandidateTerminalState;
  terminalReason?: string;
  terminalAt?: number;
}

export type DiagnosticAttemptOutcome =
  | 'no_delta'
  | 'book_fetch_failed'
  | 'missing_provenance'
  | 'stale_book'
  | 'fee_unknown'
  | 'insufficient_depth'
  | 'partial_fill'
  | 'slippage_exceeded'
  | 'valid_observation';

export interface DiagnosticAttemptSummaryV2 {
  outcome: Exclude<DiagnosticAttemptOutcome, 'valid_observation'>;
  count: number;
  firstAt: number;
  lastAt: number;
  lastDetail: string;
  exchangeTimestamp?: number;
  exchangeSequence?: number;
}

export interface DiagnosticAttemptV2 {
  diagnosticId: string;
  outcome: Exclude<DiagnosticAttemptOutcome, 'valid_observation'>;
  detail: string;
  completedAt?: number;
  exchangeTimestamp?: number;
  exchangeSequence?: number;
}

export interface CampaignDiagnosticRecord {
  diagnosticId: string;
  candidateId: string;
  dueAt: number;
  expiresAt: number;
  attempts: number;
  attemptSummaries: DiagnosticAttemptSummaryV2[];
  lastAttemptAt?: number;
  nextAttemptAt?: number;
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

export interface CampaignScreenedOutRecord extends CampaignScreenedOut {
  screeningId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
}

export interface CampaignOperationalCheck {
  name: string;
  passed: boolean;
  detail: string;
  at: number;
}

export type CampaignEventType =
  | 'run_started'
  | 'candidate_screened_out'
  | 'candidate_enrolled'
  | 'candidate_sampled'
  | 'candidate_terminal'
  | 'diagnostic_attempted'
  | 'diagnostic_scored'
  | 'diagnostic_expired'
  | 'safety_failure'
  | 'operational_check'
  | 'instrumentation_extended'
  | 'run_closeout_ready'
  | 'run_invalidated'
  | 'run_finalized';

export interface CampaignEvent {
  schemaVersion: 1 | 2;
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
  /** Absent only in hand-built schema-v1 compatibility fixtures. */
  screenedOut?: CampaignScreenedOutRecord[];
  safetyFailures: string[];
  operationalChecks: CampaignOperationalCheck[];
  eventCount: number;
  lastSequence: number;
  lastHash: string;
  /** Absent only in hand-built schema-v1 compatibility fixtures. */
  readOnly?: boolean;
  integrityError?: string;
}

/**
 * Minimal read-model for the per-orderbook-delta hot path. It is a structural
 * subset of {@link CampaignSnapshot} (so a full snapshot is still assignable),
 * but {@link SevenHourCampaignTracker.bookUpdateView} builds it WITHOUT deep-
 * cloning the growing candidate/diagnostic/operationalCheck collections — the
 * clone cost that starved the renderer heartbeat during long soaks.
 */
export interface CampaignBookUpdateView {
  readonly manifest: { readonly status: CampaignRunStatus };
  readonly candidates: readonly Pick<
    CampaignCandidateRecord,
    'economicIdentity' | 'ticker' | 'candidateId' | 'terminalState'
  >[];
  readonly diagnostics: readonly Pick<
    CampaignDiagnosticRecord,
    'candidateId' | 'status' | 'dueAt'
  >[];
}

export interface StartCampaignOptions {
  runId: string;
  evidenceNamespace: string;
  configurationHash: string;
  gitCommit: string;
  stage: EvidenceCampaignStage;
  startedAt?: number;
  settings: EntryQualificationSettings;
  parentRunId?: string;
  restartOrdinal?: number;
  healthPolicyHash?: string;
  runtimeSidecarPath?: string;
  productionArtifactHash: string;
  soakVerificationReceiptHash: string;
}

export interface RecordScreenedOutInput {
  card: ThesisCard;
  decision: CampaignScreenedOut;
  completedAt?: number;
}

export interface EnrollQualifiedCampaignCandidateInput {
  card: ThesisCard;
  initialFill: DryRunOrder;
  economics?: EntryEconomicsEvidence;
  initialSample?: CampaignCandidateSample;
  screening: CampaignScreeningEligible;
  completedAt?: number;
  diagnosticDueAt?: number;
}

/** @deprecated Schema-v2 callers must use enrollQualified after pure screening. */
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

const DIAGNOSTIC_RETRY_OFFSETS_MS = [0, 30_000, 60_000, 120_000, 180_000, 300_000] as const;
const DIAGNOSTIC_OBSERVATION_WINDOW_MS = 5 * 60_000;
const INSTRUMENTATION_CLOSEOUT_MS = 20 * 60_000;
const OPERATIONAL_CHECK_LEASE_MS = 60_000;

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
  return campaignEconomicIdentity(card);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class SevenHourCampaignTracker {
  private readonly events: CampaignEvent[] = [];
  private readonly candidates = new Map<string, CampaignCandidateRecord>();
  private readonly diagnostics = new Map<string, CampaignDiagnosticRecord>();
  private readonly screenedOut = new Map<string, CampaignScreenedOutRecord>();
  private readonly safetyFailures: string[] = [];
  private readonly operationalChecks: CampaignOperationalCheck[] = [];
  private integrityError?: string;
  private manifest!: CampaignRunManifest;
  private schemaVersion: 1 | 2 = 2;
  private readOnly = false;

  private constructor(private readonly settings: EntryQualificationSettings) {}

  static start(options: StartCampaignOptions): SevenHourCampaignTracker {
    if (!/^[a-f0-9]{64}$/i.test(options.productionArtifactHash)) {
      throw new Error('production artifact hash must be an explicit SHA-256 digest');
    }
    if (!/^[a-f0-9]{64}$/i.test(options.soakVerificationReceiptHash)) {
      throw new Error('soak verification receipt hash must be an explicit SHA-256 digest');
    }
    const tracker = new SevenHourCampaignTracker(options.settings);
    const startedAt = options.startedAt ?? Date.now();
    const duration = options.stage === 'instrumentation'
      ? options.settings.instrumentationDurationMs
      : options.settings.campaignDurationMs;
    const closeout = options.stage === 'instrumentation'
      ? INSTRUMENTATION_CLOSEOUT_MS
      : options.settings.campaignEnrollmentCloseoutMs;
    const manifest: CampaignRunManifestV2 = {
      schemaVersion: 2,
      runId: options.runId,
      evidenceNamespace: options.evidenceNamespace,
      configurationHash: options.configurationHash,
      gitCommit: options.gitCommit,
      stage: options.stage,
      startedAt,
      enrollmentCutoffAt: startedAt + Math.max(0, duration - closeout),
      cutoffAt: startedAt + duration,
      status: 'active',
      parentRunId: options.parentRunId,
      restartOrdinal: options.restartOrdinal ?? 0,
      healthPolicyHash: options.healthPolicyHash ?? 'not-provided',
      productionArtifactHash: options.productionArtifactHash,
      soakVerificationReceiptHash: options.soakVerificationReceiptHash,
      runtimeSidecarPath: options.runtimeSidecarPath ?? '',
    };
    tracker.append('run_started', { manifest }, startedAt, options.runId, options.configurationHash);
    return tracker;
  }

  static replay(events: CampaignEvent[], settings: EntryQualificationSettings): SevenHourCampaignTracker {
    const tracker = new SevenHourCampaignTracker(settings);
    const schemaVersion = events[0]?.schemaVersion ?? 2;
    tracker.schemaVersion = schemaVersion;
    let previousHash = 'GENESIS';
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      const expectedSequence = i + 1;
      const { hash: _hash, ...body } = event;
      const expectedHash = eventHash(body);
      if (event.schemaVersion !== schemaVersion
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
    tracker.readOnly = schemaVersion === 1;
    if (!tracker.manifest) {
      const first = events[0];
      tracker.manifest = {
        schemaVersion,
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
        ...(schemaVersion === 2 ? {
          restartOrdinal: 0,
          healthPolicyHash: 'unreadable',
          productionArtifactHash: 'unreadable',
          soakVerificationReceiptHash: 'unreadable',
          runtimeSidecarPath: '',
        } : {}),
      } as CampaignRunManifest;
    }
    if (events.length === 0) tracker.integrityError = 'campaign ledger is empty';
    return tracker;
  }

  allEvents(): CampaignEvent[] {
    return clone(this.events);
  }

  private assertMutable(): void {
    if (this.readOnly) throw new Error('schema-v1 campaign ledgers are read-only and cannot resume under schema v2');
    if (this.integrityError) throw new Error(this.integrityError);
  }

  private append(
    type: CampaignEventType,
    payload: Record<string, unknown>,
    at = Date.now(),
    initialRunId?: string,
    initialConfigurationHash?: string,
  ): CampaignEvent[] {
    this.assertMutable();
    const runId = initialRunId ?? this.manifest.runId;
    const configurationHash = initialConfigurationHash ?? this.manifest.configurationHash;
    const body: Omit<CampaignEvent, 'hash'> = {
      schemaVersion: this.schemaVersion,
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
        this.schemaVersion = event.schemaVersion;
        break;
      }
      case 'candidate_screened_out': {
        const screening = clone(event.payload.screening as CampaignScreenedOutRecord);
        const existing = this.screenedOut.get(screening.screeningId);
        if (existing) {
          existing.occurrences += 1;
          existing.lastSeenAt = event.at;
        } else this.screenedOut.set(screening.screeningId, screening);
        break;
      }
      case 'candidate_enrolled': {
        const candidate = clone(event.payload.candidate as CampaignCandidateRecord);
        const diagnostic = clone(event.payload.diagnostic as CampaignDiagnosticRecord);
        if (this.candidates.has(candidate.candidateId)) throw new Error('duplicate candidate enrollment');
        candidate.lifecycleState ??= candidate.terminalState ?? 'confirming';
        diagnostic.attemptSummaries ??= [];
        diagnostic.expiresAt ??= this.manifest.cutoffAt;
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
        candidate.lifecycleState = candidate.terminalState;
        candidate.terminalReason = String(event.payload.reason);
        candidate.terminalAt = event.at;
        candidate.updatedAt = event.at;
        break;
      }
      case 'diagnostic_attempted': {
        const diagnostic = this.requiredDiagnostic(String(event.payload.diagnosticId));
        if (diagnostic.status !== 'scheduled') throw new Error('diagnostic attempt after terminal state');
        const attempt = clone(event.payload.attempt as DiagnosticAttemptV2 | undefined);
        const outcome = attempt?.outcome ?? 'book_fetch_failed';
        const detail = attempt?.detail ?? String(event.payload.reason ?? 'follow-up failed');
        diagnostic.attempts += 1;
        diagnostic.lastAttemptAt = event.at;
        diagnostic.reason = detail;
        const summary = diagnostic.attemptSummaries.find((item) => item.outcome === outcome);
        if (summary) {
          summary.count += 1;
          summary.lastAt = event.at;
          summary.lastDetail = detail;
          summary.exchangeTimestamp = attempt?.exchangeTimestamp;
          summary.exchangeSequence = attempt?.exchangeSequence;
        } else {
          diagnostic.attemptSummaries.push({
            outcome,
            count: 1,
            firstAt: event.at,
            lastAt: event.at,
            lastDetail: detail,
            exchangeTimestamp: attempt?.exchangeTimestamp,
            exchangeSequence: attempt?.exchangeSequence,
          });
        }
        const offset = DIAGNOSTIC_RETRY_OFFSETS_MS[diagnostic.attempts];
        diagnostic.nextAttemptAt = offset == null ? undefined : diagnostic.dueAt + offset;
        break;
      }
      case 'diagnostic_scored': {
        const diagnostic = this.requiredDiagnostic(String(event.payload.diagnosticId));
        if (diagnostic.status !== 'scheduled') throw new Error('duplicate diagnostic terminal transition');
        Object.assign(diagnostic, clone(event.payload.result as Partial<CampaignDiagnosticRecord>), {
          status: 'scored',
          qualificationEligible: false,
          completedAt: event.at,
          nextAttemptAt: undefined,
        });
        break;
      }
      case 'diagnostic_expired': {
        const diagnostic = this.requiredDiagnostic(String(event.payload.diagnosticId));
        if (diagnostic.status !== 'scheduled') throw new Error('duplicate diagnostic terminal transition');
        diagnostic.status = 'expired';
        diagnostic.reason = String(event.payload.reason);
        diagnostic.completedAt = event.at;
        diagnostic.nextAttemptAt = undefined;
        break;
      }
      case 'safety_failure': this.safetyFailures.push(String(event.payload.reason)); break;
      case 'operational_check': this.operationalChecks.push(clone(event.payload.check as CampaignOperationalCheck)); break;
      case 'instrumentation_extended': {
        if (this.manifest.stage !== 'instrumentation') throw new Error('only instrumentation can be extended');
        this.manifest.enrollmentCutoffAt = Number(event.payload.enrollmentCutoffAt ?? event.payload.cutoffAt);
        this.manifest.cutoffAt = Number(event.payload.cutoffAt);
        break;
      }
      case 'run_closeout_ready':
        this.manifest.status = 'closeout';
        break;
      case 'run_invalidated':
        this.manifest.status = 'invalidated';
        this.manifest.invalidationReason = String(event.payload.reason);
        this.manifest.finalizedAt = event.at;
        break;
      case 'run_finalized':
        this.manifest.status = event.payload.passed ? 'passed' : 'failed';
        this.manifest.finalizedAt = event.at;
        if (this.manifest.schemaVersion === 2 && typeof event.payload.finalRuntimeSidecarHash === 'string') {
          this.manifest.finalRuntimeSidecarHash = event.payload.finalRuntimeSidecarHash;
        }
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
    this.assertMutable();
    if (configurationHash === this.manifest.configurationHash || this.manifest.status !== 'active') return [];
    return this.invalidate('configuration hash changed; samples from different configurations cannot be combined', at);
  }

  recordScreenedOut(input: RecordScreenedOutInput): CampaignEvent[] {
    this.assertMutable();
    if (this.manifest.status !== 'active') return [];
    const at = input.completedAt ?? input.decision.completedAt;
    const key = `${input.decision.economicIdentity}|${input.decision.reasonCode}`;
    const screeningId = `${this.manifest.runId}:screen:${stableHash(key)}`;
    const existing = this.screenedOut.get(screeningId);
    const screening: CampaignScreenedOutRecord = {
      ...clone(input.decision),
      screeningId,
      firstSeenAt: existing?.firstSeenAt ?? at,
      lastSeenAt: at,
      occurrences: existing?.occurrences ?? 1,
    };
    return this.append('candidate_screened_out', { screening, originalCard: {
      id: input.card.id,
      ticker: input.card.ticker,
      side: input.card.side,
    } }, at);
  }

  enrollQualified(input: EnrollQualifiedCampaignCandidateInput): CampaignEvent[] {
    this.assertMutable();
    const at = input.completedAt ?? input.screening.completedAt;
    if (this.manifest.status !== 'active' || at > this.manifest.enrollmentCutoffAt) return [];
    if (input.screening.status !== 'eligible') return [];
    if (input.screening.economicIdentity !== candidateEconomicIdentity(input.card)
      || input.screening.originalCardId !== input.card.id
      || input.screening.ticker !== input.card.ticker
      || input.screening.side !== input.card.side) {
      throw new Error('campaign screening identity does not match enrollment candidate');
    }
    const economicIdentity = input.screening.economicIdentity;
    const candidateId = `${this.manifest.runId}:${stableHash(economicIdentity)}`;
    if (this.candidates.has(candidateId)) return [];
    const initialSample = clone(input.initialSample ?? input.screening.initialSample) as CampaignCandidateSample;
    if (initialSample.observedAt !== at) throw new Error('initial sample must use enrollment completion time');
    const candidate: CampaignCandidateRecord = {
      candidateId,
      economicIdentity,
      originalCardId: input.card.id,
      ticker: input.card.ticker,
      side: input.card.side,
      configurationHash: this.manifest.configurationHash,
      enrolledAt: at,
      updatedAt: at,
      lifecycleState: 'confirming',
      card: clone(input.card),
      initialFill: clone(input.initialFill),
      economics: clone(input.economics ?? input.screening.economics),
      samples: [initialSample],
    };
    const dueAt = input.diagnosticDueAt ?? at + this.settings.shadowFollowUpMs;
    const diagnostic: CampaignDiagnosticRecord = {
      diagnosticId: `diag:${candidateId}`,
      candidateId,
      dueAt,
      expiresAt: Math.min(dueAt + DIAGNOSTIC_OBSERVATION_WINDOW_MS, this.manifest.cutoffAt),
      attempts: 0,
      attemptSummaries: [],
      nextAttemptAt: dueAt,
      status: 'scheduled',
      qualificationEligible: false,
    };
    return this.append('candidate_enrolled', { candidate, diagnostic, screening: clone(input.screening) }, at);
  }

  /** Schema-v2 deliberately rejects the pre-screening enrollment path. */
  enroll(_input: EnrollCampaignCandidateInput): CampaignEvent[] {
    this.assertMutable();
    throw new Error('schema-v2 campaigns require qualifyCampaignEnrollment followed by enrollQualified');
  }

  recordSample(candidateId: string, sample: CampaignCandidateSample): CampaignEvent[] {
    this.assertMutable();
    const candidate = this.requiredCandidate(candidateId);
    if (candidate.terminalState || sample.observedAt > this.manifest.cutoffAt) return [];
    if (candidate.samples.some((existing) => existing.exchangeSequence === sample.exchangeSequence)) return [];
    return this.append('candidate_sampled', { candidateId, sample }, sample.observedAt);
  }

  terminalize(candidateId: string, state: CampaignCandidateTerminalState, reason: string, at = Date.now()): CampaignEvent[] {
    this.assertMutable();
    const candidate = this.requiredCandidate(candidateId);
    if (candidate.terminalState) return [];
    const finalState = at > this.manifest.cutoffAt ? 'expired' : state;
    const finalReason = at > this.manifest.cutoffAt ? 'candidate completed after campaign cutoff' : reason;
    return this.append('candidate_terminal', { candidateId, state: finalState, reason: finalReason }, at);
  }

  dueDiagnostics(at = Date.now()): CampaignDiagnosticRecord[] {
    return clone([...this.diagnostics.values()].filter((diagnostic) => diagnostic.status === 'scheduled'
      && at >= (diagnostic.nextAttemptAt ?? Number.POSITIVE_INFINITY)
      && at <= diagnostic.expiresAt
      && at <= this.manifest.cutoffAt));
  }

  recordDiagnosticAttempt(input: DiagnosticAttemptV2): CampaignEvent[];
  /** @deprecated Structured DiagnosticAttemptV2 is required by schema v2. */
  recordDiagnosticAttempt(diagnosticId: string, reason: string, at?: number): CampaignEvent[];
  recordDiagnosticAttempt(inputOrId: DiagnosticAttemptV2 | string, reason?: string, at?: number): CampaignEvent[] {
    this.assertMutable();
    if (typeof inputOrId === 'string') {
      throw new Error(`structured diagnostic attempt required for ${inputOrId}: ${reason ?? 'unknown failure'} at ${at ?? Date.now()}`);
    }
    const diagnostic = this.requiredDiagnostic(inputOrId.diagnosticId);
    if (diagnostic.status !== 'scheduled') return [];
    const completedAt = inputOrId.completedAt ?? Date.now();
    if (completedAt < diagnostic.dueAt || completedAt < (diagnostic.nextAttemptAt ?? diagnostic.dueAt)) return [];
    if (completedAt > diagnostic.expiresAt || completedAt > this.manifest.cutoffAt) {
      return this.append('diagnostic_expired', {
        diagnosticId: diagnostic.diagnosticId,
        reason: 'diagnostic observation completed after its fixed cutoff',
      }, completedAt);
    }
    if (diagnostic.attempts >= DIAGNOSTIC_RETRY_OFFSETS_MS.length) return [];
    const created = this.append('diagnostic_attempted', { diagnosticId: diagnostic.diagnosticId, attempt: inputOrId }, completedAt);
    const updated = this.requiredDiagnostic(diagnostic.diagnosticId);
    if (updated.attempts >= DIAGNOSTIC_RETRY_OFFSETS_MS.length) {
      created.push(...this.append('diagnostic_expired', {
        diagnosticId: diagnostic.diagnosticId,
        reason: 'diagnostic retry budget exhausted without a valid executable observation',
      }, completedAt));
    }
    return created;
  }

  completeDiagnostic(input: CompleteDiagnosticInput): CampaignEvent[] {
    this.assertMutable();
    const diagnostic = this.requiredDiagnostic(input.diagnosticId);
    if (diagnostic.status !== 'scheduled') return [];
    const at = input.completedAt ?? Date.now();
    if (at < diagnostic.dueAt) return [];
    if (at > diagnostic.expiresAt || at > this.manifest.cutoffAt) {
      return this.append('diagnostic_expired', {
        diagnosticId: diagnostic.diagnosticId,
        reason: 'valid observation completed after its fixed cutoff',
      }, at);
    }
    if (!input.validExecutableObservation
      || !Number.isFinite(input.exchangeTimestamp)
      || !Number.isInteger(input.exchangeSequence)
      || !input.reconstructedExitFill
      || input.reconstructedExitFill.aborted
      || !input.reconstructedExitFill.feePolicyKnown) {
      throw new Error('diagnostic scoring requires a complete, fee-resolved, exchange-provenance observation');
    }
    const result: Partial<CampaignDiagnosticRecord> = {
      validExecutableObservation: true,
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
    return this.append('instrumentation_extended', {
      cutoffAt,
      enrollmentCutoffAt: cutoffAt - INSTRUMENTATION_CLOSEOUT_MS,
    }, at);
  }

  expireAtCutoff(at = Date.now()): CampaignEvent[] {
    this.assertMutable();
    if (this.manifest.status !== 'active' || at < this.manifest.cutoffAt) return [];
    const created: CampaignEvent[] = [];
    for (const candidate of this.candidates.values()) {
      if (!candidate.terminalState) created.push(...this.terminalize(candidate.candidateId, 'expired', 'campaign cutoff reached with insufficient evidence', at));
    }
    for (const diagnostic of this.diagnostics.values()) {
      if (diagnostic.status === 'scheduled') created.push(...this.append('diagnostic_expired', {
        diagnosticId: diagnostic.diagnosticId,
        reason: 'campaign cutoff reached without a valid executable follow-up',
      }, at));
    }
    return created;
  }

  invalidate(reason: string, at = Date.now()): CampaignEvent[] {
    this.assertMutable();
    if (!['active', 'closeout'].includes(this.manifest.status)) return [];
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

  finalize(at = Date.now(), finalRuntimeSidecarHash?: string): CampaignEvent[] {
    this.assertMutable();
    if (this.manifest.status === 'active' && at >= this.manifest.cutoffAt) this.prepareCloseout(at);
    if (this.manifest.status !== 'closeout' || at < this.manifest.cutoffAt) return [];
    const created: CampaignEvent[] = [];
    const gate = this.evaluateGates(at);
    created.push(...this.append('run_finalized', {
      passed: gate.passed,
      reasons: gate.reasons,
      finalRuntimeSidecarHash,
    }, at));
    return created;
  }

  prepareCloseout(at = Date.now()): CampaignEvent[] {
    this.assertMutable();
    if (this.manifest.status !== 'active' || at < this.manifest.cutoffAt) return [];
    const created = this.expireAtCutoff(at);
    created.push(...this.append('run_closeout_ready', {
      lastSequence: this.events.at(-1)?.sequence ?? 0,
      lastHash: this.events.at(-1)?.hash ?? 'GENESIS',
    }, at));
    return created;
  }

  private evaluateGates(at = this.manifest.finalizedAt ?? Date.now()): CampaignGateResult {
    const candidates = [...this.candidates.values()];
    const diagnostics = [...this.diagnostics.values()];
    const terminalCount = candidates.filter((candidate) => candidate.terminalState).length;
    const readyCandidates = candidates.filter((candidate) => candidate.terminalState === 'ready').length;
    const scheduledCount = diagnostics.length;
    const validDiagnosticOutcomes = diagnostics.filter((diagnostic) => diagnostic.status === 'scored' && diagnostic.validExecutableObservation).length;
    const allSamples = candidates.flatMap((candidate) => candidate.samples);
    const freshSamples = allSamples.filter((sample) => {
      const ageMs = sample.observedAt - sample.exchangeTimestamp;
      return ageMs >= 0 && ageMs <= this.settings.maxBookAgeMs;
    }).length;
    const terminalCoverage = candidates.length > 0 ? terminalCount / candidates.length : 0;
    const diagnosticSchedulingCoverage = candidates.length > 0 ? scheduledCount / candidates.length : 0;
    const validDiagnosticCoverage = scheduledCount > 0 ? validDiagnosticOutcomes / scheduledCount : 0;
    const freshConfirmationRate = allSamples.length > 0 ? freshSamples / allSamples.length : 0;
    const failedOperationalChecks = this.operationalChecks.filter((check) => !check.passed);
    const rendererMemoryCheck = this.operationalChecks.find((check) => check.name === 'renderer_memory_stable' && check.passed);
    const bridgeTrafficCheck = this.operationalChecks.find((check) => check.name === 'bridge_bidirectional_traffic' && check.passed);
    const exchangeBookTimeCheck = [...this.operationalChecks]
      .filter((check) => check.name === 'exchange_book_time_available')
      .sort((left, right) => right.at - left.at)[0];
    const exchangeBookTimeCurrent = exchangeBookTimeCheck?.passed === true
      && exchangeBookTimeCheck.at <= at
      && at - exchangeBookTimeCheck.at <= OPERATIONAL_CHECK_LEASE_MS;
    const reasons: string[] = [];
    if (this.manifest.status === 'invalidated') {
      reasons.push(this.manifest.invalidationReason ?? 'campaign attempt was invalidated');
    }
    if (this.integrityError) reasons.push(this.integrityError);
    if (this.safetyFailures.length > 0) reasons.push(`${this.safetyFailures.length} blocking safety failure(s)`);
    if (failedOperationalChecks.length > 0) reasons.push(`${failedOperationalChecks.length} operational check(s) failed`);
    if (!rendererMemoryCheck) reasons.push('renderer memory stabilization was not proven');
    if (!bridgeTrafficCheck) reasons.push('recent bidirectional bridge traffic was not proven');
    if (!exchangeBookTimeCurrent) reasons.push('current exchange-origin book timestamp and sequence were not proven at closeout');
    if (this.manifest.schemaVersion === 2 && this.manifest.restartOrdinal > 0) {
      reasons.push('campaign attempt used a supervisor recovery restart');
    }
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

  /**
   * Cheap projection for the high-frequency book-update path. Copies only the
   * primitive fields campaignBookUpdateWork reads into fresh objects (no
   * structuredClone, no operationalChecks/samples), so cost is O(candidates +
   * diagnostics) — bounded by enrolled count, not by soak duration or ledger size.
   */
  bookUpdateView(): CampaignBookUpdateView {
    return {
      manifest: { status: this.manifest.status },
      candidates: [...this.candidates.values()].map((candidate) => ({
        economicIdentity: candidate.economicIdentity,
        ticker: candidate.ticker,
        candidateId: candidate.candidateId,
        terminalState: candidate.terminalState,
      })),
      diagnostics: [...this.diagnostics.values()].map((diagnostic) => ({
        candidateId: diagnostic.candidateId,
        status: diagnostic.status,
        dueAt: diagnostic.dueAt,
      })),
    };
  }

  snapshot(): CampaignSnapshot {
    const gate = this.evaluateGates();
    return {
      manifest: clone(this.manifest),
      candidates: clone([...this.candidates.values()]),
      diagnostics: clone([...this.diagnostics.values()]),
      screenedOut: clone([...this.screenedOut.values()]),
      safetyFailures: clone(this.safetyFailures),
      operationalChecks: clone(this.operationalChecks),
      eventCount: this.events.length,
      lastSequence: this.events.at(-1)?.sequence ?? 0,
      lastHash: this.events.at(-1)?.hash ?? 'GENESIS',
      readOnly: this.readOnly,
      integrityError: this.integrityError,
      ...gate,
    };
  }
}

export {
  DIAGNOSTIC_RETRY_OFFSETS_MS,
  DIAGNOSTIC_OBSERVATION_WINDOW_MS,
  INSTRUMENTATION_CLOSEOUT_MS,
  OPERATIONAL_CHECK_LEASE_MS,
};
