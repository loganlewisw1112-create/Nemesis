import {
  qualifyThesis,
  type ThesisCard,
  type ThesisStatus,
} from '@nemesis/core';

const QUALIFICATION_GATE_INVALIDATIONS = new Set([
  'netEdge',
  'liquidity',
  'freshness',
  'confidence',
  'agreement',
  'regime',
  'concentration',
  'executionHealth',
]);

function statusForRetainedInvalidations(
  status: ThesisStatus,
  invalidations: readonly string[],
): ThesisStatus {
  if (invalidations.some((reason) => reason === 'source-conflict' || reason.startsWith('crypto-'))) {
    return 'uncertain';
  }
  return status;
}

export function requalifyThesisCard(
  card: ThesisCard,
  options: {
    depthUsd?: number;
    reviewOnly?: boolean;
    demoMode?: boolean;
    executionHealthy?: boolean;
  } = {},
): ThesisCard {
  const retainedInvalidations = card.invalidations.filter((reason) => !QUALIFICATION_GATE_INVALIDATIONS.has(reason));
  const qual = qualifyThesis({
    impliedPrice: card.impliedPrice,
    marketPrice: card.marketPrice,
    spread: card.spread,
    depthUsd: options.depthUsd ?? card.depthUsd,
    predictability: card.predictability,
    freshnessMs: card.freshnessMs,
    sourceAgreement: retainedInvalidations.includes('source-conflict') ? 0 : 1,
    regimeBlocked: false,
    concentrationBlocked: false,
    executionHealthy: options.executionHealthy ?? true,
  });
  const status = options.reviewOnly && !options.demoMode
    ? 'observe'
    : statusForRetainedInvalidations(qual.status, retainedInvalidations);

  return {
    ...card,
    status,
    depthUsd: options.depthUsd ?? card.depthUsd,
    grossEdge: qual.breakdown.grossEdge,
    netEdge: qual.breakdown.netEdge,
    feeEstimate: qual.breakdown.feeCost,
    invalidations: [...qual.failedGates, ...retainedInvalidations],
  };
}
