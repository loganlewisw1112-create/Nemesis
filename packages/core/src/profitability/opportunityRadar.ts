import type { ThesisCard } from '../types.js';
import { scoreOpportunityForCard, type OpportunityScore } from './opportunityScore.js';

export type OpportunityUrgency = 'hot' | 'warm' | 'watch' | 'blocked';

export interface OpportunityRadarOptions {
  bridgeLatencyByTicker?: Map<string, number>;
  playbookPerformance?: Map<string, number>;
  maxRows?: number;
}

export interface OpportunityRadarRow extends OpportunityScore {
  id: string;
  title: string;
  side: ThesisCard['side'];
  playbook: ThesisCard['playbook'];
  urgency: OpportunityUrgency;
  reasons: string[];
  rankScore: number;
}

function geaBoost(card: ThesisCard): number {
  return card.signalReason.toUpperCase().includes('GEA') ? 8 : 0;
}

function catalystBoost(card: ThesisCard): number {
  const text = `${card.signalReason} ${card.externalSummary}`.toLowerCase();
  if (text.includes('release') || text.includes('breaking') || text.includes('catalyst')) return 5;
  return 0;
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

export function rankOpportunityRadar(cards: ThesisCard[], options: OpportunityRadarOptions = {}): OpportunityRadarRow[] {
  return cards
    .map((card) => {
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
    })
    .sort((a, b) => b.rankScore - a.rankScore || a.ticker.localeCompare(b.ticker))
    .slice(0, options.maxRows ?? 25);
}
