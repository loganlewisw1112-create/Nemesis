import type { AlphaScoreResult, BrainInputFeatures } from './types.js';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class AlphaScorer {
  static score(input: BrainInputFeatures): AlphaScoreResult {
    const edgeComponent = clamp01(input.net_edge / 0.1) * 34;
    const rawEdgeComponent = clamp01(input.raw_edge / 0.15) * 14;
    const confidenceComponent = clamp01(input.confidence) * 18;
    const liquidityComponent = clamp01(input.liquidity) * 12;
    const clarityComponent = clamp01(input.settlement_clarity) * 14;
    const freshnessComponent = clamp01(input.freshness) * 8;
    const penalty = clamp01(input.volatility_penalty ?? 0) * 2;
    const alpha_score = Math.max(0, Math.min(100, Math.round(
      edgeComponent
      + rawEdgeComponent
      + confidenceComponent
      + liquidityComponent
      + clarityComponent
      + freshnessComponent
      - penalty,
    )));

    if (alpha_score >= 92) return { alpha_score, classification: 'institutional-prime' };
    if (alpha_score >= 80) return { alpha_score, classification: 'elite' };
    if (alpha_score >= 68) return { alpha_score, classification: 'strong' };
    if (alpha_score >= 52) return { alpha_score, classification: 'watch-for-entry' };
    if (alpha_score >= 35) return { alpha_score, classification: 'paper-research' };
    return { alpha_score, classification: 'ignore' };
  }
}
