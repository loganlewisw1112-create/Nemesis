import { DEFAULT_EXCHANGE_LATENCY_SETTINGS, emptyLatencyMetrics, type ExchangeLatencySettings, type LatencyMetrics } from '@nemesis/core';

export interface MeasureExchangeRoundTripInput<T> {
  send: () => Promise<T>;
  now?: () => number;
  fillConfirmedAt?: (result: T) => number | undefined;
}

export interface ExchangeRoundTripResult<T> {
  result: T;
  metrics: LatencyMetrics;
}

function defaultNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function createLatencyMetrics(overrides: Partial<LatencyMetrics> = {}): LatencyMetrics {
  return emptyLatencyMetrics(overrides);
}

export async function measureExchangeRoundTrip<T>(
  input: MeasureExchangeRoundTripInput<T>,
): Promise<ExchangeRoundTripResult<T>> {
  const now = input.now ?? defaultNow;
  const start = now();
  const result = await input.send();
  const ackAt = now();
  const fillAt = input.fillConfirmedAt?.(result) ?? (typeof (result as { fillConfirmedAt?: unknown }).fillConfirmedAt === 'number'
    ? (result as { fillConfirmedAt: number }).fillConfirmedAt
    : ackAt);
  const orderSubmitRttMs = Number(Math.max(0, ackAt - start).toFixed(4));
  const fillConfirmMs = Number(Math.max(orderSubmitRttMs, fillAt - start).toFixed(4));
  return {
    result,
    metrics: createLatencyMetrics({
      orderSubmitRttMs,
      orderAckMs: orderSubmitRttMs,
      fillConfirmMs,
      profitLockTotalMs: fillConfirmMs,
    }),
  };
}

export function isExchangePathAcceptable(
  metrics: LatencyMetrics,
  settings: Partial<ExchangeLatencySettings> = {},
): { ok: boolean; reason?: string } {
  const merged = { ...DEFAULT_EXCHANGE_LATENCY_SETTINGS, ...settings };
  if (metrics.orderSubmitRttMs > merged.maxSubmitRttMs) return { ok: false, reason: 'slow exchange path' };
  if (metrics.fillConfirmMs > merged.maxFillConfirmMs) return { ok: false, reason: 'slow fill confirmation' };
  return { ok: true };
}
