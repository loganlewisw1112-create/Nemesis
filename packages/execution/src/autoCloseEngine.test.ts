import { describe, expect, it } from 'vitest';
import type { AutoCloseState, PaperPosition } from '@nemesis/core';
import {
  DEFAULT_AUTO_CLOSE_SETTINGS,
  evaluateAutoClosePosition,
  updateAutoCloseState,
} from './autoCloseEngine.js';

const openedAt = 1_000_000;
const now = openedAt + 45_000;

function position(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: 'pos-1',
    thesisId: 'thesis-1',
    ticker: 'TEST-1',
    title: 'Test market',
    side: 'yes',
    contracts: 100,
    entryPrice: 0.4,
    fees: 0,
    openedAt,
    playbook: 'flow-hunter',
    ...overrides,
  };
}

function state(overrides: Partial<AutoCloseState> = {}): AutoCloseState {
  return {
    positionId: 'pos-1',
    peakPnlUsd: 12,
    peakPnlPct: 0.3,
    peakEdge: 0.08,
    peakMark: 0.54,
    peakAt: openedAt + 20_000,
    tickCount: 4,
    trimmedContracts: 0,
    lastDecisionAt: 0,
    lastMark: 0.54,
    lastEdge: 0.08,
    markVelocityPct: 0,
    edgeVelocityPct: 0,
    consecutiveDownTicks: 0,
    earlyTrimContracts: 0,
    tier: 'scalp',
    ...overrides,
  };
}

