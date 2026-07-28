import type { KalshiMarket } from '@nemesis/core';

/**
 * The single definition of "this contract can still be traded".
 *
 * There used to be two. `discoveryOrchestrator` admitted a market on status
 * alone (`active`/`open`), while `productionMarketProvenance.isActiveAt`
 * additionally required `close_time` to be in the future. Kalshi keeps
 * reporting a contract as `active` after it closes and before it settles, so
 * the two disagreed on exactly that population: discovery put closed contracts
 * into the universe, they generated thesis cards, entered the entry pipeline,
 * and could never earn provenance.
 *
 * Measured 2026-07-28 07:43Z: all 8 candidate tickers were closed contracts,
 * three of them 4-7 hours stale, and the funnel produced zero entry
 * confirmations while the socket was healthy. Daytime it looked like a 31-46%
 * hydration failure; overnight, as live contracts thinned out, it became 100%.
 *
 * A market with no `close_time` is still tradable — that is the pre-existing
 * provenance behavior and is preserved deliberately, since the field is
 * optional on `KalshiMarket` and absence must not silently delete a universe.
 */
export function isTradableMarketAt(market: KalshiMarket, now: number): boolean {
  const status = market.status?.trim().toLowerCase();
  if (status !== 'active' && status !== 'open') return false;
  if (!market.close_time) return true;
  const closeAt = Date.parse(market.close_time);
  // A present-but-unparseable close time is rejected, matching the provenance
  // gate this replaces. Fail closed: we cannot prove the contract is still open,
  // so we do not trade it.
  return Number.isFinite(closeAt) && closeAt > now;
}
