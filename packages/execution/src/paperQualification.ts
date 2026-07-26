import { kalshiFeeForOrder, type PaperTrade } from '@nemesis/core';
import { createHash, randomUUID } from 'node:crypto';
import { ProfitabilityBenchmark, type BenchmarkReport, type BenchmarkStrategy } from './profitabilityBenchmark.js';

export const PAPER_QUALIFICATION_SCHEMA_VERSION = 1;
export const CLOSE_FOLLOW_UP_MS = 15 * 60 * 1_000;

export type QualificationFunnelStage =
  | 'raw_candidates'
  | 'entry_blocked'
  | 'duplicates_removed'
  | 'entry_eligible'
  | 'books_fetched'
  | 'books_unavailable'
  | 'certified'
  | 'executed';

export interface CompletedPaperPosition {
  positionId: string;
  ticker: string;
  side: 'yes' | 'no';
  playbook: string;
  openedAt: number;
  closedAt: number;
  openOperations: number;
  closeOperations: number;
  contracts: number;
  entryRiskUsd: number;
  exitProceedsUsd: number;
  netPnlUsd: number;
  stressedNetPnlUsd: number;
  avgSlippagePp: number;
}

export interface CloseFollowUp {
  id: string;
  strategy: BenchmarkStrategy;
  positionId: string;
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  actualNetProceedsUsd: number;
  entryRiskUsd: number;
  netPnlUsd: number;
  maxDrawdownUsd: number;
  slippageUsd: number;
  startedAt: number;
  dueAt: number;
  bestHypotheticalNetProceedsUsd?: number;
}

interface QualificationEventBase {
  schemaVersion: typeof PAPER_QUALIFICATION_SCHEMA_VERSION;
  runId: string;
  sequence: number;
  at: number;
  previousHash: string;
  hash: string;
}

export type PaperQualificationEvent = QualificationEventBase & (
  | { type: 'run_started'; startingCash: number; strategyConfigHash: string }
  | { type: 'paper_open'; trade: PaperTrade }
  | { type: 'paper_close'; trade: PaperTrade; strategy: BenchmarkStrategy | 'settlement'; entryRiskUsd: number; maxDrawdownUsd: number }
  | { type: 'paper_abort'; code: string; reason: string; blocking: boolean }
  | { type: 'position_completed'; position: CompletedPaperPosition }
  | { type: 'equity_checkpoint'; equity: number }
  | { type: 'position_worst_loss'; positionId: string; worstUnrealizedLossUsd: number }
  | { type: 'close_follow_up_started'; followUp: CloseFollowUp }
  | { type: 'close_follow_up_observed'; followUpId: string; hypotheticalNetProceedsUsd: number }
  | { type: 'close_follow_up_scored'; followUpId: string; closeRegretUsd: number; falseExit: boolean }
  | { type: 'close_follow_up_unscored'; followUpId: string; reason: string }
  | { type: 'funnel_increment'; stage: QualificationFunnelStage; count: number; reason?: string }
  | { type: 'safety_block'; code: string; detail: string }
  | { type: 'rolling_loss_pause'; detail: string }
  | { type: 'configuration_invalidated'; actualHash: string }
);

export interface PaperQualificationSnapshot {
  runId: string;
  startedAt: number;
  startingCash: number;
  strategyConfigHash: string;
  lastSequence: number;
  integrityError?: string;
  completedPositionCount: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number;
  averageNetPnlUsd: number;
  realizedPnlUsd: number;
  entryRiskUsd: number;
  pnlPerRiskDollar: number;
  winRate: number;
  largestWinShare: number;
  profitableWeekCount: number;
  profitConfidenceRate: number;
  stressedNetPnlUsd: number;
  stressedProfitFactor: number;
  rollingTwentyPnlUsd: number;
  rollingTwentyProfitFactor: number;
  rollingLossPaused: boolean;
  configurationValid: boolean;
  manualScoredCloseCount: number;
  automaticScoredCloseCount: number;
  pendingFollowUpCount: number;
  unscoredFollowUpCount: number;
  benchmark: BenchmarkReport;
  benchmarkPassed: boolean;
  avgSlippagePp: number;
  automaticFalseExitRate: number;
  automaticAvgCloseRegretUsd: number;
  endingEquity: number;
  maxDrawdownUsd: number;
  blockingSafetyEventCount: number;
  auditClean: boolean;
  funnel: Record<QualificationFunnelStage, number>;
  rejectionReasons: Record<string, number>;
}