describe('AutoCloseEngine', () => {
  it('updates peak state only when profit or edge improves', () => {
    const first = updateAutoCloseState({
      position: position(),
      mark: 0.46,
      currentEdge: 0.03,
      tickCount: 1,
      now,
    });
    const lowerProfitHigherEdge = updateAutoCloseState({
      position: position(),
      mark: 0.43,
      currentEdge: 0.05,
      tickCount: 2,
      now: now + 1_000,
      prior: first,
    });
    const higherProfitLowerEdge = updateAutoCloseState({
      position: position(),
      mark: 0.5,
      currentEdge: 0.04,
      tickCount: 3,
      now: now + 2_000,
      prior: lowerProfitHigherEdge,
    });

    expect(lowerProfitHigherEdge.peakPnlUsd).toBe(first.peakPnlUsd);
    expect(lowerProfitHigherEdge.peakEdge).toBe(0.05);
    expect(higherProfitLowerEdge.peakPnlUsd).toBeGreaterThan(first.peakPnlUsd);
    expect(higherProfitLowerEdge.peakEdge).toBe(0.05);
  });

  it('treats a rising executable NO-contract bid as favorable', () => {
    const first = updateAutoCloseState({
      position: position({ side: 'no', entryPrice: 0.4 }),
      mark: 0.45,
      currentEdge: 0.05,
      tickCount: 1,
      now,
    });
    const next = updateAutoCloseState({
      position: position({ side: 'no', entryPrice: 0.4 }),
      mark: 0.5,
      currentEdge: 0.05,
      tickCount: 2,
      now: now + 1_000,
      prior: first,
    });
    expect(next.markVelocityPct).toBeGreaterThan(0);
    expect(next.consecutiveDownTicks).toBe(0);
    expect(next.peakMark).toBe(0.5);
  });

  it('does not close before minimum age and tick count', () => {
    const young = evaluateAutoClosePosition({
      position: position(),
      mark: 0.47,
      currentEdge: -0.01,
      tickCount: 2,
      now: openedAt + 10_000,
      state: state({ tickCount: 2 }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true },
    });

    expect(young.action).toBe('hold');
    expect(young.reason).toContain('warming up');
  });

  it('enforces the executable one-dollar hard-loss stop before warmup completes', () => {
    const decision = evaluateAutoClosePosition({
      position: position(),
      mark: 0.38,
      currentEdge: 0.05,
      tickCount: 1,
      now: openedAt + 1_000,
      state: state({ tickCount: 1, peakPnlUsd: 0, peakPnlPct: 0 }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true },
    });
    expect(decision.action).toBe('close');
    expect(decision.reason).toMatch(/hard-loss/i);
  });

  it('requires three edge-loss observations before the edge-gone close', () => {
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 5 }),
      mark: 0.41,
      currentEdge: 0,
      tickCount: 5,
      now,
      state: state({
        peakPnlUsd: 0,
        peakPnlPct: 0,
        peakEdge: 0.01,
        tickCount: 5,
        consecutiveEdgeLossTicks: 2,
      }),
      settings: {
        ...DEFAULT_AUTO_CLOSE_SETTINGS,
        enabled: true,
        profitLockEnabled: false,
        predictiveCrossingEnabled: false,
        exitScoreTrimThreshold: 1,
        exitScoreCloseThreshold: 1,
      },
    });
    expect(decision.reason).not.toMatch(/edge gone/i);
  });

  it('ignores a GEA exit for the opposite contract side', () => {
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 5 }),
      mark: 0.41,
      currentEdge: 0.05,
      tickCount: 5,
      now,
      state: state({ peakPnlUsd: 0, peakPnlPct: 0, peakEdge: 0.05, tickCount: 5 }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true, profitLockEnabled: false },
      exitSignal: {
        ticker: 'TEST-1', side: 'no', action: 'exit', confidence: 0.99,
        currentEdge: 0, capturedEdge: 0.1, executableClosePrice: 0.59,
        bookTimestamp: now, bookDepth: 5, priceSource: 'kalshi-orderbook',
        expiresAt: now + 500, reason: 'opposite side', issuedAt: now,
      },
    });
    expect(decision.reason).not.toMatch(/GEA exit confirmed/i);
  });

  it('trims half after 12 percent peak profit and 25 percent giveback', () => {
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 10 }),
      mark: 0.475,
      currentEdge: 0.04,
      tickCount: 5,
      now,
      state: state({
        peakPnlPct: 0.2,
        peakPnlUsd: 8,
        peakMark: 0.5,
        tickCount: 5,
      }),
      // Isolated from the profit-lock layer, which would otherwise also
      // qualify on this fixture (peak profit + edge compression) and fire
      // first -- see the dedicated 'profit lock' tests below.
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true, profitLockEnabled: false },
    });

    expect(decision.action).toBe('trim');
    expect(decision.contracts).toBe(5);
    expect(decision.reason).toMatch(/giveback/i);
  });

  it('closes the remainder after 18 percent peak profit and 35 percent giveback', () => {
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 7 }),
      mark: 0.495,
      currentEdge: 0.02,
      tickCount: 6,
      now,
      state: state({ trimmedContracts: 50, tickCount: 6 }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true },
    });

    expect(decision.action).toBe('close');
    expect(decision.contracts).toBe(7);
    expect(decision.reason).toMatch(/final/i);
  });

  it('emergency closes when edge is gone and no real profit was ever banked', () => {
    const decision = evaluateAutoClosePosition({
      position: position(),
      mark: 0.44,
      currentEdge: 0,
      tickCount: 4,
      now,
      state: state({ peakPnlPct: 0.12, peakPnlUsd: 0.5, tickCount: 4, consecutiveEdgeLossTicks: 3 }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true },
    });

    expect(decision.action).toBe('close');
    expect(decision.reason).toMatch(/edge gone/i);
  });

  it('lets high-confidence GEA exit override trailing delay', () => {
    const decision = evaluateAutoClosePosition({
      position: position(),
      mark: 0.46,
      currentEdge: 0.04,
      tickCount: 4,
      now,
      state: state({ peakPnlPct: 0.14, tickCount: 4 }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true },
      exitSignal: {
        ticker: 'TEST-1',
        side: 'yes',
        action: 'exit',
        confidence: 0.92,
        currentEdge: 0.04,
        capturedEdge: 0.06,
        executableClosePrice: 0.455,
        bookTimestamp: now,
        bookDepth: 100,
        priceSource: 'kalshi-orderbook',
        expiresAt: now + 500,
        reason: 'GEA retention says exit',
        issuedAt: now,
      },
    });

    expect(decision.action).toBe('close');
    expect(decision.reason).toMatch(/GEA exit confirmed/i);
  });
  it('rejects stale executable GEA exit context even when confidence is high', () => {
    const decision = evaluateAutoClosePosition({
      position: position(),
      mark: 0.46,
      currentEdge: 0.04,
      tickCount: 4,
      now,
      state: state({ peakPnlPct: 0.14, tickCount: 4 }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true, maxBridgeLatencyMs: 500, profitLockEnabled: false },
      exitSignal: {
        ticker: 'TEST-1',
        side: 'yes',
        action: 'exit',
        confidence: 0.97,
        currentEdge: 0.04,
        capturedEdge: 0.06,
        executableClosePrice: 0.45,
        bookTimestamp: now - 501,
        bookDepth: 100,
        priceSource: 'kalshi-orderbook',
        expiresAt: now - 1,
        reason: 'GEA retention says exit',
        issuedAt: now,
      },
    });

    expect(decision.action).not.toBe('close');
    expect(decision.reason).not.toMatch(/GEA exit confirmed/i);
  });
  it('tracks adverse velocity and trims profitable positions before full giveback', () => {
    const prior = state({
      lastMark: 0.51,
      lastEdge: 0.08,
      consecutiveDownTicks: 2,
      earlyTrimContracts: 0,
    });
    const next = updateAutoCloseState({
      position: position({ contracts: 10 }),
      mark: 0.5,
      currentEdge: 0.05,
      tickCount: 5,
      now,
      prior,
    });

    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 10 }),
      mark: 0.5,
      currentEdge: 0.05,
      tickCount: 5,
      now,
      state: next,
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true, minAgeMs: 0, profitLockEnabled: false },
    });

    expect(next.markVelocityPct).toBeLessThan(0);
    expect(next.consecutiveDownTicks).toBe(3);
    expect(decision.action).toBe('trim');
    expect(decision.reason).toMatch(/velocity/i);
  });

  it('fires quick-profit trims when profit is positive and edge compresses', () => {
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 20 }),
      mark: 0.425,
      currentEdge: 0.055,
      tickCount: 5,
      now,
      state: state({
        peakPnlPct: 0.08,
        peakEdge: 0.08,
        trimmedContracts: 0,
        tickCount: 5,
      }),
      settings: {
        ...DEFAULT_AUTO_CLOSE_SETTINGS,
        enabled: true,
        minAgeMs: 0,
        quickProfitExitEnabled: true,
      },
    });

    expect(decision.action).toBe('trim');
    expect(decision.contracts).toBe(5);
    expect(decision.reason).toMatch(/quick-profit/i);
  });

  it('predictively trims before the trailing threshold is fully crossed', () => {
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 12 }),
      mark: 0.477,
      currentEdge: 0.05,
      tickCount: 5,
      now,
      state: state({
        peakPnlPct: 0.2,
        peakEdge: 0.08,
        markVelocityPct: -0.03,
        trimmedContracts: 0,
        tickCount: 5,
      }),
      settings: {
        ...DEFAULT_AUTO_CLOSE_SETTINGS,
        enabled: true,
        minAgeMs: 0,
        predictiveCrossingEnabled: true,
        profitLockEnabled: false,
      },
    });

    expect(decision.action).toBe('trim');
    expect(decision.reason).toMatch(/predictive/i);
  });

  it('locks in profit on edge compression instead of waiting for the full giveback threshold', () => {
    // Reproduces the real incident: a scalp position peaks at a real,
    // fee-adjusted profit ($1.50 on a $5.50 cost basis -- well above both
    // the 3% quick-profit bar and the $1 profit-lock floor) and edge starts
    // compressing well before it fully collapses to zero.
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 50, entryPrice: 0.1 }),
      mark: 0.13,
      currentEdge: 0.02,
      tickCount: 5,
      now,
      state: state({
        peakPnlUsd: 1.5,
        peakPnlPct: 0.27,
        peakEdge: 0.06,
        trimmedContracts: 0,
        tickCount: 5,
      }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true },
    });

    expect(decision.action).toBe('close');
    expect(decision.reason).toMatch(/profit lock/i);
  });

  it('does not lock in profit below the minimum dollar floor', () => {
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 5, entryPrice: 0.1 }),
      mark: 0.11,
      currentEdge: 0.01,
      tickCount: 5,
      now,
      state: state({
        peakPnlUsd: 0.2,
        peakPnlPct: 0.4,
        peakEdge: 0.06,
        trimmedContracts: 0,
        tickCount: 5,
      }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true },
    });

    expect(decision.reason).not.toMatch(/profit lock/i);
  });

  it('lets a fresh, high-confidence GEA exit signal take priority over the profit lock', () => {
    const decision = evaluateAutoClosePosition({
      position: position({ contracts: 50, entryPrice: 0.1 }),
      mark: 0.13,
      currentEdge: 0.02,
      tickCount: 5,
      now,
      state: state({
        peakPnlUsd: 1.5,
        peakPnlPct: 0.27,
        peakEdge: 0.06,
        trimmedContracts: 0,
        tickCount: 5,
      }),
      settings: { ...DEFAULT_AUTO_CLOSE_SETTINGS, enabled: true },
      exitSignal: {
        ticker: 'TEST-1',
        side: 'yes',
        action: 'exit',
        confidence: 0.95,
        currentEdge: 0.02,
        capturedEdge: 0.06,
        executableClosePrice: 0.13,
        bookTimestamp: now,
        bookDepth: 100,
        priceSource: 'kalshi-orderbook',
        expiresAt: now + 500,
        reason: 'GEA retention says exit',
        issuedAt: now,
      },
    });

    expect(decision.action).toBe('close');
    expect(decision.reason).toMatch(/GEA exit confirmed/i);
  });
});
