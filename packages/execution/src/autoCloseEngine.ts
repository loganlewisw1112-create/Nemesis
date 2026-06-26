import {
  DEFAULT_AUTO_CLOSE_SETTINGS,
  positionUnrealizedPnl,
  type AutoCloseDecision,
  type AutoCloseSettings,
  type AutoCloseState,
  type PaperPosition,
  type PositionTier,
} from '@nemesis/core';

export { DEFAULT_AUTO_CLOSE_SETTINGS } from '@nemesis/core';

export interface AutoCloseExitSignal {
  ticker: string;
  action: 'hold' | 'trim' | 'exit' | 'add-only-on-pullback';
  confidence: number;
  currentEdge: number;
  capturedEdge: number;
  reason: string;
  issuedAt: number;
}

export interface ExitScore {
  expectedRemainingUpsideUsd: number;
  downsideToEntryUsd: number;
  edgeCompressionRate: number;
  peakGivebackPct: number;
  geaRetentionAction: AutoCloseExitSignal['action'] | 'none';
  bookSlippageToCloseUsd: number;
  adverseVelocity: number;
  profitBias: number;
  score: number;
}

export interface UpdateAutoCloseStateInput {
  position: PaperPosition;
  mark: number;
  currentEdge: number;
  tickCount: number;
  now: number;
  prior?: AutoCloseState;
  tier?: PositionTier;
}

