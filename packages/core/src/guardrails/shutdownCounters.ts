import type { ShutdownCounters } from './engine.js';

export function recordInvalidation(counters: ShutdownCounters): void {
  counters.consecutiveInvalidations += 1;
}

export function resetInvalidationStreak(counters: ShutdownCounters): void {
  counters.consecutiveInvalidations = 0;
}

export function recordAbnormalExecution(counters: ShutdownCounters): void {
  counters.abnormalExecutions += 1;
}

export function recordManualOverride(counters: ShutdownCounters): void {
  counters.manualOverrides += 1;
}

export function applyApiDegradedElapsed(
  counters: ShutdownCounters,
  degraded: boolean,
  elapsedMs: number,
): void {
  if (!degraded || elapsedMs <= 0) return;
  counters.apiDegradedMinutes += Math.floor(elapsedMs / 60_000);
}

export const RISK_SETTING_KEYS = [
  'maxPositionUsd',
  'dailyLossCapUsd',
  'maxSlippagePp',
  'cryptoLiveEnabled',
] as const satisfies readonly (keyof import('../types.js').GuardrailSettings)[];

export function isRiskSettingOverride(
  partial: Partial<import('../types.js').GuardrailSettings>,
): boolean {
  return RISK_SETTING_KEYS.some((key) => partial[key] !== undefined);
}