interface ActivePositionEvidence {
  opens: PaperTrade[];
  closes: PaperTrade[];
}

const FUNNEL_STAGES: QualificationFunnelStage[] = [
  'raw_candidates',
  'entry_blocked',
  'duplicates_removed',
  'entry_eligible',
  'books_fetched',
  'books_unavailable',
  'certified',
  'executed',
];

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
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

function hashEvent(event: Omit<PaperQualificationEvent, 'hash'>): string {
  return createHash('sha256').update(stableJson(event)).digest('hex');
}

function ratio(wins: number, losses: number): number {
  if (losses > 0) return wins / losses;
  return wins > 0 ? Number.POSITIVE_INFINITY : 0;
}

function stressedTradeValue(trade: PaperTrade): number {
  const stressedPrice = trade.type === 'open'
    ? Math.min(1, trade.price + 0.01)
    : Math.max(0, trade.price - 0.01);
  const fees = kalshiFeeForOrder(stressedPrice, trade.contracts);
  return trade.type === 'open'
    ? -(stressedPrice * trade.contracts + fees)
    : stressedPrice * trade.contracts - fees;
}

function localDateParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    weekday: value('weekday'),
  };
}

function weekStartKey(timestamp: number): string {
  const local = localDateParts(timestamp);
  const weekdayOffset = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[local.weekday] ?? 0;
  const monday = new Date(Date.UTC(local.year, local.month - 1, local.day - weekdayOffset));
  return monday.toISOString().slice(0, 10);
}

