import {
  DEFAULT_ENTRY_QUALIFICATION,
  isKnownKalshiFeePolicy,
  isSupportedQualificationFeeOrder,
  type EntryQualificationSettings,
  type KalshiFeePolicy,
  type ProfitCertificate,
  type ThesisCard,
} from '@nemesis/core';
import type { DryRunOrder } from './dryRun.js';
import { calculateEntryEconomics, type EntryEconomicsEvidence } from './tradeEconomics.js';

export interface EntryConfirmationObservation {
  candidateId?: string;
  card: ThesisCard;
  fill: DryRunOrder;
  baseCertificate: ProfitCertificate;
  bookTimestamp: number;
  bookSequence?: number;
  /**
   * True only when the orderbook transport can prove it has missed nothing for
   * this book: connected, authenticated, subscribed, and free of sequence gaps.
   * Lets an unchanged book from a quiet market count as current up to
   * MAX_PROVEN_QUIET_BOOK_AGE_MS. Absent or false keeps the strict
   * maxBookAgeMs bound.
   */
  bookContinuityProven?: boolean;
  feePolicy?: KalshiFeePolicy;
  observedAt?: number;
  sourceAlreadyUsed?: boolean;
  lastTickerExecutionAt?: number;
}

export interface ConfirmationSample {
  at: number;
  netEdge: number;
  spread: number;
  bookTimestamp: number;
  bookSequence: number;
}

interface ConfirmationState {
  sourceSignalId: string;
  ticker: string;
  side: 'yes' | 'no';
  samples: ConfirmationSample[];
}

export interface EntryConfirmationResult {
  status: 'pending' | 'rejected' | 'ready';
  reason: string;
  samples: number;
  windowMs: number;
  edgeRetention: number;
  /** Conditional target reward, not probability-weighted expected value. */
  targetRewardUsd: number;
  /** @deprecated Compatibility alias for schema-1 callers. */
  expectedRewardUsd: number;
  plannedLossUsd: number;
  rewardRiskRatio: number;
  stressedNetPnlUsd: number;
  economics: EntryEconomicsEvidence;
  certificate?: ProfitCertificate;
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Ceiling for a book accepted only because the transport proved continuity.
 * Sized below the 25s dead-connection bound so a book can never be accepted on
 * the strength of a socket that is itself about to be declared dead.
 */
export const MAX_PROVEN_QUIET_BOOK_AGE_MS = 10_000;

export class EntryConfirmationEngine {
  private readonly states = new Map<string, ConfirmationState>();
  private readonly usedSources = new Set<string>();

  constructor(private readonly settings: EntryQualificationSettings = DEFAULT_ENTRY_QUALIFICATION) {}

  markSourceUsed(sourceSignalId: string): void {
    this.usedSources.add(sourceSignalId);
    this.states.delete(sourceSignalId);
  }

  hasUsedSource(sourceSignalId: string): boolean {
    return this.usedSources.has(sourceSignalId);
  }

  /**
   * Tickers with confirmation evidence already accumulating. Each additional
   * sample requires a *new* book sequence spaced minWindowMs/(minSamples-1)
   * apart, so a candidate needs its book to keep streaming for the whole
   * window; if the ticker leaves the orderbook tracking set mid-flight the
   * stream deletes its book and the partial evidence can never complete.
   */
  inFlightTickers(): string[] {
    const tickers = new Set<string>();
    for (const state of this.states.values()) {
      if (state.samples.length > 0) tickers.add(state.ticker);
    }
    return [...tickers];
  }

  reset(sourceSignalId?: string): void {
    if (sourceSignalId) this.states.delete(sourceSignalId);
    else this.states.clear();
  }

  restoreCandidateState(input: {
    candidateId: string;
    sourceSignalId: string;
    ticker: string;
    side: 'yes' | 'no';
    samples: ConfirmationSample[];
  }): void {
    if (this.usedSources.has(input.sourceSignalId)) return;
    const samples = [...input.samples]
      .filter((sample) => Number.isFinite(sample.at)
        && Number.isFinite(sample.bookTimestamp)
        && Number.isInteger(sample.bookSequence))
      .sort((a, b) => a.at - b.at);
    this.states.set(input.candidateId, {
      sourceSignalId: input.sourceSignalId,
      ticker: input.ticker,
      side: input.side,
      samples,
    });
  }

