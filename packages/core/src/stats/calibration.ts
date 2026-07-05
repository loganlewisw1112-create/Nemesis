/**
 * Turns a real-valued signal (e.g. forecast minus strike, or an economic
 * surprise) into a probability via a logistic curve, instead of collapsing
 * it into a fixed bucket. `scale` sets how large the signal needs to be
 * before the probability approaches 0 or 1 -- larger scale means more signal
 * is needed for the same confidence.
 */
export function sigmoidProbability(signal: number, scale: number): number {
  if (scale <= 0) return signal > 0 ? 1 : signal < 0 ? 0 : 0.5;
  return 1 / (1 + Math.exp(-signal / scale));
}

export function clampProbability(value: number, min = 0.02, max = 0.98): number {
  return Math.min(max, Math.max(min, value));
}
