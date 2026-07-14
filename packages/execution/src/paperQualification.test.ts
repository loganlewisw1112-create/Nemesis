import { describe, expect, it } from 'vitest';
import { kalshiFeeForOrder, type PaperTrade } from '@nemesis/core';
import {
  CLOSE_FOLLOW_UP_MS,
  PaperQualificationTracker,
  profitabilityConfidenceRate,
} from './paperQualification.js';

function trade(
  id: string,
  positionId: string,
  type: 'open' | 'close',
  contracts: number,
  price: number,
  timestamp: number,
): PaperTrade {
  return {
    id,
    positionId,
    type,
    ticker: 'KXTEST',
    side: 'yes',
    contracts,
    price,
    fees: kalshiFeeForOrder(price, contracts),
    timestamp,
    slippage: 0.005,
    playbook: 'flow-hunter',
    mode: 'paper',
  };
}

function completePosition(
  tracker: PaperQualificationTracker,
  id: string,
  openedAt: number,
  closedAt: number,
  exitPrice: number,
  contracts = 10,
): void {
  tracker.recordOpen(trade(`open-${id}`, id, 'open', contracts, 0.4, openedAt));
  tracker.recordClose({
    trade: trade(`close-${id}`, id, 'close', contracts, exitPrice, closedAt),
    strategy: 'settlement',
    entryRiskUsd: 4,
    maxDrawdownUsd: 1,
    remainingContracts: 0,
  });
}

