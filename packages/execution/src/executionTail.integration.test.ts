import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTRY_QUALIFICATION,
  DEFAULT_GUARDRAILS,
  buildKalshiFeePolicy,
  type GuardrailSettings,
  type KalshiOrderbook,
  type ProfitCertificate,
  type ThesisCard,
} from '@nemesis/core';
import { EntryConfirmationEngine } from './entryConfirmation.js';
import { StrategyValidationTracker, type ShadowCandidateEvidence } from './strategyValidation.js';
import { simulatePaperBuy } from './executionRouter.js';
import { PaperDesk } from './paperDesk.js';

/**
 * End-to-end proof of the execution TAIL: the composed sequence that no single
 * unit test exercises -- a real 'ready' confirmation certificate, carried
 * through the shadow->pilot validation ladder, then placed as a pilot paper
 * trade and closed to a realized profit. This is where integration gaps hide
 * (field mismatches between the confirmation certificate and simulatePaperBuy's
 * strict override check, between shadow scoring and shadowPassed). It uses the
 * accelerated shadow thresholds the operator env-lever sets (20 scored, 1 day)
 * so the proof matches the live acceptance bar; the edge gates (profit factor,
 * win rate) are untouched.
 */

// Real-now-relative: the confirmation certificate's expiresAt is validated
// against Date.now() inside simulatePaperBuy, and observed times are synthetic
// offsets (no real waiting), so the window elapses instantly while the
// certificate stays live.
const T0 = Date.now();
const TICKER = 'KXBTCD-26JUL2316-TESTGREEN';
const feePolicy = buildKalshiFeePolicy({ multiplier: 1, accountPrecision: 'direct' });

function card(overrides: Partial<ThesisCard> = {}): ThesisCard {
  return {
    id: 'flow-tail-1',
    ticker: TICKER,
    title: 'Tail integration market',
    category: 'crypto',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.4,
    impliedPrice: 0.55,
    grossEdge: 0.15,
    netEdge: 0.12,
    spread: 0.02,
    depthUsd: 500,
    predictability: 0.8,
    feeEstimate: 0.01,
    signalReason: 'persistent aggressive flow',
    externalSummary: '',
    createdAt: T0,
    updatedAt: T0,
    freshnessMs: 0,
    edgeHistory: [0.12],
    drivers: [],
    invalidations: [],
    sourceMove: 'flow-driven',
    ...overrides,
  };
}

const book: KalshiOrderbook = {
  ticker: TICKER,
  yes: [{ price: 0.4, quantity: 500 }],
  no: [{ price: 0.58, quantity: 500 }],
  yesAsk: 0.42,
  noAsk: 0.6,
  spread: 0.02,
};

function fill() {
  return {
    ticker: TICKER,
    side: 'yes' as const,
    contracts: 25,
    expectedPrice: 0.4,
    fillPrice: 0.4,
    filled: 25,
    fillLevels: [{ price: 0.4, quantity: 25, cost: 10 }],
    slippage: 0,
    fees: 0.18,
    feePolicyKnown: true,
    netEdge: 0.09,
    aborted: false,
  };
}

function baseCertificate(): ProfitCertificate {
  return {
    kind: 'open',
    ticker: TICKER,
    side: 'yes',
    contracts: 25,
    entryPrice: 0.4,
    exitPrice: 0.55,
    entryFees: 0.18,
    exitFees: 0,
    netPnlUsd: 3.5,
    bookTimestamp: T0,
    expiresAt: T0 + 60_000,
    reason: 'modeled edge',
    classification: 'research_only',
  };
}

