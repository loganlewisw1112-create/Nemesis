import type { ExitRecommendation } from '@nemesis/bridge-contracts';
import type { KalshiTapeState } from '@nemesis/connectors';

export type ExitExecutionContext = Pick<
  ExitRecommendation,
  'executable_close_price' | 'book_timestamp' | 'book_depth' | 'price_source' | 'expires_at'
>;

function clampPrice(value: number): number {
  return Math.max(0.01, Math.min(0.99, value));
}

function parsedLevels(levelsJson: string): Array<{ price: number; quantity: number }> {
  try {
    const levels = JSON.parse(levelsJson) as Array<{ price?: unknown; quantity?: unknown }>;
    if (!Array.isArray(levels)) return [];
    return levels.flatMap((level) =>
      typeof level.price === 'number' && Number.isFinite(level.price)
      && typeof level.quantity === 'number' && Number.isFinite(level.quantity)
      && level.quantity > 0
        ? [{ price: level.price, quantity: level.quantity }]
        : []);
  } catch {
    return [];
  }
}

export function buildExitExecutionContext(
  tapeState: KalshiTapeState,
  ticker: string,
  side: 'yes' | 'no',
  issuedAt: number,
  ttlMs: number,
): ExitExecutionContext | null {
  const book = tapeState.latestOrderbooks.find((entry) => entry.ticker === ticker);
  if (book) {
    const levels = parsedLevels(side === 'yes' ? book.yes_levels_json : book.no_levels_json);
    const price = side === 'yes'
      ? book.best_yes_bid
      : levels.reduce<number | null>((best, level) => best == null || level.price > best ? level.price : best, null);
    const depth = levels.reduce((sum, level) => sum + level.quantity, 0);
    if (price != null && depth >= 1) {
      return {
        executable_close_price: clampPrice(price),
        book_timestamp: book.timestamp,
        book_depth: depth,
        price_source: 'kalshi-orderbook',
        expires_at: issuedAt + ttlMs,
      };
    }
  }

  const snapshot = tapeState.latestSnapshots.find((entry) => entry.ticker === ticker);
  const snapshotBid = side === 'yes' ? snapshot?.yes_bid : snapshot?.no_bid;
  if (snapshotBid != null && snapshot && snapshot.volume >= 1) {
    return {
      executable_close_price: clampPrice(snapshotBid),
      book_timestamp: snapshot.timestamp,
      book_depth: snapshot.volume,
      price_source: 'kalshi-snapshot',
      expires_at: issuedAt + ttlMs,
    };
  }

  return null;
}
