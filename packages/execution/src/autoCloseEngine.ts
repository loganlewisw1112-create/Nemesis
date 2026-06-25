import {
  DEFAULT_AUTO_CLOSE_SETTINGS,
  positionUnrealizedPnl,
  type AutoCloseDecision,
  type AutoCloseSettings,
  type AutoCloseState,
  type PaperPosition,
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
  score: number;
}

export interface UpdateAutoCloseStateInput {
  position: PaperPosition;
  mark: number;
  currentEdge: number;
  tickCount: number;
  now: number;
  prior?: AutoCloseState;
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

function decision(
  input: EvaluateAutoCloseInput,
  action: AutoCloseDecision['action'],
  contracts: number,
  confidence: number,
  reason: string,
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
  };

  const next: AutoCloseState = {
    ...base,
    tickCount: Math.max(base.tickCount, input.tickCount),
    lastMark: input.mark,
    lastEdge: input.currentEdge,
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
  const edgeCompressionRate = input.state.peakEdge > 0
    ? clamp((input.state.peakEdge - input.currentEdge) / input.state.peakEdge)
    : 0;
  const downsideToEntryUsd = Math.max(0, (input.position.entryPrice - input.mark) * input.position.contracts);
  const expectedRemainingUpsideUsd = Math.max(0, input.currentEdge) * input.position.contracts;
  const bookSlippageToCloseUsd = Math.max(0, input.slippagePp ?? 0) * input.position.contracts;
  const geaAction = input.exitSignal?.action ?? 'none';
  const geaScore = geaAction === 'exit' ? 1 : geaAction === 'trim' ? 0.65 : 0;

  return {
    expectedRemainingUpsideUsd: Number(expectedRemainingUpsideUsd.toFixed(4)),
    downsideToEntryUsd: Number(downsideToEntryUsd.toFixed(4)),
    edgeCompressionRate: Number(edgeCompressionRate.toFixed(6)),
    peakGivebackPct: Number(peakGiveback.toFixed(6)),
    geaRetentionAction: geaAction,
    bookSlippageToCloseUsd: Number(bookSlippageToCloseUsd.toFixed(4)),
    score: Number(clamp(
      peakGiveback * 0.35 +
        edgeCompressionRate * 0.3 +
        geaScore * 0.25 +
        clamp(downsideToEntryUsd / Math.max(1, costBasis(input.position))) * 0.1,
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
  const geaFresh = input.exitSignal
    ? input.now - input.exitSignal.issuedAt <= Math.max(settings.staleSignalMs, settings.maxBridgeLatencyMs)
    : false;

  if (
    input.exitSignal?.ticker === input.position.ticker &&
    geaFresh &&
    input.exitSignal.action === 'exit' &&
    input.exitSignal.confidence >= settings.geaExitConfidence
  ) {
    return decision(input, 'close', input.position.contracts, input.exitSignal.confidence, `GEA exit confirmed: ${input.exitSignal.reason}`);
  }

  if (input.currentEdge <= settings.emergencyEdgeExit) {
    return decision(input, 'close', input.position.contracts, 0.96, 'emergency close: edge gone');
  }

  if ((input.freshnessMs ?? 0) > settings.staleSignalMs) {
    return decision(input, 'close', input.position.contracts, 0.9, 'emergency close: signal stale');
  }

  if ((input.slippagePp ?? 0) >= settings.badLiquiditySlippagePp) {
    return decision(input, 'close', input.position.contracts, 0.86, 'emergency close: bad liquidity');
  }

  if (
    input.exitSignal?.ticker === input.position.ticker &&
    geaFresh &&
    input.exitSignal.action === 'trim' &&
    input.exitSignal.confidence >= settings.geaExitConfidence &&
    input.state.trimmedContracts === 0
  ) {
    const contracts = Math.max(1, Math.floor(input.position.contracts * settings.firstTrimFraction));
    return decision(input, 'trim', contracts, input.exitSignal.confidence, `GEA trim confirmed: ${input.exitSignal.reason}`);
  }

  if (
    input.state.peakPnlPct >= settings.finalCloseProfitPct &&
    giveback >= settings.finalCloseGivebackPct
  ) {
    return decision(input, 'close', input.position.contracts, 0.88, 'final close: peak profit giveback confirmed');
  }

  if (
    input.state.trimmedContracts === 0 &&
    input.state.peakPnlPct >= settings.firstTrimProfitPct &&
    giveback >= settings.firstTrimGivebackPct
  ) {
    const contracts = Math.max(1, Math.floor(input.position.contracts * settings.firstTrimFraction));
    return decision(input, 'trim', contracts, 0.78, 'auto-trimmed near peak after giveback');
  }

  return decision(input, 'hold', 0, 0.5, 'hold: retained edge remains positive');
}