describe('execution tail (confirmation -> shadow -> pilot -> paper trade -> close)', () => {
  it('carries a ready certificate through the ladder to a realized green paper trade', () => {
    const settings: GuardrailSettings = {
      ...DEFAULT_GUARDRAILS,
      demoMode: false,
      dryRun: true,
      liveEnabled: false,
      maxPositionUsd: 50,
      entryQualification: { ...DEFAULT_ENTRY_QUALIFICATION, minSamples: 4, minWindowMs: 15_000 },
    };

    // 1) Drive a real 'ready' confirmation and capture its certificate.
    const engine = new EntryConfirmationEngine(settings.entryQualification!);
    let confirmation = engine.observe({
      card: card(), fill: fill(), baseCertificate: baseCertificate(),
      bookTimestamp: T0, bookSequence: 1, feePolicy, observedAt: T0,
    });
    expect(confirmation.status).toBe('pending');
    for (const [i, ms] of [5_000, 10_000, 15_000].entries()) {
      confirmation = engine.observe({
        card: card({ updatedAt: T0 + ms }), fill: fill(), baseCertificate: baseCertificate(),
        bookTimestamp: T0 + ms, bookSequence: i + 2, feePolicy, observedAt: T0 + ms,
      });
    }
    expect(confirmation.status).toBe('ready');
    expect(confirmation.certificate).toBeTruthy();
    expect(confirmation.certificate!.classification).toBe('modeled_confirmed');
    const certificate = confirmation.certificate!;

    // 2) The confirmation opens a shadow candidate; score 20 profitable ones in
    //    one day and confirm shadowPassed under the accelerated thresholds.
    const tracker = StrategyValidationTracker.create('shadow', 'config-tail', 2, T0, 'tail-run');
    for (let index = 0; index < 20; index += 1) {
      const at = T0 + index * 1_000;
      const evidence: ShadowCandidateEvidence = {
        id: `tail-${index}`,
        sourceSignalId: `tail-src-${index}`,
        ticker: `${TICKER}-${index}`,
        side: index % 2 ? 'yes' : 'no',
        playbook: 'flow-hunter',
        startedAt: at,
        dueAt: at + 15 * 60_000,
        contracts: 25,
        entryPrice: 0.4,
        entryFeesUsd: 0.18,
        initialNetEdge: 0.12,
        expectedRewardUsd: certificate.targetRewardUsd ?? 3.5,
        plannedLossUsd: 1,
        rewardRiskRatio: 2,
        stressedExpectedNetPnlUsd: 1,
      };
      tracker.startShadowCandidate(evidence);
      const win = index < 14; // 70% win rate
      tracker.observeShadowCandidate(evidence.id, win ? 3 : -1, win ? 2 : -0.5, win ? 0.1 : -0.01, at + 1_000);
      tracker.scoreShadowCandidate(evidence.id, win ? 3 : -1, win ? 2 : -0.5, 'follow-up complete', at + 2_000);
    }
    const acceptance = { ...DEFAULT_ENTRY_QUALIFICATION, shadowMinScored: 20, shadowMinDistinctDays: 1 };
    const snapshot = tracker.snapshot(acceptance);
    expect(snapshot.shadowCandidateCount).toBe(20);
    expect(snapshot.shadowProfitFactor).toBeGreaterThanOrEqual(1.25);
    expect(snapshot.shadowWinRate).toBeGreaterThanOrEqual(0.55);
    expect(snapshot.shadowPassed).toBe(true);

    // 3) Advance to pilot -- the gate that unlocks portfolio mutation.
    tracker.changeStage('pilot', 'ADVANCE_TO_PILOT');
    expect(tracker.snapshot(acceptance).stage).toBe('pilot');

    // 4) Place the pilot paper trade with the real confirmation certificate.
    const desk = new PaperDesk(5_000);
    const cashBefore = desk.snapshot().cash;
    const result = simulatePaperBuy(desk, card(), book, settings, 25, certificate);
    expect(result.ok).toBe(true);
    const afterBuy = desk.snapshot();
    expect(afterBuy.trades.length).toBe(1);
    expect(afterBuy.positions.length).toBe(1);
    expect(afterBuy.cash).toBeLessThan(cashBefore);

    // 5) Close the position higher and realize a green P&L.
    const position = afterBuy.positions[0];
    const close = desk.closePosition(position.id, 0.55);
    expect(close.ok).toBe(true);
    expect(close.pnl!).toBeGreaterThan(0);
    const final = desk.snapshot();
    expect(final.positions.length).toBe(0);
    expect(final.realizedPnl).toBeGreaterThan(0);
    expect(final.trades.length).toBe(2); // open + close
  });
});
