import type { ThesisCard } from '../types.js';
import { scoreOpportunityForCard, type OpportunityScore } from './opportunityScore.js';
import type { OpportunityRadarOptions, OpportunityRadarRow, OpportunityUrgency } from './opportunityRadar.js';

export interface HotOpportunityIndexOptions extends OpportunityRadarOptions {
  targetDecisionMs?: number;
}

export interface HotOpportunityUpdateResult {
  ticker: string;
  changed: boolean;
  localDecisionMs: number;
  overBudget: boolean;
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function geaBoost(card: ThesisCard): number {
  return card.signalReason.toUpperCase().includes('GEA') ? 8 : 0;
}

function catalystBoost(card: ThesisCard): number {
  const text = `${card.signalReason} ${card.externalSummary}`.toLowerCase();
  return text.includes('release') || text.includes('breaking') || text.includes('catalyst') ? 5 : 0;
}

function urgencyFor(score: number, rejectReasons: string[]): OpportunityUrgency {
  if (rejectReasons.length >= 3) return 'blocked';
  if (score >= 85) return 'hot';
  if (score >= 65) return 'warm';
  return 'watch';
}

function reasonsFor(card: ThesisCard, score: OpportunityScore): string[] {
  const reasons: string[] = [];
  if (card.signalReason.toUpperCase().includes('GEA')) reasons.push('GEA ticket');
  if (card.executableTier) reasons.push(`${card.executableTier} depth`);
  if (score.netEdge >= 0.05) reasons.push('strong net edge');
  if (score.freshnessMs <= 2_000) reasons.push('fresh signal');
  if (score.rejectReasons.length > 0) reasons.push(...score.rejectReasons);
  return reasons;
}

function buildRow(card: ThesisCard, options: HotOpportunityIndexOptions): OpportunityRadarRow {
  const recentPerformance = options.playbookPerformance?.get(card.playbook) ?? 0;
  const score = scoreOpportunityForCard(card, {
    bridgeLatencyMs: options.bridgeLatencyByTicker?.get(card.ticker),
    recentPerformance,
  });
  const rankScore = score.score + geaBoost(card) + catalystBoost(card) + Math.max(0, recentPerformance) * 5;
  return {
    ...score,
    id: card.id,
    title: card.title,
    side: card.side,
    playbook: card.playbook,
    urgency: urgencyFor(rankScore, score.rejectReasons),
    reasons: reasonsFor(card, score),
    rankScore: Number(rankScore.toFixed(2)),
  };
}

export class HotOpportunityIndex {
  private rowsByTicker = new Map<string, OpportunityRadarRow>();
  private sorted: OpportunityRadarRow[] = [];
  private dirty = false;
  private options: HotOpportunityIndexOptions;

  constructor(options: HotOpportunityIndexOptions = {}) {
    this.options = { targetDecisionMs: 3, maxRows: 25, ...options };
  }

  configure(options: HotOpportunityIndexOptions) {
    this.options = { ...this.options, ...options };
    this.dirty = true;
  }

  replaceAll(cards: ThesisCard[], options: HotOpportunityIndexOptions = {}): HotOpportunityUpdateResult {
    const start = nowMs();
    this.configure(options);
    const nextTickers = new Set(cards.map((card) => card.ticker));
    for (const ticker of [...this.rowsByTicker.keys()]) {
      if (!nextTickers.has(ticker)) this.rowsByTicker.delete(ticker);
    }
    for (const card of cards) this.rowsByTicker.set(card.ticker, buildRow(card, this.options));
    this.dirty = true;
    const localDecisionMs = Number((nowMs() - start).toFixed(4));
    return {
      ticker: '*',
      changed: true,
      localDecisionMs,
      overBudget: localDecisionMs > (this.options.targetDecisionMs ?? 3),
    };
  }

  upsert(card: ThesisCard, options: HotOpportunityIndexOptions = {}): HotOpportunityUpdateResult {
    const start = nowMs();
    this.configure(options);
    const prior = this.rowsByTicker.get(card.ticker);
    const next = buildRow(card, this.options);
    const changed = !prior || prior.rankScore !== next.rankScore || prior.urgency !== next.urgency;
    this.rowsByTicker.set(card.ticker, next);
    if (changed) this.dirty = true;
    const localDecisionMs = Number((nowMs() - start).toFixed(4));
    return {
      ticker: card.ticker,
      changed,
      localDecisionMs,
      overBudget: localDecisionMs > (this.options.targetDecisionMs ?? 3),
    };
  }

  remove(ticker: string): boolean {
    const removed = this.rowsByTicker.delete(ticker);
    if (removed) this.dirty = true;
    return removed;
  }

  top(maxRows = this.options.maxRows ?? 25): OpportunityRadarRow[] {
    if (this.dirty) {
      this.sorted = [...this.rowsByTicker.values()]
        .sort((a, b) => b.rankScore - a.rankScore || a.ticker.localeCompare(b.ticker));
      this.dirty = false;
    }
    return this.sorted.slice(0, maxRows);
  }
}