describe('PaperQualificationTracker', () => {
  it('counts one completed position across added opens and partial closes', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    tracker.recordOpen(trade('o1', 'p1', 'open', 10, 0.4, 10));
    tracker.recordOpen(trade('o2', 'p1', 'open', 5, 0.5, 20));
    tracker.recordClose({
      trade: trade('c1', 'p1', 'close', 7, 0.6, 30),
      strategy: 'baseline',
      entryRiskUsd: 3,
      maxDrawdownUsd: 1,
      remainingContracts: 8,
    });
    expect(tracker.snapshot(40).completedPositionCount).toBe(0);

    tracker.recordClose({
      trade: trade('c2', 'p1', 'close', 8, 0.7, 40),
      strategy: 'upgraded',
      entryRiskUsd: 4,
      maxDrawdownUsd: 1,
      remainingContracts: 0,
    });
    const result = tracker.snapshot(50);
    expect(result.completedPositionCount).toBe(1);
    expect(result.entryRiskUsd).toBeCloseTo(6.8, 2);
    expect(result.realizedPnlUsd).toBeGreaterThan(2);
  });

  it('keeps entry risk when a losing settlement exits at zero', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    tracker.recordOpen(trade('o1', 'p1', 'open', 10, 0.4, 10));
    tracker.recordClose({
      trade: trade('c1', 'p1', 'close', 10, 0, 20),
      strategy: 'settlement',
      entryRiskUsd: 4,
      maxDrawdownUsd: 4,
      remainingContracts: 0,
    });
    const result = tracker.snapshot(30);
    expect(result.entryRiskUsd).toBeGreaterThan(4);
    expect(result.grossLossUsd).toBe(result.entryRiskUsd);
    expect(result.pnlPerRiskDollar).toBe(-1);
  });

  it('scores a close after fifteen minutes and resumes from replay', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    tracker.startCloseFollowUp({
      id: 'f1',
      strategy: 'upgraded',
      positionId: 'p1',
      ticker: 'KXTEST',
      side: 'yes',
      contracts: 10,
      actualNetProceedsUsd: 4,
      entryRiskUsd: 3,
      netPnlUsd: 1,
      maxDrawdownUsd: 0.5,
      slippageUsd: 0.1,
      startedAt: 100,
    });
    tracker.observeCloseFollowUp('f1', 4.75, 200);
    const replayed = PaperQualificationTracker.replay(tracker.allEvents());
    expect(replayed.pendingFollowUps()).toHaveLength(1);
    expect(replayed.scoreDueFollowUps(100 + CLOSE_FOLLOW_UP_MS)).toHaveLength(1);
    expect(replayed.snapshot().automaticFalseExitRate).toBe(1);
    expect(replayed.snapshot().automaticAvgCloseRegretUsd).toBe(0.75);
  });

  it('requires thirty scored manual and automatic close decisions for the 80% benchmark', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    for (let index = 0; index < 30; index += 1) {
      const startedAt = 100 + index;
      tracker.startCloseFollowUp({
        id: `manual-${index}`,
        strategy: 'baseline',
        positionId: `manual-position-${index}`,
        ticker: 'KXTEST',
        side: 'yes',
        contracts: 10,
        actualNetProceedsUsd: 4,
        entryRiskUsd: 10,
        netPnlUsd: 1,
        maxDrawdownUsd: 2,
        slippageUsd: 0.2,
        startedAt,
      });
      tracker.observeCloseFollowUp(`manual-${index}`, 4, startedAt + 1);
      tracker.startCloseFollowUp({
        id: `automatic-${index}`,
        strategy: 'upgraded',
        positionId: `automatic-position-${index}`,
        ticker: 'KXTEST',
        side: 'yes',
        contracts: 10,
        actualNetProceedsUsd: 5,
        entryRiskUsd: 10,
        netPnlUsd: 2,
        maxDrawdownUsd: 1,
        slippageUsd: 0.1,
        startedAt,
      });
      tracker.observeCloseFollowUp(`automatic-${index}`, 5, startedAt + 1);
    }
    tracker.scoreDueFollowUps(200 + CLOSE_FOLLOW_UP_MS);
    const result = tracker.snapshot();
    expect(result.manualScoredCloseCount).toBe(30);
    expect(result.automaticScoredCloseCount).toBe(30);
    expect(result.benchmark.delta.pnlPerRiskDollarLiftPct).toBe(100);
    expect(result.benchmarkPassed).toBe(true);
    expect(result.automaticFalseExitRate).toBe(0);
    expect(result.automaticAvgCloseRegretUsd).toBe(0);
  });

  it('detects sequence corruption and fails audit clean', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    const events = tracker.allEvents();
    events[1].sequence = 99;
    const replayed = PaperQualificationTracker.replay(events);
    expect(replayed.snapshot().integrityError).toContain('sequence');
    expect(replayed.snapshot().auditClean).toBe(false);
  });

  it('detects valid-JSON evidence tampering through the hash chain', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    tracker.recordEquity(5_010, 2);
    const events = tracker.allEvents();
    const equity = events.find((event) => event.type === 'equity_checkpoint' && event.at === 2);
    if (!equity || equity.type !== 'equity_checkpoint') throw new Error('missing test equity event');
    equity.equity = 9_999;
    const replayed = PaperQualificationTracker.replay(events);
    expect(replayed.snapshot().integrityError).toContain('hash chain');
    expect(replayed.snapshot().auditClean).toBe(false);
  });

  it('restores each open position worst unrealized loss after restart', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    tracker.recordOpen(trade('o1', 'p1', 'open', 10, 0.4, 10));
    tracker.recordPositionWorstLoss('p1', 1.25, 20);
    const replayed = PaperQualificationTracker.replay(tracker.allEvents());
    expect(replayed.worstLossForPosition('p1')).toBe(1.25);
  });

  it('uses deterministic profitability resampling', () => {
    const rows = [4, 3, 2, -1, -1];
    expect(profitabilityConfidenceRate(rows, 10_000, 42)).toBe(
      profitabilityConfidenceRate(rows, 10_000, 42),
    );
    expect(profitabilityConfidenceRate(rows, 10_000, 42)).toBeGreaterThan(0.9);
  });

  it('calculates gross dollars, largest-win share, average P&L, and one-cent stress', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    completePosition(tracker, 'win-a', 10, 20, 0.7);
    completePosition(tracker, 'win-b', 30, 40, 0.6);
    completePosition(tracker, 'loss', 50, 60, 0.3);

    const result = tracker.snapshot(70);
    expect(result.grossProfitUsd).toBeGreaterThan(0);
    expect(result.grossLossUsd).toBeGreaterThan(0);
    expect(result.profitFactor).toBeCloseTo(result.grossProfitUsd / result.grossLossUsd, 6);
    expect(result.averageNetPnlUsd).toBeCloseTo(result.realizedPnlUsd / 3, 6);
    expect(result.largestWinShare).toBeCloseTo(2.6 / 4.2, 6);
    expect(result.stressedNetPnlUsd).toBeLessThan(result.realizedPnlUsd);
    expect(result.stressedProfitFactor).toBeLessThan(result.profitFactor);
  });

  it('counts four consecutive completed Monday-Sunday Los Angeles weeks at the boundary', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    const closes = [
      Date.parse('2026-06-10T19:00:00Z'),
      Date.parse('2026-06-17T19:00:00Z'),
      Date.parse('2026-06-24T19:00:00Z'),
      Date.parse('2026-07-01T19:00:00Z'),
    ];
    closes.forEach((closedAt, index) => completePosition(tracker, `week-${index}`, closedAt - 1_000, closedAt, 0.6));

    expect(tracker.snapshot(Date.parse('2026-07-06T19:00:00Z')).profitableWeekCount).toBe(4);
    expect(tracker.snapshot(Date.parse('2026-06-29T19:00:00Z')).profitableWeekCount).toBe(3);
  });

  it('automatically pauses after twenty losing completed positions', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    for (let index = 0; index < 20; index += 1) {
      completePosition(tracker, `loss-${index}`, index * 10 + 2, index * 10 + 3, 0.3);
    }
    const result = tracker.snapshot(1_000);
    expect(result.completedPositionCount).toBe(20);
    expect(result.rollingTwentyPnlUsd).toBeLessThan(0);
    expect(result.rollingTwentyProfitFactor).toBe(0);
    expect(result.rollingLossPaused).toBe(true);
  });

  it('makes a rolling loss pause sticky', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    tracker.recordRollingLossPause('latest 20 positions are unprofitable', 2);
    expect(tracker.snapshot().rollingLossPaused).toBe(true);
  });

  it('keeps expected rejections nonblocking and real safety failures blocking', () => {
    const tracker = PaperQualificationTracker.create(5_000, 'config', 1, 'run');
    for (const code of [
      'fill_aborted',
      'book_unavailable',
      'signal_eligibility_block',
      'strict_profit_block',
      'execution_in_flight',
    ]) tracker.recordAbort(code, code, false);
    expect(tracker.snapshot().blockingSafetyEventCount).toBe(0);
    expect(tracker.snapshot().auditClean).toBe(true);

    for (const code of [
      'duplicate_paper_mutation',
      'mutation_after_failed_gate',
      'accounting_mismatch',
      'kill_switch_bypass',
      'shutdown_event',
      'qualification_evidence_corrupt',
    ]) tracker.recordSafetyBlock(code, code);
    expect(tracker.snapshot().blockingSafetyEventCount).toBe(6);
    expect(tracker.snapshot().auditClean).toBe(false);
  });
});
