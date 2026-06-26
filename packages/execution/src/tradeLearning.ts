import type { LatencyMetrics, PlaybookId } from '@nemesis/core';

export type MistakeFailureType =
  | 'loss'
  | 'late_close'
  | 'oversize'
  | 'stale_book'
  | 'slippage_breach'
  | 'slow_exchange';

export interface TradeOutcomeRecord {
  id: string;
  ticker: string;
  side: 'yes' | 'no';
  playbook: PlaybookId;
  openedAt: number;
  closedAt: number;
  size: number;
  entryPrice: number;
  exitPrice: number;
  fees: number;
  slippage: number;
  realizedPnl: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  latencyMetrics: LatencyMetrics;
  geaSignals: string[];
  decisionReasons: string[];
  marketRegime: string;
  liquidityBucket: string;
  spreadBucket: string;
  latencyBucket: string;
  bookAgeMs?: number;
  intendedSize?: number;
}

export interface MistakeSignature {
  id: string;
  failureType: MistakeFailureType;
  playbook: PlaybookId;
  marketRegime: string;
  liquidityBucket: string;
  spreadBucket: string;
  latencyBucket: string;
  sizingCause?: string;
  exitCause?: string;
  blockingRule: string;
  sourceTradeId: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface TradeCandidateSignature {
  playbook: PlaybookId;
  marketRegime: string;
  liquidityBucket: string;
  spreadBucket: string;
  latencyBucket: string;
}

export interface TradeLearningSettings {
  maxSlippagePp: number;
  maxBookAgeMs: number;
  maxSubmitRttMs: number;
  lateCloseRegretUsd: number;
}

const DEFAULT_TRADE_LEARNING_SETTINGS: TradeLearningSettings = {
  maxSlippagePp: 0.03,
  maxBookAgeMs: 2_000,
  maxSubmitRttMs: 50,
  lateCloseRegretUsd: 0.25,
};

function sameCandidate(candidate: TradeCandidateSignature, sig: MistakeSignature): boolean {
  return candidate.playbook === sig.playbook &&
    candidate.marketRegime === sig.marketRegime &&
    candidate.liquidityBucket === sig.liquidityBucket &&
    candidate.spreadBucket === sig.spreadBucket &&
    candidate.latencyBucket === sig.latencyBucket;
}

function signatureId(record: TradeOutcomeRecord, failureType: MistakeFailureType): string {
  return [
    failureType,
    record.playbook,
    record.marketRegime,
    record.liquidityBucket,
    record.spreadBucket,
    record.latencyBucket,
  ].join(':');
}

function buildSignature(record: TradeOutcomeRecord, failureType: MistakeFailureType, now: number): MistakeSignature {
  return {
    id: signatureId(record, failureType),
    failureType,
    playbook: record.playbook,
    marketRegime: record.marketRegime,
    liquidityBucket: record.liquidityBucket,
    spreadBucket: record.spreadBucket,
    latencyBucket: record.latencyBucket,
    sizingCause: failureType === 'oversize' ? 'intended size exceeded learned cap' : undefined,
    exitCause: failureType === 'late_close' ? 'profit gave back before close' : undefined,
    blockingRule: `unresolved ${failureType} mistake`,
    sourceTradeId: record.id,
    createdAt: now,
  };
}

export class TradeLearningLedger {
  private outcomes: TradeOutcomeRecord[] = [];
  private signatures = new Map<string, MistakeSignature>();
  private settings: TradeLearningSettings;

  constructor(settings: Partial<TradeLearningSettings> = {}) {
    this.settings = { ...DEFAULT_TRADE_LEARNING_SETTINGS, ...settings };
  }

  recordOutcome(record: TradeOutcomeRecord, now = Date.now()): MistakeSignature[] {
    this.outcomes.unshift(record);
    const failureTypes = new Set<MistakeFailureType>();
    if (record.realizedPnl < 0) failureTypes.add('loss');
    if (record.maxFavorableExcursion - record.realizedPnl >= this.settings.lateCloseRegretUsd) failureTypes.add('late_close');
    if (record.intendedSize !== undefined && record.size > record.intendedSize) failureTypes.add('oversize');
    if ((record.bookAgeMs ?? 0) > this.settings.maxBookAgeMs) failureTypes.add('stale_book');
    if (record.slippage > this.settings.maxSlippagePp) failureTypes.add('slippage_breach');
    if (record.latencyMetrics.orderSubmitRttMs > this.settings.maxSubmitRttMs) failureTypes.add('slow_exchange');

    const created: MistakeSignature[] = [];
    for (const failureType of failureTypes) {
      const sig = buildSignature(record, failureType, now);
      const existing = this.signatures.get(sig.id);
      if (!existing || existing.resolvedAt) {
        this.signatures.set(sig.id, sig);
        created.push(sig);
      } else {
        created.push(existing);
      }
    }
    return created;
  }

  evaluateCandidate(candidate: TradeCandidateSignature): { allowed: boolean; noTradeReasons: string[]; signatures: MistakeSignature[] } {
    const signatures = [...this.signatures.values()].filter((sig) => !sig.resolvedAt && sameCandidate(candidate, sig));
    return {
      allowed: signatures.length === 0,
      noTradeReasons: signatures.map((sig) => sig.blockingRule),
      signatures,
    };
  }

  hasUnresolvedMistake(candidate: TradeCandidateSignature): boolean {
    return !this.evaluateCandidate(candidate).allowed;
  }

  resolveSignature(id: string, now = Date.now()): boolean {
    const sig = this.signatures.get(id);
    if (!sig) return false;
    sig.resolvedAt = now;
    return true;
  }

  snapshot() {
    return {
      outcomes: [...this.outcomes],
      signatures: [...this.signatures.values()],
    };
  }
}