  observe(input: EntryConfirmationObservation): EntryConfirmationResult {
    const now = input.observedAt ?? Date.now();
    const candidateId = input.candidateId ?? input.card.id;
    const config = this.settings;
    const metrics = calculateEntryEconomics({
      entryPrice: input.fill.fillPrice,
      entryFeesUsd: input.fill.fees,
      contracts: input.fill.filled,
      sideFairPrice: input.card.impliedPrice,
      marketPrice: input.card.marketPrice,
      grossEdge: input.card.grossEdge,
      screeningNetEdge: input.card.netEdge,
      executableEntryNetEdge: input.fill.netEdge,
      spread: input.card.spread,
      fillSlippage: input.fill.slippage,
      feePolicy: input.feePolicy,
    });
    const base = {
      samples: 0,
      windowMs: 0,
      edgeRetention: 0,
      targetRewardUsd: metrics.targetRewardUsd,
      expectedRewardUsd: metrics.targetRewardUsd,
      plannedLossUsd: metrics.plannedLossUsd,
      rewardRiskRatio: metrics.rewardRiskRatio,
      stressedNetPnlUsd: metrics.stressedNetPnlUsd,
      economics: metrics,
    };
    const reject = (reason: string): EntryConfirmationResult => ({ status: 'rejected', reason, ...base });

    if (!config.enabled) {
      return {
        status: 'ready',
        reason: 'entry confirmation disabled',
        ...base,
        certificate: { ...input.baseCertificate, classification: 'modeled_confirmed' },
      };
    }
    if (input.card.sourceMove !== 'flow-driven') return reject('automatic entry requires a flow-driven source');
    if (this.usedSources.has(input.card.id) || input.sourceAlreadyUsed) return reject('source signal already used');
    const sourceAgeMs = Math.max(0, now - input.card.createdAt);
    if (sourceAgeMs > config.maxSourceAgeMs) return reject('source signal is stale');
    const bookAgeMs = Math.max(0, now - input.bookTimestamp);
    if (!Number.isFinite(input.bookTimestamp) || !Number.isInteger(input.bookSequence)) {
      return reject('confirmation requires an exchange-origin book timestamp and sequence');
    }
    // A book age past maxBookAgeMs means one of two very different things: our
    // pipeline is lagging (dangerous -- the market may have moved unseen), or
    // the market is simply quiet (harmless -- nothing has happened). They are
    // distinguishable: with the orderbook transport connected, authenticated,
    // subscribed and free of sequence gaps, we can *prove* no update was missed,
    // so an unchanged book is current rather than stale. Conflating the two
    // discarded 17% of observations and broke the sample chain that entry
    // confirmation depends on. The same conflation has already been corrected at
    // four other layers of this system (feed composite, runtime health,
    // preflight, readiness conditions); this is the fifth and last.
    //
    // A hard ceiling still applies, because "no gaps" cannot vouch for a book
    // arbitrarily far in the past.
    const quietBookProven = input.bookContinuityProven === true
      && bookAgeMs <= MAX_PROVEN_QUIET_BOOK_AGE_MS;
    if (bookAgeMs > config.maxBookAgeMs && !quietBookProven) return reject('entry book is stale');
    if (!isKnownKalshiFeePolicy(input.feePolicy)) return reject('account or series fee policy is unknown');
    if (!Number.isFinite(input.fill.netEdge) || input.fill.netEdge <= 0) {
      return reject('executable entry edge is not positive');
    }
    if (!isSupportedQualificationFeeOrder(input.fill.fillPrice, input.fill.filled)) {
      return reject('qualification fee model requires a four-decimal price and two-decimal quantity');
    }
    if (!Number.isFinite(input.card.impliedPrice) || metrics.targetExitPrice <= input.fill.fillPrice) {
      return reject('selected-side fair price does not exceed the executable entry');
    }
    if (
      input.lastTickerExecutionAt != null
      && now - input.lastTickerExecutionAt < config.tickerCooldownMs
    ) return reject('ticker-side cooldown is active');
    if (metrics.targetRewardUsd < config.minExpectedNetPnlUsd) return reject('target net reward is below the minimum');
    if (metrics.rewardRiskRatio < config.minRewardRiskRatio) return reject('target reward-to-risk ratio is below the minimum');
    if (metrics.stressedNetPnlUsd < config.minStressedNetPnlUsd) return reject('one-cent stressed expected result is not profitable');

    let state = this.states.get(candidateId);
    if (!state) {
      state = { sourceSignalId: input.card.id, ticker: input.card.ticker, side: input.card.side, samples: [] };
      this.states.set(candidateId, state);
    }
    if (state.ticker !== input.card.ticker || state.side !== input.card.side || state.sourceSignalId !== input.card.id) {
      this.states.delete(candidateId);
      return reject('source signal identity changed during confirmation');
    }
    const minSpacingMs = Math.max(1, Math.ceil(config.minWindowMs / Math.max(1, config.minSamples - 1)));
    const last = state.samples.at(-1);
    const duplicateSequence = state.samples.some((sample) => sample.bookSequence === input.bookSequence);
    if ((!last || now - last.at >= minSpacingMs) && !duplicateSequence) {
      state.samples.push({
        at: now,
        netEdge: input.fill.netEdge,
        spread: input.card.spread,
        bookTimestamp: input.bookTimestamp,
        bookSequence: input.bookSequence!,
      });
    }
    const first = state.samples[0];
    const latest = state.samples.at(-1)!;
    const windowMs = latest.at - first.at;
    const edgeRetention = first.netEdge > 0 ? latest.netEdge / first.netEdge : 0;
    const spreadWidening = latest.spread - first.spread;
    const current = {
      samples: state.samples.length,
      windowMs,
      edgeRetention: round(edgeRetention),
      targetRewardUsd: metrics.targetRewardUsd,
      expectedRewardUsd: metrics.targetRewardUsd,
      plannedLossUsd: metrics.plannedLossUsd,
      rewardRiskRatio: metrics.rewardRiskRatio,
      stressedNetPnlUsd: metrics.stressedNetPnlUsd,
      economics: metrics,
    };
    if (spreadWidening > config.maxSpreadWideningPp) {
      this.states.delete(candidateId);
      return { status: 'rejected', reason: 'spread widened during entry confirmation', ...current };
    }
    if (edgeRetention < config.minEdgeRetention) {
      this.states.delete(candidateId);
      return { status: 'rejected', reason: 'edge decayed during entry confirmation', ...current };
    }
    if (state.samples.length < config.minSamples || windowMs < config.minWindowMs) {
      return { status: 'pending', reason: 'collecting persistent executable entry evidence', ...current };
    }

    const certificate: ProfitCertificate = {
      ...input.baseCertificate,
      classification: 'modeled_confirmed',
      sourceSignalId: input.card.id,
      sourceAgeMs,
      confirmationSamples: state.samples.length,
      confirmationWindowMs: windowMs,
      initialNetEdge: round(first.netEdge),
      finalNetEdge: round(latest.netEdge),
      edgeRetention: round(edgeRetention),
      bookAgeMs,
      targetExitPrice: metrics.targetExitPrice,
      breakEvenExitPrice: metrics.breakEvenExitPrice,
      targetRewardUsd: metrics.targetRewardUsd,
      expectedRewardUsd: metrics.targetRewardUsd,
      plannedLossUsd: metrics.plannedLossUsd,
      rewardRiskRatio: metrics.rewardRiskRatio,
      stressedNetPnlUsd: metrics.stressedNetPnlUsd,
      holdHorizonMs: config.shadowFollowUpMs,
      expiresAt: now + config.maxBookAgeMs,
      reason: 'persistent flow edge confirmed with executable entry and exit evidence',
    };
    return { status: 'ready', reason: certificate.reason, ...current, certificate };
  }
}
