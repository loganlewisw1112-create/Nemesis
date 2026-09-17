export interface OrderbookTrackingRotationInput {
  critical: readonly string[];
  desired: readonly string[];
  current: readonly string[];
  now: number;
  lastRotationAt: number;
  cursor: number;
  limit: number;
  rotationIntervalMs: number;
  rotationBatchSize: number;
}

export interface OrderbookTrackingRotationResult {
  tickers: string[];
  lastRotationAt: number;
  cursor: number;
  rotated: boolean;
}

/**
 * Empty-desired HOLD was added so a temporary provenance TTL lapse would not
 * unsubscribe a live book mid-hold. Under a thin series allowlist the stream
 * can already be empty (selectVerified dropped everyone) while main still
 * lists stale names — HOLD then self-latches because reverify cannot heal an
 * empty stream membership. Only hold when both sides still show membership.
 */
export function shouldHoldEmptyDesiredOrderbook(input: {
  localTrackedCount: number;
  streamTrackedCount: number;
}): boolean {
  return input.localTrackedCount > 0 && input.streamTrackedCount > 0;
}

/**
 * When a series allowlist is configured, force-fill the desired track set with
 * every currently open executable on-series ticker from discovery (N may be
 * ≪ the WS limit). Preserves existing desired priority order, then appends any
 * missing allowlisted executables. Never pads with off-series names.
 */
export function mergeAllowlistForceFillDesired(input: {
  seriesAllowlistConfigured: boolean;
  desired: readonly string[];
  allowlistedExecutableTickers: readonly string[];
}): string[] {
  if (!input.seriesAllowlistConfigured) return [...input.desired];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (ticker: string | undefined) => {
    if (!ticker || seen.has(ticker)) return;
    seen.add(ticker);
    ordered.push(ticker);
  };
  for (const ticker of input.desired) add(ticker);
  for (const ticker of input.allowlistedExecutableTickers) add(ticker);
  return ordered;
}

/** Keeps live books sticky while allowing campaign-critical tickers in immediately. */
export function selectBoundedOrderbookTracking(
  input: OrderbookTrackingRotationInput,
): OrderbookTrackingRotationResult {
  const critical = [...new Set(input.critical.filter(Boolean))].slice(0, input.limit);
  const criticalSet = new Set(critical);
  const next: string[] = [];
  const seen = new Set<string>();
  const add = (ticker: string) => {
    if (!ticker || seen.has(ticker) || next.length >= input.limit) return;
    seen.add(ticker);
    next.push(ticker);
  };
  for (const ticker of critical) add(ticker);
  for (const ticker of input.current) add(ticker);
  for (const ticker of input.desired) add(ticker);

  let lastRotationAt = input.lastRotationAt === 0 && next.length > 0 ? input.now : input.lastRotationAt;
  let cursor = input.cursor;
  let rotated = false;
  if (input.now - lastRotationAt >= input.rotationIntervalMs) {
    const alternatives = [...new Set(input.desired.filter((ticker) => ticker && !seen.has(ticker)))];
    const replaceable = next.filter((ticker) => !criticalSet.has(ticker));
    const replaceCount = Math.min(input.rotationBatchSize, alternatives.length, replaceable.length);
    if (replaceCount > 0) {
      const selected: string[] = [];
      for (let offset = 0; offset < replaceCount; offset += 1) {
        selected.push(alternatives[(cursor + offset) % alternatives.length]!);
      }
      cursor = (cursor + replaceCount) % Math.max(1, alternatives.length);
      const retained = replaceable.slice(0, replaceable.length - replaceCount);
      next.length = 0;
      seen.clear();
      for (const ticker of critical) add(ticker);
      for (const ticker of retained) add(ticker);
      for (const ticker of selected) add(ticker);
      rotated = true;
    }
    lastRotationAt = input.now;
  }
  return { tickers: next, lastRotationAt, cursor, rotated };
}
