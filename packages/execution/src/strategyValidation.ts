import { createHash, randomUUID } from 'node:crypto';
import type { EntryQualificationSettings, StrategyValidationStage } from '@nemesis/core';

export const STRATEGY_VALIDATION_SCHEMA_VERSION = 1;

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
  expectedRewardUsd: number;
  plannedLossUsd: number;
  rewardRiskRatio: number;
  stressedExpectedNetPnlUsd: number;
}

interface ValidationEventBase {
  schemaVersion: 1;
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
    expectedRewardUsd: number;
    plannedLossUsd: number;
    rewardRiskRatio: number;
    stressedNetPnlUsd: number;
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
  }
  | { type: 'validation_stage_changed'; stage: StrategyValidationStage; confirmation: string }
  | { type: 'validation_paused'; reason: string }
);

export interface StrategyValidationSnapshot {
  runId: string;
  stage: StrategyValidationStage;
  strategyConfigHash: string;
  strategyEngineVersion: number;
  lastSequence: number;
  integrityError?: string;
  shadowCandidateCount: number;
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
  private integrityError?: string;
  private stage: StrategyValidationStage;

  private constructor(
    readonly runId: string,
    stage: StrategyValidationStage,
    readonly strategyConfigHash: string,
    readonly strategyEngineVersion: number,
  ) {
    this.stage = stage;
  }

  static create(
    stage: StrategyValidationStage,
    strategyConfigHash: string,
    strategyEngineVersion: number,
    now = Date.now(),
    runId = `svr-${now}-${randomUUID()}`,
  ): StrategyValidationTracker {
    const tracker = new StrategyValidationTracker(runId, stage, strategyConfigHash, strategyEngineVersion);
    tracker.add('validation_run_started', { stage, strategyConfigHash, strategyEngineVersion }, now);
    return tracker;
  }

  static replay(events: StrategyValidationEvent[]): StrategyValidationTracker {
    const first = events[0];
    if (!first || first.type !== 'validation_run_started') {
      const broken = new StrategyValidationTracker('invalid', 'shadow', '', 0);
      broken.integrityError = 'strategy validation ledger missing validation_run_started event';
      return broken;
    }
    const tracker = new StrategyValidationTracker(first.runId, first.stage, first.strategyConfigHash, first.strategyEngineVersion);
    let previousHash = 'GENESIS';
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.schemaVersion !== STRATEGY_VALIDATION_SCHEMA_VERSION) {
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
      schemaVersion: STRATEGY_VALIDATION_SCHEMA_VERSION,
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
    } else if (event.type === 'shadow_candidate_scored') {
      this.pending.delete(event.candidateId);
    } else if (event.type === 'validation_stage_changed') {
      this.stage = event.stage;
    }
  }

  startShadowCandidate(candidate: ShadowCandidateEvidence): StrategyValidationEvent {
    if (this.usedSources.has(candidate.sourceSignalId)) throw new Error('source signal already used');
    if (this.stage !== 'shadow') throw new Error('shadow candidates require shadow stage');
    return this.add('shadow_candidate_started', { candidate }, candidate.startedAt);
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
    expectedRewardUsd: number;
    plannedLossUsd: number;
    rewardRiskRatio: number;
    stressedNetPnlUsd: number;
    at?: number;
  }): StrategyValidationEvent {
    const { at, ...payload } = input;
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
  ): StrategyValidationEvent {
    if (!this.pending.has(candidateId)) throw new Error('shadow candidate is not pending');
    return this.add('shadow_candidate_scored', {
      candidateId,
      netPnlUsd: round(netPnlUsd),
      stressedNetPnlUsd: round(stressedNetPnlUsd),
      closeReason,
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

  snapshot(settings: EntryQualificationSettings): StrategyValidationSnapshot {
    const scores = this.events.filter((event): event is Extract<StrategyValidationEvent, { type: 'shadow_candidate_scored' }> => event.type === 'shadow_candidate_scored');
    const rows = scores.map((score) => score.netPnlUsd);
    const stressed = scores.map((score) => score.stressedNetPnlUsd);
    const grossProfit = rows.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(rows.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    const stressedProfit = stressed.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const stressedLoss = Math.abs(stressed.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    const largestWin = rows.filter((value) => value > 0).reduce((largest, value) => Math.max(largest, value), 0);
    const distinctDays = new Set(scores.map((score) => localDay(score.at))).size;
    const profitFactor = ratio(grossProfit, grossLoss);
    const stressedProfitFactor = ratio(stressedProfit, stressedLoss);
    const netPnl = rows.reduce((sum, value) => sum + value, 0);
    const stressedNetPnl = stressed.reduce((sum, value) => sum + value, 0);
    const winRate = rows.length > 0 ? rows.filter((value) => value > 0).length / rows.length : 0;
    const largestWinShare = grossProfit > 0 ? largestWin / grossProfit : 0;
    const pauseEvent = this.events.filter((event): event is Extract<StrategyValidationEvent, { type: 'validation_paused' }> => event.type === 'validation_paused').at(-1);
    const shadowPassed = rows.length >= settings.shadowMinScored
      && distinctDays >= settings.shadowMinDistinctDays
      && netPnl > 0
      && profitFactor >= settings.shadowMinProfitFactor
      && winRate >= settings.shadowMinWinRate
      && stressedNetPnl > 0
      && stressedProfitFactor >= settings.shadowMinStressedProfitFactor
      && largestWinShare <= 0.2
      && !pauseEvent
      && !this.integrityError;

    return {
      runId: this.runId,
      stage: this.stage,
      strategyConfigHash: this.strategyConfigHash,
      strategyEngineVersion: this.strategyEngineVersion,
      lastSequence: this.lastSequence(),
      integrityError: this.integrityError,
      shadowCandidateCount: rows.length,
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
      shadowPassed,
      paused: Boolean(pauseEvent),
      pauseReason: pauseEvent?.reason,
    };
  }
}
