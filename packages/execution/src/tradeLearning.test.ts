import { describe, expect, it } from 'vitest';
import { TradeLearningLedger, type TradeOutcomeRecord } from './tradeLearning.js';

function outcome(overrides: Partial<TradeOutcomeRecord> = {}): TradeOutcomeRecord {
  return {
    id: 'trade-1',
    ticker: 'KXLEARN',
    side: 'yes',
    playbook: 'flow-hunter',
    openedAt: 1,
    closedAt: 2,
    size: 10,
    entryPrice: 0.4,
    exitPrice: 0.39,
    fees: 0.2,
    slippage: 0.01,
    realizedPnl: -0.3,
    maxFavorableExcursion: 0.2,
    maxAdverseExcursion: -0.5,
    latencyMetrics: {
      localDecisionMs: 1,
      orderSubmitRttMs: 40,
      fillConfirmMs: 80,
      profitLockTotalMs: 120,
      eventLoopDelayMs: 4,
      workerQueueDepth: 0,
    },
    geaSignals: ['exit'],
    decisionReasons: ['late close'],
    marketRegime: 'wide-spread',
    liquidityBucket: 'thin',
    spreadBucket: 'wide',
    latencyBucket: 'normal',
    ...overrides,
  };
}

describe('TradeLearningLedger', () => {
  it('turns losses and late closes into unresolved mistake signatures', () => {
    const ledger = new TradeLearningLedger();

    const signatures = ledger.recordOutcome(outcome({
      realizedPnl: -0.5,
      maxFavorableExcursion: 0.5,
      maxAdverseExcursion: -0.6,
    }));

    expect(signatures.map((s) => s.failureType)).toEqual(expect.arrayContaining(['loss', 'late_close']));
    expect(ledger.hasUnresolvedMistake({
      playbook: 'flow-hunter',
      marketRegime: 'wide-spread',
      liquidityBucket: 'thin',
      spreadBucket: 'wide',
      latencyBucket: 'normal',
    })).toBe(true);
  });

  it('blocks repeated slippage and stale-book mistakes until resolved', () => {
    const ledger = new TradeLearningLedger({ maxSlippagePp: 0.03, maxBookAgeMs: 2_000 });

    ledger.recordOutcome(outcome({
      id: 'trade-2',
      realizedPnl: 0.1,
      slippage: 0.06,
      bookAgeMs: 5_000,
    }));

    const gate = ledger.evaluateCandidate({
      playbook: 'flow-hunter',
      marketRegime: 'wide-spread',
      liquidityBucket: 'thin',
      spreadBucket: 'wide',
      latencyBucket: 'normal',
    });

    expect(gate.allowed).toBe(false);
    expect(gate.noTradeReasons).toEqual(expect.arrayContaining([
      'unresolved slippage_breach mistake',
      'unresolved stale_book mistake',
    ]));
  });
});
