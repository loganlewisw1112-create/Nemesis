import { candidateEconomicIdentity, type CampaignSnapshot } from '@nemesis/execution';
import type { ThesisCard } from '@nemesis/core';

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
}

export interface CampaignBookTriggerBatch {
  throughputTickers: string[];
  confirmationTickers: string[];
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
): CampaignBookUpdateWork {
  if (!campaign || campaign.manifest.status !== 'active') {
    return { throughput: false, confirmation: false };
  }
  const existingIdentities = new Set(campaign.candidates.map((candidate) => candidate.economicIdentity));
  return {
    throughput: eligibleCards.some((card) =>
      card.ticker === ticker && !existingIdentities.has(candidateEconomicIdentity(card))),
    confirmation: campaign.candidates.some((candidate) =>
      candidate.ticker === ticker && !candidate.terminalState),
  };
}

/** Coalesces bursts without allowing useful work to age past the one-second book gate. */
export class CampaignBookTriggerScheduler {
  private readonly throughputTickers = new Set<string>();
  private readonly confirmationTickers = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    private readonly onFlush: (batch: CampaignBookTriggerBatch) => void,
  ) {}

  request(ticker: string, work: CampaignBookUpdateWork, now = Date.now()): void {
    if (work.throughput) this.throughputTickers.add(ticker);
    if (work.confirmation) this.confirmationTickers.add(ticker);
    if ((!work.throughput && !work.confirmation) || this.timer) return;
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
  }

  private flush(now: number): void {
    if (this.throughputTickers.size === 0 && this.confirmationTickers.size === 0) return;
    const batch = {
      throughputTickers: [...this.throughputTickers],
      confirmationTickers: [...this.confirmationTickers],
    };
    this.throughputTickers.clear();
    this.confirmationTickers.clear();
    this.lastFlushAt = now;
    this.onFlush(batch);
  }
}
