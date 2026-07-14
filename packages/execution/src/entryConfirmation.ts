import {
  DEFAULT_ENTRY_QUALIFICATION,
  kalshiFeeForOrder,
  type EntryQualificationSettings,
  type ProfitCertificate,
  type ThesisCard,
} from '@nemesis/core';
import type { DryRunOrder } from './dryRun.js';

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
  expectedRewardUsd: number;
  plannedLossUsd: number;
  rewardRiskRatio: number;
  stressedNetPnlUsd: number;
  certificate?: ProfitCertificate;
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function economics(card: ThesisCard, fill: DryRunOrder) {
  const contracts = fill.filled;
  const entryPrice = fill.fillPrice;
  const targetExitPrice = Math.max(0.01, Math.min(0.99, entryPrice + Math.max(0, card.netEdge)));
  const targetExitFees = kalshiFeeForOrder(targetExitPrice, contracts);
  const entryCost = entryPrice * contracts + fill.fees;
  const expectedRewardUsd = targetExitPrice * contracts - targetExitFees - entryCost;
  const stopPrice = Math.max(0.01, entryPrice - 0.01);
  const stopFees = kalshiFeeForOrder(stopPrice, contracts);
  const plannedLossUsd = Math.max(0.01, entryCost - (stopPrice * contracts - stopFees));
  const stressedEntryPrice = Math.min(0.99, entryPrice + 0.01);
  const stressedEntryFees = kalshiFeeForOrder(stressedEntryPrice, contracts);
  const stressedExitPrice = Math.max(0.01, targetExitPrice - 0.01);
  const stressedExitFees = kalshiFeeForOrder(stressedExitPrice, contracts);
  const stressedNetPnlUsd = stressedExitPrice * contracts - stressedExitFees
    - (stressedEntryPrice * contracts + stressedEntryFees);
  const breakEvenExitPrice = Math.min(0.99, (entryCost + kalshiFeeForOrder(entryPrice, contracts)) / Math.max(1, contracts));
  return {
    targetExitPrice: round(targetExitPrice),
    breakEvenExitPrice: round(breakEvenExitPrice),
    expectedRewardUsd: round(expectedRewardUsd),
    plannedLossUsd: round(plannedLossUsd),
    rewardRiskRatio: round(expectedRewardUsd / plannedLossUsd),
    stressedNetPnlUsd: round(stressedNetPnlUsd),
  };
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
    const metrics = economics(input.card, input.fill);
    const base = {
      samples: 0,
      windowMs: 0,
      edgeRetention: 0,
      ...metrics,
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
    if (!Number.isFinite(input.card.netEdge) || input.card.netEdge <= 0) return reject('net edge is not positive');
    if (
      input.lastTickerExecutionAt != null
      && now - input.lastTickerExecutionAt < config.tickerCooldownMs
    ) return reject('ticker-side cooldown is active');
    if (metrics.expectedRewardUsd < config.minExpectedNetPnlUsd) return reject('expected net reward is below the minimum');
    if (metrics.rewardRiskRatio < config.minRewardRiskRatio) return reject('expected reward-to-risk ratio is below the minimum');
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
      state.samples.push({ at: now, netEdge: input.card.netEdge, spread: input.card.spread, bookTimestamp: input.bookTimestamp });
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
      ...metrics,
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
      expectedRewardUsd: metrics.expectedRewardUsd,
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
