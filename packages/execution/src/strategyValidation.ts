import { createHash, randomUUID } from 'node:crypto';
import type { EntryQualificationSettings, StrategyValidationStage } from '@nemesis/core';
import type { EntryEconomicsEvidence } from './tradeEconomics.js';

export const STRATEGY_VALIDATION_SCHEMA_VERSION = 2;
const SUPPORTED_STRATEGY_VALIDATION_SCHEMAS = new Set([1, STRATEGY_VALIDATION_SCHEMA_VERSION]);

/**
 * Maximum share of scored shadows that may be excluded as data-plane
 * contaminated before the sample stops being a test of the strategy at all.
 *
 * Contamination is *not* random with respect to outcome: a degraded data plane
 * produces bad entries, and bad entries produce losses, so the excluded
 * population is systematically loss-heavy. Below this bound, dropping a few
 * degraded rows is noise reduction. Above it, the exclusion is doing so much of
 * the work that the surviving rows flatter the strategy by construction — the
 * honest reading is that the run is a diagnostic, not evidence about edge, the
 * same standard the run-level data-plane gates already apply.
 *
 * This is a validity bound on the sample, not an acceptance threshold: it can
 * only ever hold the gate closed, never open it.
 */
export const SHADOW_MAX_CONTAMINATED_SHARE = 0.2;

export interface ShadowCandidateEvidence {
  id: string;
  sourceSignalId: string;
  ticker: string;
  side: 'yes' | 'no';
  playbook: string;
  startedAt: number;
  dueAt: number;
  contracts: number;
  entryPrice: number;
  entryFeesUsd: number;
  initialNetEdge: number;
  /** Conditional reward if the model target is reached. */
  targetRewardUsd?: number;
  /** @deprecated Schema-1 compatibility alias. */
  expectedRewardUsd?: number;
  plannedLossUsd: number;
  rewardRiskRatio: number;
  stressedTargetNetPnlUsd?: number;
  /** @deprecated Schema-1 compatibility alias. */
  stressedExpectedNetPnlUsd?: number;
  /**
   * True when the orderbook data plane was latched degraded at the moment this
   * candidate was entered. An entry made on a book that could not prove itself
   * is a bad entry regardless of how cleanly it later exits, so the scored row
   * is excluded from every acceptance tally. Additive and optional: absent
   * means false, and historical ledgers written before this field replay
   * byte-identically.
   */
  dataPlaneDegraded?: boolean;
}

interface ValidationEventBase {
  schemaVersion: 1 | 2;
  runId: string;
  sequence: number;
  at: number;
  previousHash: string;
  hash: string;
}

export type StrategyValidationEvent = ValidationEventBase & (
  | {
    type: 'validation_run_started';
    stage: StrategyValidationStage;
    strategyConfigHash: string;
    strategyEngineVersion: number;
  }
  | { type: 'shadow_candidate_started'; candidate: ShadowCandidateEvidence }
  | {
    type: 'entry_confirmation_observed';
    sourceSignalId: string;
    ticker: string;
    side: 'yes' | 'no';
    status: 'pending' | 'rejected' | 'ready';
    reason: string;
    samples: number;
    windowMs: number;
    edgeRetention: number;
    targetRewardUsd?: number;
    expectedRewardUsd: number;
    plannedLossUsd: number;
    rewardRiskRatio: number;
    stressedNetPnlUsd: number;
    economics?: EntryEconomicsEvidence;
    /**
     * True when this observation was made while the orderbook data plane was
     * latched degraded. Such rejections describe missing data, not absent edge,
     * and must be excluded from any economic verdict.
     */
    dataPlaneDegraded?: boolean;
  }
  | {
    type: 'shadow_candidate_observed';
    candidateId: string;
    executableNetPnlUsd: number;
    stressedNetPnlUsd: number;
    netEdge: number;
  }
  | {
    type: 'shadow_candidate_scored';
    candidateId: string;
    netPnlUsd: number;
    stressedNetPnlUsd: number;
    closeReason: string;
    /**
     * True when the orderbook data plane was latched degraded at the moment of
     * scoring. The exit mark is then untrustworthy, so the row is excluded from
     * every acceptance tally. Absent means false.
     */
    dataPlaneDegraded?: boolean;
  }
  | { type: 'validation_stage_changed'; stage: StrategyValidationStage; confirmation: string }
  | { type: 'validation_paused'; reason: string }
);

