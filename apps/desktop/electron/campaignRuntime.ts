import { candidateEconomicIdentity, type CampaignSnapshot } from '@nemesis/execution';
import {
  isKnownKalshiFeePolicy,
  type KalshiOrderbook,
  type ThesisCard,
} from '@nemesis/core';

export type PaperExecutionSource = 'manual' | 'working-order' | 'throughput';

export function isEvidenceOnlyCampaignExecution(
  source: PaperExecutionSource,
  campaign: CampaignSnapshot | null,
): boolean {
  return source === 'throughput'
    && campaign?.manifest.status === 'active';
}

export function campaignPendingCapacity(
  campaign: CampaignSnapshot,
  maxPendingCandidates: number,
): number {
  const pending = campaign.candidates.filter((candidate) => !candidate.terminalState).length;
  return Math.max(0, maxPendingCandidates - pending);
}

export interface CampaignBookUpdateWork {
  throughput: boolean;
  confirmation: boolean;
  diagnostic: boolean;
}

export interface CampaignBookTriggerBatch {
  throughputTickers: string[];
  confirmationTickers: string[];
  diagnosticTickers: string[];
}

export type CampaignEnrollmentReadiness =
  | { ready: true }
  | { ready: false; reason: string };

/** Runtime faults may invalidate only a real supervised evidence attempt, never an ordinary app/soak session. */
export function shouldInvalidateSupervisedEvidence(
  hasCampaignPointer: boolean,
  supervisorState: string | undefined,
  runtimeInvalidated: boolean,
): boolean {
  return hasCampaignPointer && supervisorState !== 'preflight' && runtimeInvalidated;
}

/**
 * A campaign lifecycle may start only from evidence that can actually qualify.
 * REST/snapshot books and unresolved fee schedules remain retryable upstream;
 * they must not consume an economic identity or create a terminal candidate.
 */
export function campaignEnrollmentReadiness(
  book: KalshiOrderbook,
  observedAt: number,
  maxBookAgeMs: number,
): CampaignEnrollmentReadiness {
  if (book.sourceTimestamp == null || !Number.isFinite(book.sourceTimestamp) || book.sequence == null || !Number.isFinite(book.sequence)) {
    return { ready: false, reason: 'campaign enrollment awaits an exchange-timestamped order-book delta' };
  }
  const bookAgeMs = observedAt - book.sourceTimestamp;
  if (bookAgeMs > maxBookAgeMs) {
    return { ready: false, reason: `campaign enrollment awaits a fresh order-book delta; current book is ${Math.round(bookAgeMs)}ms old` };
  }
  if (bookAgeMs < -maxBookAgeMs) {
    return { ready: false, reason: 'campaign enrollment rejected an exchange book timestamp outside the allowed clock window' };
  }
  if (!isKnownKalshiFeePolicy(book.feePolicy)) {
    return { ready: false, reason: 'campaign enrollment awaits a resolved market, series, and account fee policy' };
  }
  return { ready: true };
}

/**
 * A book delta is useful only when it can enroll a new economic identity or
 * advance an already-persisted candidate for the same ticker. This keeps the
 * high-volume exchange stream from turning the audit ledger into the event
 * loop's primary workload.
 */
export function campaignBookUpdateWork(
  ticker: string,
  eligibleCards: readonly ThesisCard[],
  campaign: CampaignSnapshot | null,
  now = Date.now(),
): CampaignBookUpdateWork {
  if (!campaign || campaign.manifest.status !== 'active') {
    return { throughput: false, confirmation: false, diagnostic: false };
  }
  const existingIdentities = new Set(campaign.candidates.map((candidate) => candidate.economicIdentity));
  const candidateIdsForTicker = new Set(
    campaign.candidates
      .filter((candidate) => candidate.ticker === ticker)
      .map((candidate) => candidate.candidateId),
  );
  return {
    throughput: eligibleCards.some((card) =>
      card.ticker === ticker && !existingIdentities.has(candidateEconomicIdentity(card))),
    confirmation: campaign.candidates.some((candidate) =>
      candidate.ticker === ticker && !candidate.terminalState),
    diagnostic: campaign.diagnostics.some((diagnostic) =>
      candidateIdsForTicker.has(diagnostic.candidateId)
      && diagnostic.status === 'scheduled'
      && diagnostic.dueAt <= now),
  };
}

/** Coalesces bursts without allowing useful work to age past the one-second book gate. */
export class CampaignBookTriggerScheduler {
  private readonly throughputTickers = new Set<string>();
  private readonly confirmationTickers = new Set<string>();
  private readonly diagnosticTickers = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    private readonly onFlush: (batch: CampaignBookTriggerBatch) => void,
  ) {}

  request(ticker: string, work: CampaignBookUpdateWork, now = Date.now()): void {
    if (work.throughput) this.throughputTickers.add(ticker);
    if (work.confirmation) this.confirmationTickers.add(ticker);
    if (work.diagnostic) this.diagnosticTickers.add(ticker);
    if ((!work.throughput && !work.confirmation && !work.diagnostic) || this.timer) return;
    const elapsed = now - this.lastFlushAt;
    const delay = Number.isFinite(elapsed) ? Math.max(0, this.intervalMs - elapsed) : 0;
    if (delay === 0) {
      this.flush(now);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(Date.now());
    }, delay);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.throughputTickers.clear();
    this.confirmationTickers.clear();
    this.diagnosticTickers.clear();
  }

  private flush(now: number): void {
    if (
      this.throughputTickers.size === 0
      && this.confirmationTickers.size === 0
      && this.diagnosticTickers.size === 0
    ) return;
    const batch = {
      throughputTickers: [...this.throughputTickers],
      confirmationTickers: [...this.confirmationTickers],
      diagnosticTickers: [...this.diagnosticTickers],
    };
    this.throughputTickers.clear();
    this.confirmationTickers.clear();
    this.diagnosticTickers.clear();
    this.lastFlushAt = now;
    this.onFlush(batch);
  }
}
