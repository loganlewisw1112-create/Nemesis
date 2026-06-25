import type { ThesisCard, ThesisStatus } from '../types.js';
import { computeNetEdge } from '../fees/kalshiFee.js';

export interface QualificationInput {
  impliedPrice: number;
  marketPrice: number;
  spread: number;
  depthUsd: number;
  predictability: number;
  freshnessMs: number;
  sourceAgreement: number;
  regimeBlocked: boolean;
  concentrationBlocked: boolean;
  executionHealthy: boolean;
  minNetEdge?: number;
  minPredictability?: number;
  maxFreshnessMs?: number;
  minDepthUsd?: number;
}

export interface QualificationResult {
  status: ThesisStatus;
  passedGates: string[];
  failedGates: string[];
  breakdown: ReturnType<typeof computeNetEdge>;
}

export function qualifyThesis(input: QualificationInput): QualificationResult {
  const breakdown = computeNetEdge(input.impliedPrice, input.marketPrice, input.spread);
  const passed: string[] = [];
  const failed: string[] = [];
  const minNet = input.minNetEdge ?? 0.02;
  const minPred = input.minPredictability ?? 50;
  const maxFresh = input.maxFreshnessMs ?? 120_000;
  const minDepth = input.minDepthUsd ?? 50;

  const checks: [string, boolean][] = [
    ['netEdge', breakdown.netEdge >= minNet],
    ['liquidity', input.depthUsd >= minDepth],
    ['freshness', input.freshnessMs <= maxFresh],
    ['confidence', input.predictability >= minPred],
    ['agreement', input.sourceAgreement >= 0.6],
    ['regime', !input.regimeBlocked],
    ['concentration', !input.concentrationBlocked],
    ['executionHealth', input.executionHealthy],
  ];

  for (const [gate, ok] of checks) {
    (ok ? passed : failed).push(gate);
  }

  let status: ThesisStatus = 'observe';
  if (failed.includes('freshness')) status = 'stale';
  else if (failed.includes('agreement')) status = 'uncertain';
  else if (failed.includes('regime') || failed.includes('concentration') || failed.includes('executionHealth'))
    status = 'blocked';
  else if (failed.length === 0) status = 'tradeable';
  else if (passed.includes('netEdge') && passed.includes('liquidity')) status = 'qualified';
  else status = 'watch-only';

  return { status, passedGates: passed, failedGates: failed, breakdown };
}

export function rankTheses(cards: ThesisCard[]): ThesisCard[] {
  return [...cards].sort((a, b) => {
    const statusOrder: Record<ThesisStatus, number> = {
      tradeable: 0,
      qualified: 1,
      'watch-only': 2,
      observe: 3,
      uncertain: 4,
      stale: 5,
      blocked: 6,
      'de-risk': 7,
      closed: 8,
      review: 9,
    };
    const sd = statusOrder[a.status] - statusOrder[b.status];
    if (sd !== 0) return sd;
    return b.netEdge - a.netEdge;
  });
}

export function decayConfidence(
  predictability: number,
  freshnessMs: number,
  maxFreshnessMs: number,
  spreadWidened: boolean,
): number {
  const ageFactor = Math.max(0, 1 - freshnessMs / maxFreshnessMs);
  let score = predictability * (1 - ageFactor * 0.5);
  if (spreadWidened) score *= 0.7;
  return Math.round(Math.max(0, Math.min(100, score)));
}

export function detectSourceDisagreement(
  sources: { value: number; weight?: number }[],
  tolerance: number,
): { agreement: number; disagree: boolean } {
  if (sources.length < 2) return { agreement: 1, disagree: false };
  const values = sources.map((s) => s.value);
  const spread = Math.max(...values) - Math.min(...values);
  const agreement = Math.max(0, 1 - spread / tolerance);
  return { agreement, disagree: spread > tolerance };
}