export interface StrategyValidationSnapshot {
  schemaVersion: 1 | 2;
  runId: string;
  stage: StrategyValidationStage;
  strategyConfigHash: string;
  strategyEngineVersion: number;
  lastSequence: number;
  integrityError?: string;
  /**
   * Scored shadows counted by the acceptance gate. Clean population only:
   * rows whose entry and scoring were both recorded outside a degraded
   * data-plane window.
   */
  shadowCandidateCount: number;
  /**
   * Scored shadows excluded from every acceptance tally because the data plane
   * was latched degraded at entry, at scoring, or both. Recorded and reported,
   * never suppressed — but never evidence about edge.
   */
  shadowContaminatedCount: number;
  /**
   * Net P&L of the excluded population. Visibility only: this value is not an
   * input to any gate and must never be merged into shadowNetPnlUsd.
   */
  shadowContaminatedNetPnlUsd: number;
  /**
   * contaminated / (clean + contaminated) over scored shadows; 0 when nothing
   * has been scored. Measures how much of the verdict is being carried by the
   * exclusion itself.
   */
  shadowContaminatedShare: number;
  /**
   * True when shadowContaminatedShare exceeds SHADOW_MAX_CONTAMINATED_SHARE, so
   * the sample is not a valid test of the strategy and the gate is held closed.
   * Surfaced explicitly so the reason never has to be inferred from arithmetic.
   */
  shadowContaminationBlocked: boolean;
  shadowPendingCount: number;
  shadowWinRate: number;
  shadowGrossProfitUsd: number;
  shadowGrossLossUsd: number;
  shadowProfitFactor: number;
  shadowNetPnlUsd: number;
  shadowStressedNetPnlUsd: number;
  shadowStressedProfitFactor: number;
  shadowLargestWinShare: number;
  shadowDistinctDayCount: number;
  shadowObservationWindowMs: number;
  /** Effective acceptance bar used for shadowPassed (includes env/settings overrides). */
  shadowMinScored: number;
  /** Effective distinct-day bar; 1 means same-day is enough (days do not block). */
  shadowMinDistinctDays: number;
  /** Effective elapsed observation bar; 0 means elapsed age does not block. */
  shadowMinObservationMs: number;
  /** Count + elapsed/calendared sample-size bars met (quality may still fail). */
  shadowCountPassed: boolean;
  /** Edge quality bars met (PF / win rate / net / stressed / concentration). */
  shadowQualityPassed: boolean;
  /** Full shadow gate: count + quality + not paused + no integrity error. */
  shadowPassed: boolean;
  paused: boolean;
  pauseReason?: string;
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function ratio(wins: number, losses: number): number {
  if (losses > 0) return wins / losses;
  return wins > 0 ? Number.POSITIVE_INFINITY : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventHash(event: Omit<StrategyValidationEvent, 'hash'>): string {
  return createHash('sha256').update(stableJson(event)).digest('hex');
}

function localDay(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export class StrategyValidationTracker {
  private readonly events: StrategyValidationEvent[] = [];
  private readonly pending = new Map<string, ShadowCandidateEvidence>();
  private readonly usedSources = new Set<string>();
  /**
   * Candidate ids whose entry was recorded while the data plane was degraded.
   * Kept beyond scoring (unlike `pending`) so the scored row can still be
   * attributed to a contaminated entry. Rebuilt identically on replay.
   */
  private readonly degradedStarts = new Set<string>();
  private integrityError?: string;
  private stage: StrategyValidationStage;

  private constructor(
    readonly runId: string,
    stage: StrategyValidationStage,
    readonly strategyConfigHash: string,
    readonly strategyEngineVersion: number,
    readonly schemaVersion: 1 | 2,
  ) {
    this.stage = stage;
  }

  static create(
    stage: StrategyValidationStage,
    strategyConfigHash: string,
    strategyEngineVersion: number,
    now = Date.now(),
    runId = `svr-${now}-${randomUUID()}`,
    schemaVersion: 1 | 2 = STRATEGY_VALIDATION_SCHEMA_VERSION,
  ): StrategyValidationTracker {
    const tracker = new StrategyValidationTracker(
      runId,
      stage,
      strategyConfigHash,
      strategyEngineVersion,
      schemaVersion,
    );
    tracker.add('validation_run_started', { stage, strategyConfigHash, strategyEngineVersion }, now);
    return tracker;
  }

  static replay(events: StrategyValidationEvent[]): StrategyValidationTracker {
    const first = events[0];
    if (!first || first.type !== 'validation_run_started') {
      const broken = new StrategyValidationTracker('invalid', 'shadow', '', 0, STRATEGY_VALIDATION_SCHEMA_VERSION);
      broken.integrityError = 'strategy validation ledger missing validation_run_started event';
      return broken;
    }
    const schemaVersion = first.schemaVersion;
    const tracker = new StrategyValidationTracker(
      first.runId,
      first.stage,
      first.strategyConfigHash,
      first.strategyEngineVersion,
      schemaVersion,
    );
    if (!SUPPORTED_STRATEGY_VALIDATION_SCHEMAS.has(schemaVersion)) {
      tracker.integrityError = 'strategy validation ledger schema mismatch';
      return tracker;
    }
    let previousHash = 'GENESIS';
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.schemaVersion !== schemaVersion) {
        tracker.integrityError = 'strategy validation ledger schema mismatch';
        break;
      }
      if (event.runId !== tracker.runId || event.sequence !== index + 1) {
        tracker.integrityError = 'strategy validation ledger run or sequence mismatch';
        break;
      }
      const { hash, ...unsigned } = event;
      if (event.previousHash !== previousHash || hash !== eventHash(unsigned as Omit<StrategyValidationEvent, 'hash'>)) {
        tracker.integrityError = 'strategy validation ledger hash chain mismatch';
        break;
      }
      tracker.events.push(JSON.parse(JSON.stringify(event)) as StrategyValidationEvent);
      tracker.apply(event);
      previousHash = event.hash;
    }
    return tracker;
  }

  private add<T extends StrategyValidationEvent['type']>(
    type: T,
    payload: Omit<Extract<StrategyValidationEvent, { type: T }>, keyof ValidationEventBase | 'type'>,
    at = Date.now(),
  ): Extract<StrategyValidationEvent, { type: T }> {
    if (this.integrityError) throw new Error(this.integrityError);
    const unsigned = {
      schemaVersion: this.schemaVersion,
      runId: this.runId,
      sequence: this.events.length + 1,
      at,
      previousHash: this.events.at(-1)?.hash ?? 'GENESIS',
      type,
      ...payload,
    } as Omit<Extract<StrategyValidationEvent, { type: T }>, 'hash'>;
    const event = { ...unsigned, hash: eventHash(unsigned as Omit<StrategyValidationEvent, 'hash'>) } as Extract<StrategyValidationEvent, { type: T }>;
    this.events.push(event);
    this.apply(event);
    return event;
  }

  private apply(event: StrategyValidationEvent): void {
    if (event.type === 'shadow_candidate_started') {
      this.pending.set(event.candidate.id, { ...event.candidate });
      this.usedSources.add(event.candidate.sourceSignalId);
      if (event.candidate.dataPlaneDegraded === true) this.degradedStarts.add(event.candidate.id);
    } else if (event.type === 'shadow_candidate_scored') {
      this.pending.delete(event.candidateId);
    } else if (event.type === 'validation_stage_changed') {
      this.stage = event.stage;
    }
  }

  startShadowCandidate(candidate: ShadowCandidateEvidence): StrategyValidationEvent {
    if (this.usedSources.has(candidate.sourceSignalId)) throw new Error('source signal already used');
    if (this.stage !== 'shadow') throw new Error('shadow candidates require shadow stage');
    const targetRewardUsd = candidate.targetRewardUsd ?? candidate.expectedRewardUsd;
    if (!Number.isFinite(targetRewardUsd)) throw new Error('shadow candidate target reward is missing');
    const stressedTargetNetPnlUsd = candidate.stressedTargetNetPnlUsd ?? candidate.stressedExpectedNetPnlUsd;
    if (!Number.isFinite(stressedTargetNetPnlUsd)) throw new Error('shadow candidate stressed target result is missing');
    const normalized: ShadowCandidateEvidence = {
      ...candidate,
      targetRewardUsd: targetRewardUsd!,
      expectedRewardUsd: targetRewardUsd!,
      stressedTargetNetPnlUsd: stressedTargetNetPnlUsd!,
      stressedExpectedNetPnlUsd: stressedTargetNetPnlUsd!,
    };
    // Canonical form: the flag is written only when true, so a clean candidate
    // hashes exactly as it did before this field existed.
    if (candidate.dataPlaneDegraded === true) normalized.dataPlaneDegraded = true;
    else delete normalized.dataPlaneDegraded;
    return this.add('shadow_candidate_started', { candidate: normalized }, candidate.startedAt);
  }

  recordEntryConfirmation(input: {
    sourceSignalId: string;
    ticker: string;
    side: 'yes' | 'no';
    status: 'pending' | 'rejected' | 'ready';
    reason: string;
    samples: number;
    windowMs: number;
    edgeRetention: number;
    targetRewardUsd: number;
    expectedRewardUsd?: number;
    plannedLossUsd: number;
    rewardRiskRatio: number;
    stressedNetPnlUsd: number;
    economics: EntryEconomicsEvidence;
    dataPlaneDegraded?: boolean;
    at?: number;
  }): StrategyValidationEvent {
    const { at, ...rest } = input;
    const payload = {
      ...rest,
      expectedRewardUsd: input.expectedRewardUsd ?? input.targetRewardUsd,
    };
    return this.add('entry_confirmation_observed', payload, at);
  }

  observeShadowCandidate(
    candidateId: string,
    executableNetPnlUsd: number,
    stressedNetPnlUsd: number,
    netEdge: number,
    at = Date.now(),
  ): StrategyValidationEvent {
    if (!this.pending.has(candidateId)) throw new Error('shadow candidate is not pending');
    return this.add('shadow_candidate_observed', {
      candidateId,
      executableNetPnlUsd: round(executableNetPnlUsd),
      stressedNetPnlUsd: round(stressedNetPnlUsd),
      netEdge: round(netEdge),
    }, at);
  }

  scoreShadowCandidate(
    candidateId: string,
    netPnlUsd: number,
    stressedNetPnlUsd: number,
    closeReason: string,
    at = Date.now(),
    dataPlaneDegraded = false,
  ): StrategyValidationEvent {
    if (!this.pending.has(candidateId)) throw new Error('shadow candidate is not pending');
    return this.add('shadow_candidate_scored', {
      candidateId,
      netPnlUsd: round(netPnlUsd),
      stressedNetPnlUsd: round(stressedNetPnlUsd),
      closeReason,
      // Written only when true, so a clean score hashes as it did before.
      ...(dataPlaneDegraded === true ? { dataPlaneDegraded: true } : {}),
    }, at);
  }

  changeStage(stage: StrategyValidationStage, confirmation: string, at = Date.now()): StrategyValidationEvent {
    if (confirmation !== `ADVANCE_TO_${stage.toUpperCase()}`) throw new Error(`confirmation must equal ADVANCE_TO_${stage.toUpperCase()}`);
    const nextStage = this.stage === 'shadow' ? 'pilot' : this.stage === 'pilot' ? 'qualification' : null;
    if (stage !== nextStage) throw new Error(`cannot advance strategy validation from ${this.stage} to ${stage}`);
    return this.add('validation_stage_changed', { stage, confirmation }, at);
  }

  pause(reason: string, at = Date.now()): StrategyValidationEvent {
    return this.add('validation_paused', { reason }, at);
  }

  pendingCandidates(): ShadowCandidateEvidence[] {
    return [...this.pending.values()].map((candidate) => ({ ...candidate }));
  }

  recentObservations(candidateId: string, limit = 3): Array<{
    at: number;
    executableNetPnlUsd: number;
    stressedNetPnlUsd: number;
    netEdge: number;
  }> {
    return this.events
      .filter((event): event is Extract<StrategyValidationEvent, { type: 'shadow_candidate_observed' }> =>
        event.type === 'shadow_candidate_observed' && event.candidateId === candidateId)
      .slice(-Math.max(1, limit))
      .map((event) => ({
        at: event.at,
        executableNetPnlUsd: event.executableNetPnlUsd,
        stressedNetPnlUsd: event.stressedNetPnlUsd,
        netEdge: event.netEdge,
      }));
  }

  hasUsedSource(sourceSignalId: string): boolean {
    return this.usedSources.has(sourceSignalId);
  }

  allEvents(): StrategyValidationEvent[] {
    return this.events.map((event) => JSON.parse(JSON.stringify(event)) as StrategyValidationEvent);
  }

  eventsAfter(sequence: number): StrategyValidationEvent[] {
    return this.allEvents().filter((event) => event.sequence > sequence);
  }

  lastSequence(): number {
    return this.events.at(-1)?.sequence ?? 0;
  }

  integrityFailure(): string | undefined {
    return this.integrityError;
  }

  /**
   * A scored shadow is contaminated when the data plane was latched degraded at
   * entry OR at scoring. Absent flags mean false, so ledgers written before the
   * flag existed are entirely clean.
   */
  private isContaminated(score: Extract<StrategyValidationEvent, { type: 'shadow_candidate_scored' }>): boolean {
    return score.dataPlaneDegraded === true || this.degradedStarts.has(score.candidateId);
  }

  snapshot(settings: EntryQualificationSettings): StrategyValidationSnapshot {
    const allScores = this.events.filter((event): event is Extract<StrategyValidationEvent, { type: 'shadow_candidate_scored' }> => event.type === 'shadow_candidate_scored');
    // A scored shadow is contaminated when *either* end touched a degraded
    // window: a bad entry is bad however cleanly it exits, and a mark taken on
    // an unproven book is not a mark. Contaminated rows stay in the ledger and
    // are reported below, but no acceptance tally may read them.
    const contaminated = allScores.filter((score) => this.isContaminated(score));
    const scores = allScores.filter((score) => !this.isContaminated(score));
    const rows = scores.map((score) => score.netPnlUsd);
    const stressed = scores.map((score) => score.stressedNetPnlUsd);
    const scoreTimes = scores.map((score) => score.at);
    const grossProfit = rows.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(rows.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    const stressedProfit = stressed.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const stressedLoss = Math.abs(stressed.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    const largestWin = rows.filter((value) => value > 0).reduce((largest, value) => Math.max(largest, value), 0);
    const distinctDays = new Set(scores.map((score) => localDay(score.at))).size;
    const shadowObservationWindowMs = scoreTimes.length > 0
      ? Math.max(...scoreTimes) - Math.min(...scoreTimes)
      : 0;
    const profitFactor = ratio(grossProfit, grossLoss);
    const stressedProfitFactor = ratio(stressedProfit, stressedLoss);
    const netPnl = rows.reduce((sum, value) => sum + value, 0);
    const stressedNetPnl = stressed.reduce((sum, value) => sum + value, 0);
    const winRate = rows.length > 0 ? rows.filter((value) => value > 0).length / rows.length : 0;
    const largestWinShare = grossProfit > 0 ? largestWin / grossProfit : 0;
    const pauseEvent = this.events.filter((event): event is Extract<StrategyValidationEvent, { type: 'validation_paused' }> => event.type === 'validation_paused').at(-1);
    const eligible = !pauseEvent && !this.integrityError;
    // Validity bound on the sample, evaluated on the unrounded share. Because
    // contamination correlates with losses, a heavily contaminated ledger would
    // otherwise report a flattering clean subset; treat it as "not a test"
    // rather than as a quality failure, so shadowQualityPassed below keeps
    // telling the operator the truth about the clean rows.
    const scoredTotal = rows.length + contaminated.length;
    const contaminatedShare = scoredTotal > 0 ? contaminated.length / scoredTotal : 0;
    const shadowContaminationBlocked = contaminatedShare > SHADOW_MAX_CONTAMINATED_SHARE;
    const shadowCountPassed = eligible
      && !shadowContaminationBlocked
      && rows.length >= settings.shadowMinScored
      && distinctDays >= settings.shadowMinDistinctDays
      && shadowObservationWindowMs >= settings.shadowMinObservationMs;
    const shadowQualityPassed = netPnl > 0
      && profitFactor >= settings.shadowMinProfitFactor
      && winRate >= settings.shadowMinWinRate
      && stressedNetPnl > 0
      && stressedProfitFactor >= settings.shadowMinStressedProfitFactor
      && largestWinShare <= 0.2;
    const shadowPassed = shadowCountPassed && shadowQualityPassed;

    return {
      schemaVersion: this.schemaVersion,
      runId: this.runId,
      stage: this.stage,
      strategyConfigHash: this.strategyConfigHash,
      strategyEngineVersion: this.strategyEngineVersion,
      lastSequence: this.lastSequence(),
      integrityError: this.integrityError,
      shadowCandidateCount: rows.length,
      shadowContaminatedCount: contaminated.length,
      shadowContaminatedNetPnlUsd: round(contaminated.reduce((sum, score) => sum + score.netPnlUsd, 0)),
      shadowContaminatedShare: round(contaminatedShare),
      shadowContaminationBlocked,
      shadowPendingCount: this.pending.size,
      shadowWinRate: round(winRate),
      shadowGrossProfitUsd: round(grossProfit),
      shadowGrossLossUsd: round(grossLoss),
      shadowProfitFactor: round(profitFactor),
      shadowNetPnlUsd: round(netPnl),
      shadowStressedNetPnlUsd: round(stressedNetPnl),
      shadowStressedProfitFactor: round(stressedProfitFactor),
      shadowLargestWinShare: round(largestWinShare),
      shadowDistinctDayCount: distinctDays,
      shadowObservationWindowMs,
      shadowMinScored: settings.shadowMinScored,
      shadowMinDistinctDays: settings.shadowMinDistinctDays,
      shadowMinObservationMs: settings.shadowMinObservationMs,
      shadowCountPassed,
      shadowQualityPassed,
      shadowPassed,
      paused: Boolean(pauseEvent),
      pauseReason: pauseEvent?.reason,
    };
  }
}