export interface EvaluateAutoCloseInput extends UpdateAutoCloseStateInput {
  state: AutoCloseState;
  settings?: AutoCloseSettings;
  exitSignal?: AutoCloseExitSignal;
  freshnessMs?: number;
  slippagePp?: number;
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function costBasis(position: PaperPosition): number {
  return position.entryPrice * position.contracts + position.fees;
}

function currentPnl(position: PaperPosition, mark: number): { usd: number; pct: number } {
  const usd = positionUnrealizedPnl(position, mark);
  const basis = costBasis(position);
  return { usd, pct: basis > 0 ? usd / basis : 0 };
}

function givebackPct(currentPct: number, peakPct: number): number {
  if (peakPct <= 0) return 0;
  return clamp((peakPct - currentPct) / peakPct);
}

function edgeCompressionRate(state: AutoCloseState, currentEdge: number): number {
  return state.peakEdge > 0 ? clamp((state.peakEdge - currentEdge) / state.peakEdge) : 0;
}

function trimContracts(position: PaperPosition, fraction: number): number {
  return Math.max(1, Math.floor(position.contracts * fraction));
}

function tierFor(input: EvaluateAutoCloseInput): PositionTier {
  return input.tier ?? input.position.tier ?? input.state.tier ?? 'scalp';
}

function decision(
  input: EvaluateAutoCloseInput,
  action: AutoCloseDecision['action'],
  contracts: number,
  confidence: number,
  reason: string,
  exitScore?: number,
): AutoCloseDecision {
  const pnl = currentPnl(input.position, input.mark);
  return {
    id: `${input.position.id}:${action}:${input.now}`,
    positionId: input.position.id,
    ticker: input.position.ticker,
    action,
    contracts,
    confidence: clamp(confidence),
    reason,
    currentPnlUsd: Number(pnl.usd.toFixed(4)),
    currentPnlPct: Number(pnl.pct.toFixed(6)),
    peakPnlUsd: input.state.peakPnlUsd,
    peakPnlPct: input.state.peakPnlPct,
    currentEdge: input.currentEdge,
    peakEdge: input.state.peakEdge,
    givebackPct: Number(givebackPct(pnl.pct, input.state.peakPnlPct).toFixed(6)),
    triggeredAt: input.now,
    tier: tierFor(input),
    exitScore,
  };
}

export function updateAutoCloseState(input: UpdateAutoCloseStateInput): AutoCloseState {
  const pnl = currentPnl(input.position, input.mark);
  const prior = input.prior;
  const base: AutoCloseState = prior ?? {
    positionId: input.position.id,
    peakPnlUsd: pnl.usd,
    peakPnlPct: pnl.pct,
    peakEdge: input.currentEdge,
    peakMark: input.mark,
    peakAt: input.now,
    tickCount: input.tickCount,
    trimmedContracts: 0,
    lastDecisionAt: 0,
    lastMark: input.mark,
    lastEdge: input.currentEdge,
    markVelocityPct: 0,
    edgeVelocityPct: 0,
    consecutiveDownTicks: 0,
    earlyTrimContracts: 0,
    tier: input.tier ?? input.position.tier ?? 'scalp',
  };

  const direction = input.position.side === 'yes' ? 1 : -1;
  const markDelta = base.lastMark > 0 ? ((input.mark - base.lastMark) / base.lastMark) * direction : 0;
  const edgeDelta = Math.abs(base.lastEdge) > 0 ? (input.currentEdge - base.lastEdge) / Math.abs(base.lastEdge) : 0;
  const consecutiveDownTicks = markDelta < 0 ? (base.consecutiveDownTicks ?? 0) + 1 : 0;

  const next: AutoCloseState = {
    ...base,
    tickCount: Math.max(base.tickCount, input.tickCount),
    lastMark: input.mark,
    lastEdge: input.currentEdge,
    markVelocityPct: Number(markDelta.toFixed(6)),
    edgeVelocityPct: Number(edgeDelta.toFixed(6)),
    consecutiveDownTicks,
    earlyTrimContracts: base.earlyTrimContracts ?? 0,
    tier: input.tier ?? input.position.tier ?? base.tier ?? 'scalp',
  };

  if (pnl.usd > base.peakPnlUsd || pnl.pct > base.peakPnlPct) {
    next.peakPnlUsd = Number(pnl.usd.toFixed(4));
    next.peakPnlPct = Number(pnl.pct.toFixed(6));
    next.peakMark = input.mark;
    next.peakAt = input.now;
  }

  if (input.currentEdge > base.peakEdge) {
    next.peakEdge = input.currentEdge;
  }

  return next;
}

export function computeExitScore(input: EvaluateAutoCloseInput): ExitScore {
  const pnl = currentPnl(input.position, input.mark);
  const peakGiveback = givebackPct(pnl.pct, input.state.peakPnlPct);
  const edgeCompression = edgeCompressionRate(input.state, input.currentEdge);
  const downsideToEntryUsd = Math.max(0, (input.position.entryPrice - input.mark) * input.position.contracts);
  const expectedRemainingUpsideUsd = Math.max(0, input.currentEdge) * input.position.contracts;
  const bookSlippageToCloseUsd = Math.max(0, input.slippagePp ?? 0) * input.position.contracts;
  const geaAction = input.exitSignal?.action ?? 'none';
  const geaScore = geaAction === 'exit' ? 1 : geaAction === 'trim' ? 0.65 : 0;
  const adverseVelocity = clamp(Math.max(0, -(input.state.markVelocityPct ?? 0)) * 10);
  const profitBias = pnl.usd > 0 ? clamp(pnl.pct * 3) : 0;
  const downsideRisk = clamp(downsideToEntryUsd / Math.max(1, costBasis(input.position)));

  return {
    expectedRemainingUpsideUsd: Number(expectedRemainingUpsideUsd.toFixed(4)),
    downsideToEntryUsd: Number(downsideToEntryUsd.toFixed(4)),
    edgeCompressionRate: Number(edgeCompression.toFixed(6)),
    peakGivebackPct: Number(peakGiveback.toFixed(6)),
    geaRetentionAction: geaAction,
    bookSlippageToCloseUsd: Number(bookSlippageToCloseUsd.toFixed(4)),
    adverseVelocity: Number(adverseVelocity.toFixed(6)),
    profitBias: Number(profitBias.toFixed(6)),
    score: Number(clamp(
      peakGiveback * 0.25 +
        edgeCompression * 0.2 +
        geaScore * 0.2 +
        downsideRisk * 0.1 +
        adverseVelocity * 0.15 +
        profitBias * 0.1,
    ).toFixed(6)),
  };
}

export function evaluateAutoClosePosition(input: EvaluateAutoCloseInput): AutoCloseDecision {
  const settings = input.settings ?? DEFAULT_AUTO_CLOSE_SETTINGS;
  const ageMs = input.now - input.position.openedAt;
  const tickCount = Math.max(input.tickCount, input.state.tickCount);

  if (!settings.enabled) {
    return decision(input, 'hold', 0, 0.2, 'auto-close disabled');
  }

  if (ageMs < settings.minAgeMs || tickCount < settings.minTicks) {
    return decision(input, 'hold', 0, 0.35, 'warming up: waiting for minimum age and tick count');
  }

  const pnl = currentPnl(input.position, input.mark);
  const giveback = givebackPct(pnl.pct, input.state.peakPnlPct);
  const compression = edgeCompressionRate(input.state, input.currentEdge);
  const exitScore = computeExitScore(input);
  const dynamicCloseThreshold = settings.profitBiasEnabled
    ? (pnl.usd > 0
      ? Math.max(0.4, settings.exitScoreCloseThreshold - pnl.pct * 2)
      : settings.exitScoreCloseThreshold + 0.2)
    : settings.exitScoreCloseThreshold;
  const geaFresh = input.exitSignal
    ? input.now - input.exitSignal.issuedAt <= Math.max(settings.staleSignalMs, settings.maxBridgeLatencyMs)
    : false;

  if (
    settings.quickProfitExitEnabled &&
    input.state.trimmedContracts === 0 &&
    pnl.usd > 0 && (pnl.pct >= settings.quickProfitPct || input.state.peakPnlPct >= settings.quickProfitPct) &&
    compression >= settings.quickProfitEdgeCompressionTrigger
  ) {
    return decision(input, 'trim', trimContracts(input.position, settings.quickProfitTrimFraction), 0.72, 'quick-profit trim: profit positive and edge compressing', exitScore.score);
  }

  if (
    input.exitSignal?.ticker === input.position.ticker &&
    geaFresh &&
    input.exitSignal.action === 'exit' &&
    input.exitSignal.confidence >= settings.geaExitConfidence
  ) {
    return decision(input, 'close', input.position.contracts, input.exitSignal.confidence, `GEA exit confirmed: ${input.exitSignal.reason}`, exitScore.score);
  }

  if ((input.state.trimmedContracts > 0 || exitScore.score >= 0.9) && exitScore.score >= dynamicCloseThreshold) {
    return decision(input, 'close', input.position.contracts, exitScore.score, 'score close: continuous exit score crossed dynamic threshold', exitScore.score);
  }

  if (
    (input.state.consecutiveDownTicks ?? 0) >= settings.velocityDownTicksToTrim &&
    pnl.usd > 0 &&
    (input.state.earlyTrimContracts ?? 0) === 0
  ) {
    return decision(input, 'trim', trimContracts(input.position, 0.5), 0.8, 'velocity trim: profitable position moving against us', exitScore.score);
  }

  if (input.currentEdge <= settings.emergencyEdgeExit) {
    return decision(input, 'close', input.position.contracts, 0.96, 'emergency close: edge gone', exitScore.score);
  }

  if ((input.freshnessMs ?? 0) > settings.staleSignalMs) {
    return decision(input, 'close', input.position.contracts, 0.9, 'emergency close: signal stale', exitScore.score);
  }

  if ((input.slippagePp ?? 0) >= settings.badLiquiditySlippagePp) {
    return decision(input, 'close', input.position.contracts, 0.86, 'emergency close: bad liquidity', exitScore.score);
  }

  if (
    input.exitSignal?.ticker === input.position.ticker &&
    geaFresh &&
    input.exitSignal.action === 'trim' &&
    input.exitSignal.confidence >= settings.geaExitConfidence &&
    input.state.trimmedContracts === 0
  ) {
    return decision(input, 'trim', trimContracts(input.position, settings.firstTrimFraction), input.exitSignal.confidence, `GEA trim confirmed: ${input.exitSignal.reason}`, exitScore.score);
  }

  if (exitScore.score >= settings.exitScoreTrimThreshold && input.state.trimmedContracts === 0) {
    return decision(input, 'trim', trimContracts(input.position, settings.firstTrimFraction), exitScore.score * 0.85, 'score trim: continuous exit score crossed trim threshold', exitScore.score);
  }

  if (settings.predictiveCrossingEnabled && (input.state.markVelocityPct ?? 0) < 0 && input.state.trimmedContracts === 0) {
    const predictedMark = input.mark * (1 + (input.state.markVelocityPct ?? 0));
    const predictedPnl = currentPnl(input.position, predictedMark);
    const predictedGiveback = givebackPct(predictedPnl.pct, input.state.peakPnlPct);
    const leadThreshold = settings.firstTrimGivebackPct * (1 - settings.predictiveCrossingLeadPct);
    if (predictedGiveback >= leadThreshold) {
      return decision(input, 'trim', trimContracts(input.position, settings.firstTrimFraction), 0.76, 'predictive trim: threshold crossing imminent', exitScore.score);
    }
  }

  if (
    input.state.trimmedContracts > 0 &&
    input.state.peakPnlPct >= settings.finalCloseProfitPct &&
    giveback >= settings.finalCloseGivebackPct
  ) {
    return decision(input, 'close', input.position.contracts, 0.88, 'final close: peak profit giveback confirmed', exitScore.score);
  }

  if (
    input.state.trimmedContracts === 0 &&
    input.state.peakPnlPct >= settings.firstTrimProfitPct &&
    giveback >= settings.firstTrimGivebackPct
  ) {
    return decision(input, 'trim', trimContracts(input.position, settings.firstTrimFraction), 0.78, 'auto-trimmed near peak after giveback', exitScore.score);
  }

  return decision(input, 'hold', 0, 0.5, 'hold: retained edge remains positive', exitScore.score);
}
