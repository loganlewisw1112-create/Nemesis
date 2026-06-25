import type { ThesisCard } from '../types.js';
import type { ExecutableTier } from '../discovery/types.js';

export interface OpportunityScore {
  ticker: string;
  score: number;
  netEdge: number;
  probabilityGap: number;
  fillableUsd: number;
  slippagePp: number;
  freshnessMs: number;
  confidence: number;
  rejectReasons: string[];
}

export interface OpportunityScoreInput {
  ticker: string;
  netEdge: number;
  probabilityGap: number;
  fillableUsd?: number;
  depthUsd?: number;
  slippagePp?: number;
  spread?: number;
  freshnessMs: number;
  confidence: number;
  settlementClarity: number;
  executableTier?: ExecutableTier | null;
  bridgeLatencyMs?: number;
  recentPerformance?: number;
  maxFreshnessMs?: number;
  maxBridgeLatencyMs?: number;
}

const TIER_BONUS: Record<ExecutableTier, number> = {
  scout: 2,
  solid: 4,
  whale: 6,
};

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizeConfidence(value: number): number {
  return value > 1 ? clamp(value / 100) : clamp(value);
}

export function scoreOpportunity(input: OpportunityScoreInput): OpportunityScore {
  const maxFreshnessMs = input.maxFreshnessMs ?? 30_000;
  const maxBridgeLatencyMs = input.maxBridgeLatencyMs ?? 2_000;
  const fillableUsd = input.fillableUsd ?? input.depthUsd ?? 0;
  const slippagePp = input.slippagePp ?? Math.max(0, (input.spread ?? 0) / 2);
  const confidence = normalizeConfidence(input.confidence);
  const settlementClarity = normalizeConfidence(input.settlementClarity);
  const rejectReasons: string[] = [];

  if (input.netEdge <= 0) rejectReasons.push('non-positive net edge');
  if (input.freshnessMs > maxFreshnessMs) rejectReasons.push('stale signal');
  if (fillableUsd < 100 || (input.depthUsd ?? fillableUsd) < 100) rejectReasons.push('thin book');
  if ((input.spread ?? 0) > 0.07 || slippagePp > 0.05) rejectReasons.push('wide spread/slippage');
  if (settlementClarity < 0.55) rejectReasons.push('low settlement clarity');
  if (confidence < 0.5) rejectReasons.push('low confidence');
  if ((input.bridgeLatencyMs ?? 0) > maxBridgeLatencyMs) rejectReasons.push('slow GEA bridge');
  if (input.netEdge <= 0.03 && confidence < 0.6 && settlementClarity < 0.6) {
    rejectReasons.push('heuristic-only edge');
  }

  const netEdgeScore = clamp(input.netEdge / 0.08) * 28;
  const probabilityScore = clamp(Math.abs(input.probabilityGap) / 0.12) * 18;
  const liquidityScore = clamp(fillableUsd / 500) * 14 + (input.executableTier ? TIER_BONUS[input.executableTier] : 0);
  const freshnessScore = clamp(1 - input.freshnessMs / maxFreshnessMs) * 10;
  const confidenceScore = confidence * 14;
  const clarityScore = settlementClarity * 10;
  const latencyScore = clamp(1 - (input.bridgeLatencyMs ?? 0) / maxBridgeLatencyMs) * 6;
  const performanceScore = clamp(((input.recentPerformance ?? 0) + 1) / 2) * 6;
  const penalty = rejectReasons.length * 6;

  const score = clamp(
    netEdgeScore +
      probabilityScore +
      liquidityScore +
      freshnessScore +
      confidenceScore +
      clarityScore +
      latencyScore +
      performanceScore -
      penalty,
    0,
    100,
  );

  return {
    ticker: input.ticker,
    score: Number(score.toFixed(2)),
    netEdge: input.netEdge,
    probabilityGap: input.probabilityGap,
    fillableUsd,
    slippagePp,
    freshnessMs: input.freshnessMs,
    confidence,
    rejectReasons,
  };
}

export function scoreOpportunityForCard(
  card: ThesisCard,
  options: Pick<OpportunityScoreInput, 'bridgeLatencyMs' | 'recentPerformance' | 'maxFreshnessMs' | 'maxBridgeLatencyMs'> = {},
): OpportunityScore {
  const confidence = normalizeConfidence(card.predictability);
  const settlementClarity = card.signalReason.toUpperCase().includes('GEA')
    ? Math.max(confidence, 0.78)
    : confidence;

  return scoreOpportunity({
    ticker: card.ticker,
    netEdge: card.netEdge,
    probabilityGap: card.impliedPrice - card.marketPrice,
    fillableUsd: card.fillableUsd ?? card.depthUsd,
    depthUsd: card.depthUsd,
    slippagePp: card.slippagePp,
    spread: card.spread,
    freshnessMs: card.freshnessMs,
    confidence,
    settlementClarity,
    executableTier: card.executableTier ?? null,
    ...options,
  });
}
