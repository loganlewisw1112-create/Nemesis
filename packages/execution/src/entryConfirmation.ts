import {
  DEFAULT_ENTRY_QUALIFICATION,
  isKnownKalshiFeePolicy,
  type EntryQualificationSettings,
  type KalshiFeePolicy,
  type ProfitCertificate,
  type ThesisCard,
} from '@nemesis/core';
import { campaignEconomicIdentity } from './economicIdentity.js';
import { isSupportedQualificationFill, type DryRunOrder } from './dryRun.js';
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
  economicIdentity: string;
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
 * Must cover a full confirmation window (production paper settings use
 * minWindowMs=15s / minSamples=4): a completely quiet book that never emits a
 * new sequence still needs its final sample at t≈minWindowMs, so a 10s ceiling
 * made sample 4 structurally unreachable and stalled chains at 3. Keep this
 * below the 25s dead-connection bound so continuity cannot vouch for a socket
 * that is itself about to be declared dead.
 */
export const MAX_PROVEN_QUIET_BOOK_AGE_MS = 20_000;

/** The absolute entry-quality bars, evaluated together. Null when all pass. */
function absoluteBarFailure(
  metrics: EntryEconomicsEvidence,
  config: EntryQualificationSettings,
): string | null {
  if (metrics.targetRewardUsd < config.minExpectedNetPnlUsd) return 'target net reward is below the minimum';
  if (metrics.rewardRiskRatio < config.minRewardRiskRatio) return 'target reward-to-risk ratio is below the minimum';
  if (metrics.stressedNetPnlUsd < config.minStressedNetPnlUsd) return 'one-cent stressed expected result is not profitable';
  return null;
}

export class EntryConfirmationEngine {
  private readonly states = new Map<string, ConfirmationState>();
  /** Consumed source signal ids and economic identities (post-trade / shadow claim). */
  private readonly usedSources = new Set<string>();
  /** Maps a sourceSignalId to the state key it last belonged to. */
  private readonly sourceToStateKey = new Map<string, string>();

  constructor(private readonly settings: EntryQualificationSettings = DEFAULT_ENTRY_QUALIFICATION) {}

  markSourceUsed(sourceSignalId: string): void {
    this.usedSources.add(sourceSignalId);
    const keysToClear = new Set<string>();
    const mappedKey = this.sourceToStateKey.get(sourceSignalId);
    if (mappedKey) keysToClear.add(mappedKey);
    if (this.states.has(sourceSignalId)) keysToClear.add(sourceSignalId);
    for (const [key, state] of this.states) {
      if (state.sourceSignalId === sourceSignalId || state.economicIdentity === sourceSignalId) {
        keysToClear.add(key);
      }
    }
    for (const key of keysToClear) {
      const state = this.states.get(key);
      if (state) {
        this.usedSources.add(state.economicIdentity);
        this.usedSources.add(state.sourceSignalId);
      }
      this.states.delete(key);
    }
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
    if (sourceSignalId) {
      const mappedKey = this.sourceToStateKey.get(sourceSignalId);
      if (mappedKey) this.states.delete(mappedKey);
      this.states.delete(sourceSignalId);
      this.sourceToStateKey.delete(sourceSignalId);
      return;
    }
    this.states.clear();
    this.sourceToStateKey.clear();
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
    const economicIdentity = campaignEconomicIdentity({
      ticker: input.ticker,
      side: input.side,
      playbook: 'flow-hunter',
      sourceMove: 'flow-driven',
    });
    if (this.usedSources.has(economicIdentity)) return;
    this.states.set(input.candidateId, {
      sourceSignalId: input.sourceSignalId,
      economicIdentity,
      ticker: input.ticker,
      side: input.side,
      samples,
    });
    this.sourceToStateKey.set(input.sourceSignalId, input.candidateId);
  }