function completedProfitableWeekCount(positions: CompletedPaperPosition[], now: number): number {
  const currentWeek = weekStartKey(now);
  const weekly = new Map<string, number>();
  for (const position of positions) {
    const key = weekStartKey(position.closedAt);
    weekly.set(key, (weekly.get(key) ?? 0) + position.netPnlUsd);
  }
  const keys = [...weekly.keys()].filter((key) => key < currentWeek).sort();
  if (keys.length === 0) return 0;
  const first = Date.parse(`${keys[0]}T00:00:00Z`);
  const last = Date.parse(`${keys.at(-1)}T00:00:00Z`);
  let current = 0;
  let longest = 0;
  for (let stamp = first; stamp <= last; stamp += 7 * 24 * 60 * 60 * 1_000) {
    const key = new Date(stamp).toISOString().slice(0, 10);
    if ((weekly.get(key) ?? 0) > 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function xorshift32(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function profitabilityConfidenceRate(
  pnlRows: number[],
  samples = 10_000,
  seed = 0x4e454d45,
): number {
  if (pnlRows.length === 0 || samples < 1) return 0;
  const random = xorshift32(seed);
  let profitable = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let i = 0; i < pnlRows.length; i += 1) {
      total += pnlRows[Math.floor(random() * pnlRows.length)] ?? 0;
    }
    if (total > 0) profitable += 1;
  }
  return profitable / samples;
}

export class PaperQualificationTracker {
  private readonly events: PaperQualificationEvent[] = [];
  private readonly activePositions = new Map<string, ActivePositionEvidence>();
  private readonly completedPositions: CompletedPaperPosition[] = [];
  private readonly followUps = new Map<string, CloseFollowUp>();
  private readonly worstLossByPosition = new Map<string, number>();
  private readonly scoredFollowUps = new Set<string>();
  private readonly unscoredFollowUps = new Set<string>();
  private confidenceCache?: { key: string; value: number };
  private integrityError?: string;

  private constructor(
    private readonly runId: string,
    private readonly startedAt: number,
    private readonly startingCash: number,
    private readonly strategyConfigHash: string,
  ) {}

  static create(startingCash: number, strategyConfigHash: string, now = Date.now(), runId = `pqr-${now}-${randomUUID()}`) {
    const tracker = new PaperQualificationTracker(runId, now, startingCash, strategyConfigHash);
    tracker.add('run_started', { startingCash, strategyConfigHash }, now);
    tracker.add('equity_checkpoint', { equity: startingCash }, now);
    return tracker;
  }

  static replay(events: PaperQualificationEvent[]): PaperQualificationTracker {
    const first = events[0];
    if (!first || first.type !== 'run_started') {
      const broken = new PaperQualificationTracker('invalid', 0, 0, '');
      broken.integrityError = 'qualification ledger missing run_started event';
      return broken;
    }
    const tracker = new PaperQualificationTracker(first.runId, first.at, first.startingCash, first.strategyConfigHash);
    let expectedSequence = 1;
    let previousHash = 'GENESIS';
    for (const event of events) {
      if (event.schemaVersion !== PAPER_QUALIFICATION_SCHEMA_VERSION) {
        tracker.integrityError = 'qualification ledger schema mismatch';
        break;
      }
      if (event.runId !== first.runId || event.sequence !== expectedSequence) {
        tracker.integrityError = 'qualification ledger run or sequence mismatch';
        break;
      }
      const { hash, ...unsignedEvent } = event;
      if (event.previousHash !== previousHash || hash !== hashEvent(unsignedEvent)) {
        tracker.integrityError = 'qualification ledger hash chain mismatch';
        break;
      }
      tracker.events.push(event);
      tracker.apply(event);
      previousHash = event.hash;
      expectedSequence += 1;
    }
    return tracker;
  }

  private add<T extends PaperQualificationEvent['type']>(
    type: T,
    payload: Omit<Extract<PaperQualificationEvent, { type: T }>, keyof QualificationEventBase | 'type'>,
    at = Date.now(),
  ): Extract<PaperQualificationEvent, { type: T }> {
    const unsignedEvent = {
      schemaVersion: PAPER_QUALIFICATION_SCHEMA_VERSION,
      runId: this.runId,
      sequence: this.events.length + 1,
      at,
      previousHash: this.events.at(-1)?.hash ?? 'GENESIS',
      type,
      ...payload,
    } as Omit<Extract<PaperQualificationEvent, { type: T }>, 'hash'>;
    const event = {
      ...unsignedEvent,
      hash: hashEvent(unsignedEvent as Omit<PaperQualificationEvent, 'hash'>),
    } as Extract<PaperQualificationEvent, { type: T }>;
    this.events.push(event);
    this.apply(event);
    return event;
  }

  private apply(event: PaperQualificationEvent): void {
    if (event.type === 'paper_open') {
      const evidence = this.activePositions.get(event.trade.positionId) ?? { opens: [], closes: [] };
      evidence.opens.push(event.trade);
      this.activePositions.set(event.trade.positionId, evidence);
    } else if (event.type === 'paper_close') {
      const evidence = this.activePositions.get(event.trade.positionId) ?? { opens: [], closes: [] };
      evidence.closes.push(event.trade);
      this.activePositions.set(event.trade.positionId, evidence);
    } else if (event.type === 'position_completed') {
      this.completedPositions.push(event.position);
      this.activePositions.delete(event.position.positionId);
      this.worstLossByPosition.delete(event.position.positionId);
    } else if (event.type === 'position_worst_loss') {
      this.worstLossByPosition.set(
        event.positionId,
        Math.max(this.worstLossByPosition.get(event.positionId) ?? 0, event.worstUnrealizedLossUsd),
      );
    } else if (event.type === 'close_follow_up_started') {
      this.followUps.set(event.followUp.id, { ...event.followUp });
    } else if (event.type === 'close_follow_up_observed') {
      const followUp = this.followUps.get(event.followUpId);
      if (followUp) {
        followUp.bestHypotheticalNetProceedsUsd = Math.max(
          followUp.bestHypotheticalNetProceedsUsd ?? Number.NEGATIVE_INFINITY,
          event.hypotheticalNetProceedsUsd,
        );
      }
    } else if (event.type === 'close_follow_up_scored') {
      this.scoredFollowUps.add(event.followUpId);
    } else if (event.type === 'close_follow_up_unscored') {
      this.unscoredFollowUps.add(event.followUpId);
    }
  }

  recordOpen(trade: PaperTrade): PaperQualificationEvent[] {
    return [this.add('paper_open', { trade }, trade.timestamp)];
  }

  recordClose(input: {
    trade: PaperTrade;
    strategy: BenchmarkStrategy | 'settlement';
    entryRiskUsd: number;
    maxDrawdownUsd: number;
    remainingContracts: number;
  }): PaperQualificationEvent[] {
    const created: PaperQualificationEvent[] = [this.add('paper_close', {
      trade: input.trade,
      strategy: input.strategy,
      entryRiskUsd: input.entryRiskUsd,
      maxDrawdownUsd: input.maxDrawdownUsd,
    }, input.trade.timestamp)];
    const evidence = this.activePositions.get(input.trade.positionId);
    if (input.remainingContracts === 0 && evidence && evidence.opens.length > 0) {
      const entryRiskUsd = evidence.opens.reduce((sum, trade) => sum + trade.price * trade.contracts + trade.fees, 0);
      const exitProceedsUsd = evidence.closes.reduce((sum, trade) => sum + trade.price * trade.contracts - trade.fees, 0);
      const weightedSlippage = [...evidence.opens, ...evidence.closes]
        .reduce((sum, trade) => sum + Math.abs(trade.slippage ?? 0) * trade.contracts, 0);
      const contracts = evidence.opens.reduce((sum, trade) => sum + trade.contracts, 0);
      const totalFillContracts = [...evidence.opens, ...evidence.closes].reduce((sum, trade) => sum + trade.contracts, 0);
      const stressedNetPnlUsd = [...evidence.opens, ...evidence.closes].reduce((sum, trade) => sum + stressedTradeValue(trade), 0);
      const position: CompletedPaperPosition = {
        positionId: input.trade.positionId,
        ticker: input.trade.ticker,
        side: input.trade.side,
        playbook: evidence.opens[0]?.playbook ?? 'unknown',
        openedAt: Math.min(...evidence.opens.map((trade) => trade.timestamp)),
        closedAt: input.trade.timestamp,
        openOperations: evidence.opens.length,
        closeOperations: evidence.closes.length,
        contracts,
        entryRiskUsd: round(entryRiskUsd),
        exitProceedsUsd: round(exitProceedsUsd),
        netPnlUsd: round(exitProceedsUsd - entryRiskUsd),
        stressedNetPnlUsd: round(stressedNetPnlUsd),
        avgSlippagePp: totalFillContracts > 0 ? round(weightedSlippage / totalFillContracts) : 0,
      };
      created.push(this.add('position_completed', { position }, input.trade.timestamp));
      const latestTwenty = this.completedPositions.slice(-20);
      if (
        latestTwenty.length >= 20
        && !this.events.some((event) => event.type === 'rolling_loss_pause')
      ) {
        const rollingPnl = latestTwenty.reduce((sum, row) => sum + row.netPnlUsd, 0);
        const rollingWins = latestTwenty.filter((row) => row.netPnlUsd > 0).reduce((sum, row) => sum + row.netPnlUsd, 0);
        const rollingLosses = Math.abs(latestTwenty.filter((row) => row.netPnlUsd < 0).reduce((sum, row) => sum + row.netPnlUsd, 0));
        if (rollingPnl <= 0 || rollingWins <= rollingLosses) {
          created.push(this.add('rolling_loss_pause', {
            detail: `latest 20 positions: net $${round(rollingPnl, 2).toFixed(2)}, profit factor ${round(ratio(rollingWins, rollingLosses), 3).toFixed(3)}`,
          }, input.trade.timestamp));
        }
      }
    }
    return created;
  }

  recordAbort(code: string, reason: string, blocking: boolean, at = Date.now()) {
    return this.add('paper_abort', { code, reason, blocking }, at);
  }

  recordEquity(equity: number, at = Date.now()) {
    return this.add('equity_checkpoint', { equity }, at);
  }

  recordPositionWorstLoss(positionId: string, worstUnrealizedLossUsd: number, at = Date.now()) {
    return this.add('position_worst_loss', {
      positionId,
      worstUnrealizedLossUsd: Math.max(0, worstUnrealizedLossUsd),
    }, at);
  }

  worstLossForPosition(positionId: string): number {
    return this.worstLossByPosition.get(positionId) ?? 0;
  }

  startCloseFollowUp(input: Omit<CloseFollowUp, 'dueAt'>): PaperQualificationEvent {
    return this.add('close_follow_up_started', {
      followUp: { ...input, dueAt: input.startedAt + CLOSE_FOLLOW_UP_MS },
    }, input.startedAt);
  }

  observeCloseFollowUp(followUpId: string, hypotheticalNetProceedsUsd: number, at = Date.now()) {
    return this.add('close_follow_up_observed', { followUpId, hypotheticalNetProceedsUsd }, at);
  }

  scoreDueFollowUps(now = Date.now()): PaperQualificationEvent[] {
    const created: PaperQualificationEvent[] = [];
    for (const followUp of this.pendingFollowUps()) {
      if (followUp.dueAt > now) continue;
      if (followUp.bestHypotheticalNetProceedsUsd === undefined) {
        created.push(this.add('close_follow_up_unscored', {
          followUpId: followUp.id,
          reason: 'no executable follow-up price',
        }, now));
        continue;
      }
      const closeRegretUsd = Math.max(0, followUp.bestHypotheticalNetProceedsUsd - followUp.actualNetProceedsUsd);
      created.push(this.add('close_follow_up_scored', {
        followUpId: followUp.id,
        closeRegretUsd: round(closeRegretUsd),
        falseExit: closeRegretUsd > 0.5,
      }, now));
    }
    return created;
  }

  recordFunnel(stage: QualificationFunnelStage, count = 1, reason?: string, at = Date.now()) {
    return this.add('funnel_increment', { stage, count, reason }, at);
  }

  recordSafetyBlock(code: string, detail: string, at = Date.now()) {
    return this.add('safety_block', { code, detail }, at);
  }

  recordRollingLossPause(detail: string, at = Date.now()) {
    return this.add('rolling_loss_pause', { detail }, at);
  }

  invalidateConfiguration(actualHash: string, at = Date.now()) {
    return this.add('configuration_invalidated', { actualHash }, at);
  }

  pendingFollowUps(): CloseFollowUp[] {
    return [...this.followUps.values()]
      .filter((row) => !this.scoredFollowUps.has(row.id) && !this.unscoredFollowUps.has(row.id))
      .map((row) => ({ ...row }));
  }

  allEvents(): PaperQualificationEvent[] {
    return this.events.map((event) => JSON.parse(JSON.stringify(event)) as PaperQualificationEvent);
  }

  lastSequence(): number {
    return this.events.at(-1)?.sequence ?? 0;
  }

  integrityFailure(): string | undefined {
    return this.integrityError;
  }

  eventsAfter(sequence: number): PaperQualificationEvent[] {
    return this.allEvents().filter((event) => event.sequence > sequence);
  }

  snapshot(now = Date.now()): PaperQualificationSnapshot {
    const completed = [...this.completedPositions];
    const pnlRows = completed.map((position) => position.netPnlUsd);
    const grossProfitUsd = pnlRows.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
    const grossLossUsd = Math.abs(pnlRows.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0));
    const stressedRows = completed.map((position) => position.stressedNetPnlUsd);
    const stressedProfit = stressedRows.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
    const stressedLoss = Math.abs(stressedRows.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0));
    const rolling = completed.slice(-20);
    const rollingWins = rolling.filter((position) => position.netPnlUsd > 0).reduce((sum, position) => sum + position.netPnlUsd, 0);
    const rollingLosses = Math.abs(rolling.filter((position) => position.netPnlUsd < 0).reduce((sum, position) => sum + position.netPnlUsd, 0));
    const benchmark = new ProfitabilityBenchmark({ targetLiftPct: 80 });
    const scored = this.events.filter((event): event is Extract<PaperQualificationEvent, { type: 'close_follow_up_scored' }> => event.type === 'close_follow_up_scored');
    for (const score of scored) {
      const followUp = this.followUps.get(score.followUpId);
      if (!followUp) continue;
      benchmark.record(followUp.strategy, {
        id: followUp.id,
        riskUsd: followUp.entryRiskUsd,
        netPnlUsd: followUp.netPnlUsd,
        maxDrawdownUsd: followUp.maxDrawdownUsd,
        closeRegretUsd: score.closeRegretUsd,
        slippageUsd: followUp.slippageUsd,
        falseExit: score.falseExit,
      });
    }
    const benchmarkReport = benchmark.report();
    const equity = this.events
      .filter((event): event is Extract<PaperQualificationEvent, { type: 'equity_checkpoint' }> => event.type === 'equity_checkpoint')
      .map((event) => event.equity);
    let peak = equity[0] ?? this.startingCash;
    let maxDrawdownUsd = 0;
    for (const value of equity) {
      peak = Math.max(peak, value);
      maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - value);
    }
    const funnel = Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, 0])) as Record<QualificationFunnelStage, number>;
    const rejectionReasons: Record<string, number> = {};
    for (const event of this.events) {
      if (event.type === 'funnel_increment') {
        funnel[event.stage] += event.count;
        if (event.reason) rejectionReasons[event.reason] = (rejectionReasons[event.reason] ?? 0) + event.count;
      } else if (event.type === 'paper_abort' && !event.blocking) {
        rejectionReasons[event.code] = (rejectionReasons[event.code] ?? 0) + 1;
      }
    }
    const blockingSafetyEventCount = this.events.filter((event) =>
      event.type === 'safety_block' || (event.type === 'paper_abort' && event.blocking)).length;
    const manualScoredCloseCount = benchmarkReport.baseline.decisions;
    const automaticScoredCloseCount = benchmarkReport.upgraded.decisions;
    const realizedPnlUsd = pnlRows.reduce((sum, pnl) => sum + pnl, 0);
    const entryRiskUsd = completed.reduce((sum, position) => sum + position.entryRiskUsd, 0);
    const totalFillContracts = completed.reduce((sum, position) => sum + position.contracts * 2, 0);
    const weightedSlippage = completed.reduce((sum, position) => sum + position.avgSlippagePp * position.contracts * 2, 0);
    const largestWin = pnlRows.filter((pnl) => pnl > 0).reduce((largest, pnl) => Math.max(largest, pnl), 0);
    const configurationValid = !this.events.some((event) => event.type === 'configuration_invalidated');
    const rollingLossPaused = this.events.some((event) => event.type === 'rolling_loss_pause');
    const confidenceKey = pnlRows.join(',');
    if (!this.confidenceCache || this.confidenceCache.key !== confidenceKey) {
      this.confidenceCache = { key: confidenceKey, value: profitabilityConfidenceRate(pnlRows) };
    }

    return {
      runId: this.runId,
      startedAt: this.startedAt,
      startingCash: this.startingCash,
      strategyConfigHash: this.strategyConfigHash,
      lastSequence: this.lastSequence(),
      integrityError: this.integrityError,
      completedPositionCount: completed.length,
      grossProfitUsd: round(grossProfitUsd),
      grossLossUsd: round(grossLossUsd),
      profitFactor: round(ratio(grossProfitUsd, grossLossUsd)),
      averageNetPnlUsd: completed.length > 0 ? round(realizedPnlUsd / completed.length) : 0,
      realizedPnlUsd: round(realizedPnlUsd),
      entryRiskUsd: round(entryRiskUsd),
      pnlPerRiskDollar: entryRiskUsd > 0 ? round(realizedPnlUsd / entryRiskUsd) : 0,
      winRate: completed.length > 0 ? round(pnlRows.filter((pnl) => pnl > 0).length / completed.length) : 0,
      largestWinShare: grossProfitUsd > 0 ? round(largestWin / grossProfitUsd) : 0,
      profitableWeekCount: completedProfitableWeekCount(completed, now),
      profitConfidenceRate: round(this.confidenceCache.value),
      stressedNetPnlUsd: round(stressedRows.reduce((sum, pnl) => sum + pnl, 0)),
      stressedProfitFactor: round(ratio(stressedProfit, stressedLoss)),
      rollingTwentyPnlUsd: round(rolling.reduce((sum, position) => sum + position.netPnlUsd, 0)),
      rollingTwentyProfitFactor: round(ratio(rollingWins, rollingLosses)),
      rollingLossPaused,
      configurationValid,
      manualScoredCloseCount,
      automaticScoredCloseCount,
      pendingFollowUpCount: this.pendingFollowUps().length,
      unscoredFollowUpCount: this.unscoredFollowUps.size,
      benchmark: benchmarkReport,
      benchmarkPassed: manualScoredCloseCount >= 30 && automaticScoredCloseCount >= 30 && benchmarkReport.target.passed,
      avgSlippagePp: totalFillContracts > 0 ? round(weightedSlippage / totalFillContracts) : 0,
      automaticFalseExitRate: benchmarkReport.upgraded.falseExitRate,
      automaticAvgCloseRegretUsd: benchmarkReport.upgraded.closeRegretUsd,
      endingEquity: equity.at(-1) ?? this.startingCash,
      maxDrawdownUsd: round(maxDrawdownUsd),
      blockingSafetyEventCount,
      auditClean: blockingSafetyEventCount === 0 && !this.integrityError,
      funnel,
      rejectionReasons,
    };
  }
}
