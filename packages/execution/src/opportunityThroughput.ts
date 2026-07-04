import type {
  ExecutionQueueState,
  OpportunityThroughputSettings,
  ProfitCertificate,
  ThesisCard,
} from '@nemesis/core';
import { DEFAULT_OPPORTUNITY_THROUGHPUT } from '@nemesis/core';

export type OpportunityQueueState = ExecutionQueueState;

export interface OpportunityQueueItem {
  key: string;
  ticker: string;
  side: 'yes' | 'no';
  thesisId: string;
  playbook: string;
  state: OpportunityQueueState;
  discoveredAt: number;
  updatedAt: number;
  blockReason?: string;
  nextRetryAt?: number;
  profitCertificate?: ProfitCertificate;
}

export interface OpportunityThroughputTelemetry {
  candidatesScanned: number;
  booksFetched: number;
  certifiedTrades: number;
  executedTrades: number;
  profitBlocked: number;
  retryableBlocked: number;
  avgCertificationMs: number;
  certifiedProfitPerDay: number;
}

export interface OpportunityThroughputSnapshot {
  items: OpportunityQueueItem[];
  telemetry: OpportunityThroughputTelemetry;
}

function keyFor(card: Pick<ThesisCard, 'ticker' | 'side'>): string {
  return `${card.ticker}:${card.side}`;
}

function downgradeActionableStatus(card: ThesisCard): ThesisCard['status'] {
  return card.status === 'tradeable' || card.status === 'qualified'
    ? 'watch-only'
    : card.status;
}

export function annotateCardsWithCertification(
  cards: ThesisCard[],
  snapshot: OpportunityThroughputSnapshot,
  now = Date.now(),
): ThesisCard[] {
  const byKey = new Map(snapshot.items.map((item) => [item.key, item]));
  return cards.map((card) => {
    const item = byKey.get(keyFor(card));
    if (!item) {
      return {
        ...card,
        executionQueueState: 'discovered',
        executionBlockReason: undefined,
        executionAbortCode: undefined,
        certifiedNetPnlUsd: undefined,
        profitCertificate: undefined,
      };
    }

    const certificate = item.profitCertificate;
    if (item.state === 'certified' && certificate) {
      if (certificate.expiresAt >= now) {
        return {
          ...card,
          executionQueueState: 'certified',
          executionBlockReason: undefined,
          executionAbortCode: undefined,
          certifiedNetPnlUsd: certificate.netPnlUsd,
          profitCertificate: certificate,
        };
      }

      return {
        ...card,
        status: downgradeActionableStatus(card),
        executionQueueState: 'blocked_retryable',
        executionBlockReason: 'profit certificate expired; awaiting fresh executable book',
        executionAbortCode: 'certificate_expired',
        certifiedNetPnlUsd: undefined,
        profitCertificate: undefined,
      };
    }

    if (item.state === 'blocked_retryable' || item.state === 'blocked_final') {
      return {
        ...card,
        status: downgradeActionableStatus(card),
        executionQueueState: item.state,
        executionBlockReason: item.blockReason,
        executionAbortCode: item.blockReason,
        certifiedNetPnlUsd: undefined,
        profitCertificate: undefined,
      };
    }

    return {
      ...card,
      executionQueueState: item.state,
      executionBlockReason: item.blockReason,
      executionAbortCode: item.blockReason,
      certifiedNetPnlUsd: undefined,
      profitCertificate: undefined,
    };
  });
}

function emptyTelemetry(): OpportunityThroughputTelemetry {
  return {
    candidatesScanned: 0,
    booksFetched: 0,
    certifiedTrades: 0,
    executedTrades: 0,
    profitBlocked: 0,
    retryableBlocked: 0,
    avgCertificationMs: 0,
    certifiedProfitPerDay: 0,
  };
}

export class OpportunityThroughputQueue {
  private readonly settings: OpportunityThroughputSettings;
  private readonly items = new Map<string, OpportunityQueueItem>();
  private telemetry = emptyTelemetry();
  private certificationSamples = 0;

  constructor(settings: Partial<OpportunityThroughputSettings> = {}) {
    this.settings = { ...DEFAULT_OPPORTUNITY_THROUGHPUT, ...settings };
  }

  discover(cards: ThesisCard[], now = Date.now()) {
    for (const card of cards) {
      this.telemetry.candidatesScanned += 1;
      const key = keyFor(card);
      const existing = this.items.get(key);
      if (existing) {
        existing.updatedAt = now;
        continue;
      }
      this.items.set(key, {
        key,
        ticker: card.ticker,
        side: card.side,
        thesisId: card.id,
        playbook: card.playbook,
        state: 'discovered',
        discoveredAt: now,
        updatedAt: now,
      });
    }
  }

  markBookFetched(key: string) {
    this.telemetry.booksFetched += 1;
    const item = this.items.get(key);
    if (item) item.state = 'book_pending';
  }

  markCertified(key: string, profitCertificate: ProfitCertificate, now = Date.now(), certificationMs = 0) {
    const item = this.items.get(key);
    if (!item) return;
    item.state = 'certified';
    item.updatedAt = now;
    item.blockReason = undefined;
    item.nextRetryAt = undefined;
    item.profitCertificate = profitCertificate;
    this.telemetry.certifiedTrades += 1;
    this.telemetry.certifiedProfitPerDay += Math.max(0, profitCertificate.netPnlUsd);
    this.certificationSamples += 1;
    this.telemetry.avgCertificationMs = Number((
      ((this.telemetry.avgCertificationMs * (this.certificationSamples - 1)) + certificationMs) /
      this.certificationSamples
    ).toFixed(4));
  }

  markBlocked(key: string, reason: string, retryable: boolean, now = Date.now()) {
    const item = this.items.get(key);
    if (!item) return;
    item.state = retryable ? 'blocked_retryable' : 'blocked_final';
    item.updatedAt = now;
    item.blockReason = reason;
    item.nextRetryAt = retryable ? now + this.settings.retryableBlockCooldownMs : undefined;
    item.profitCertificate = undefined;
    if (retryable) this.telemetry.retryableBlocked += 1;
    else if (/profit/i.test(reason)) this.telemetry.profitBlocked += 1;
  }

  markExecuted(key: string, now = Date.now()) {
    const item = this.items.get(key);
    if (!item) return;
    item.state = 'executed';
    item.updatedAt = now;
    this.telemetry.executedTrades += 1;
  }

  dueForRetry(now = Date.now()): OpportunityQueueItem[] {
    return [...this.items.values()]
      .filter((item) => item.state === 'blocked_retryable' && (item.nextRetryAt ?? Number.POSITIVE_INFINITY) <= now)
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }

  nextCertified(): OpportunityQueueItem | undefined {
    return [...this.items.values()]
      .filter((item) => item.state === 'certified' && item.profitCertificate)
      .sort((a, b) => (b.profitCertificate?.netPnlUsd ?? 0) - (a.profitCertificate?.netPnlUsd ?? 0))[0];
  }

  snapshot(): OpportunityThroughputSnapshot {
    return {
      items: [...this.items.values()].map((item) => ({ ...item })),
      telemetry: { ...this.telemetry },
    };
  }
}