  observe(input: EntryConfirmationObservation): EntryConfirmationResult {
    const now = input.observedAt ?? Date.now();
    const economicIdentity = campaignEconomicIdentity(input.card);
    // Prefer an explicit campaign candidate id when present; otherwise key on the
    // stable economic identity so re-issued flow card.ids continue one chain.
    const candidateId = input.candidateId ?? economicIdentity;
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
    if (
      this.usedSources.has(input.card.id)
      || this.usedSources.has(economicIdentity)
      || input.sourceAlreadyUsed
    ) return reject('source signal already used');
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
    if (!isSupportedQualificationFill(input.fill)) {
      return reject('qualification fee model requires a four-decimal price and two-decimal quantity');
    }
    if (!Number.isFinite(input.card.impliedPrice) || metrics.targetExitPrice <= input.fill.fillPrice) {
      return reject('selected-side fair price does not exceed the executable entry');
    }
    if (
      input.lastTickerExecutionAt != null
      && now - input.lastTickerExecutionAt < config.tickerCooldownMs
    ) return reject('ticker-side cooldown is active');
    // The absolute economic bars gate ENTRY; edgeRetention and spread-widening
    // gate PERSISTENCE. Re-testing the absolute bars on every sample conflated
    // the two and compounded them: a bar that 16% of observations clear becomes
    // a ~0.07% bar when it must clear four times in a row. Measured over 155
    // candidates, exactly one ever accumulated a sample. They are therefore
    // enforced at admission (below) and again at the confirming observation
    // (further down) -- the moment the entry is actually taken -- but not on the
    // intermediate samples, whose job is only to prove the edge held.
    const priorState = this.states.get(candidateId);
    const admitting = !priorState || priorState.samples.length === 0;
    if (admitting) {
      const barFailure = absoluteBarFailure(metrics, config);
      if (barFailure) return reject(barFailure);
    }

    let state = this.states.get(candidateId);
    if (!state) {
      state = {
        sourceSignalId: input.card.id,
        economicIdentity,
        ticker: input.card.ticker,
        side: input.card.side,
        samples: [],
      };
      this.states.set(candidateId, state);
    }
    // Ticker/side/playbook/sourceMove are encoded in economicIdentity. A new
    // card.id for the same identity is a re-issued GEA signal — continue the
    // chain and adopt the latest id. A true identity change rejects.
    if (state.economicIdentity !== economicIdentity
      || state.ticker !== input.card.ticker
      || state.side !== input.card.side) {
      this.states.delete(candidateId);
      return reject('source signal identity changed during confirmation');
    }
    state.sourceSignalId = input.card.id;
    this.sourceToStateKey.set(input.card.id, candidateId);
    // Anti-burst spacing only: it exists so four reads of the same instant
    // cannot pass for four samples. The actual persistence guarantees are
    // enforced independently below -- minSamples AND minWindowMs must both hold
    // before a candidate confirms -- so this bound does not need to carry the
    // window itself.
    //
    // Tiling it exactly across the window (minWindowMs / (minSamples - 1))
    // computed to 5000ms against an observation cadence whose measured median
    // is exactly 5.0s, leaving zero slack: roughly every other observation fell
    // a few milliseconds short and was silently dropped, while the source
    // signal expired at maxSourceAgeMs. Across 155 candidates exactly one ever
    // accumulated a sample, and it stalled at 3 of 4. Halving the requirement
    // keeps samples meaningfully spread while giving the natural cadence room
    // to land; the 15s window and the 4-sample count are unchanged.
    const minSpacingMs = Math.max(
      1,
      Math.floor(Math.ceil(config.minWindowMs / Math.max(1, config.minSamples - 1)) / 2),
    );
    const last = state.samples.at(-1);
    const spaced = !last || now - last.at >= minSpacingMs;
    const freshSequence = !state.samples.some((sample) => sample.bookSequence === input.bookSequence);
    // A persistence sample proves the edge held across time on a live book. A
    // fresh exchange sequence always qualifies. But requiring a *new* sequence
    // for every sample fits only high-frequency markets: a slow, quiet
    // instrument (index up/down, crypto-daily) can carry genuine, stable edge
    // while its book ticks only once or twice in the window, so it could never
    // reach the sample count and would never trade -- the mirror of the
    // fast-market edge-decay failure. When the transport proves the book is
    // still live and gap-free (bookContinuityProven), an unchanged book
    // re-observed after the spacing interval is itself evidence the edge
    // persisted, so it counts. Book verification is untouched: the
    // exchange-origin timestamp+sequence is still required above, and
    // bookContinuityProven already demands a tracked, un-quarantined, unlapsed
    // book on a qualification-ready transport -- a dead feed cannot fake it.
    const admitSample = spaced && (freshSequence || input.bookContinuityProven === true);
    if (admitSample) {
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

    // The confirming observation is the entry itself, so the full economic bars
    // apply here in their own right -- an entry is never taken on economics that
    // do not currently clear them, however good the admitting sample looked.
    const confirmingBarFailure = absoluteBarFailure(metrics, config);
    if (confirmingBarFailure) return reject(confirmingBarFailure);

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
