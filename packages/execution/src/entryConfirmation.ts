import {
  DEFAULT_ENTRY_QUALIFICATION,
  isSupportedQualificationFeeOrder,
  type EntryQualificationSettings,
  type ProfitCertificate,
  type ThesisCard,
} from '@nemesis/core';
import type { DryRunOrder } from './dryRun.js';
import { calculateEntryEconomics, type EntryEconomicsEvidence } from './tradeEconomics.js';

export interface EntryConfirmationObservation {
  card: ThesisCard;
  fill: DryRunOrder;
  baseCertificate: ProfitCertificate;
  bookTimestamp: number;
  observedAt?: number;
  sourceAlreadyUsed?: boolean;
  lastTickerExecutionAt?: number;
}

interface ConfirmationSample {
  at: number;
  netEdge: number;
  spread: number;
  bookTimestamp: number;
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

  reset(sourceSignalId?: string): void {
    if (sourceSignalId) this.states.delete(sourceSignalId);
    else this.states.clear();
  }

  observe(input: EntryConfirmationObservation): EntryConfirmationResult {
    const now = input.observedAt ?? Date.now();
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
    if (bookAgeMs > config.maxBookAgeMs) return reject('entry book is stale');
    if (!Number.isFinite(input.fill.netEdge) || input.fill.netEdge <= 0) {
      return reject('executable entry edge is not positive');
    }
    if (!isSupportedQualificationFeeOrder(input.fill.fillPrice, input.fill.filled)) {
      return reject('qualification fee model requires whole contracts at one-cent entry prices');
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

    let state = this.states.get(input.card.id);
    if (!state) {
      state = { sourceSignalId: input.card.id, ticker: input.card.ticker, side: input.card.side, samples: [] };
      this.states.set(input.card.id, state);
    }
    if (state.ticker !== input.card.ticker || state.side !== input.card.side) {
      this.states.delete(input.card.id);
      return reject('source signal identity changed during confirmation');
    }
    const minSpacingMs = Math.max(1, Math.floor(config.minWindowMs / Math.max(1, config.minSamples)));
    const last = state.samples.at(-1);
    if (!last || now - last.at >= minSpacingMs) {
      state.samples.push({ at: now, netEdge: input.fill.netEdge, spread: input.card.spread, bookTimestamp: input.bookTimestamp });
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
      this.states.delete(input.card.id);
      return { status: 'rejected', reason: 'spread widened during entry confirmation', ...current };
    }
    if (edgeRetention < config.minEdgeRetention) {
      this.states.delete(input.card.id);
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
