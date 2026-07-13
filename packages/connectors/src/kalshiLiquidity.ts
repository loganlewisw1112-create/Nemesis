import {
  isExecutablePrice,
  normalizeExecutablePrice,
  type KalshiMarket,
  type KalshiOrderbook,
  type KalshiTrade,
} from '@nemesis/core';

export interface KalshiTapeTickerSelectionOptions {
  trackLimit?: number;
  orderbookLimit?: number;
  minTradeNotionalUsd?: number;
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function marketLiquidityScore(market: KalshiMarket): number {
  const recentVolume = finiteNonNegative(market.volume_24h);
  const totalVolume = finiteNonNegative(market.volume);
  return recentVolume > 0 ? recentVolume : totalVolume;
}

export function hasExecutableMarketQuote(market: KalshiMarket): boolean {
  return normalizeExecutablePrice(market, 'yes') !== null
    || normalizeExecutablePrice(market, 'no') !== null;
}

/** Cheap REST pre-filter; a fetched orderbook still has to pass the strict depth gate. */
export function selectExecutableMarkets(markets: KalshiMarket[]): KalshiMarket[] {
  return [...markets]
    .filter((market) => marketLiquidityScore(market) > 0 && hasExecutableMarketQuote(market))
    .sort((a, b) => {
      const volumeDelta = marketLiquidityScore(b) - marketLiquidityScore(a);
      if (volumeDelta !== 0) return volumeDelta;
      const interestDelta = finiteNonNegative(b.open_interest) - finiteNonNegative(a.open_interest);
      if (interestDelta !== 0) return interestDelta;
      return a.ticker.localeCompare(b.ticker);
    });
}

export function tradeNotionalUsd(trade: KalshiTrade): number {
  const priceCents = trade.taker_side === 'no' ? trade.no_price : trade.yes_price;
  if (!Number.isFinite(priceCents) || !Number.isFinite(trade.count) || trade.count <= 0) return 0;
  return trade.count * priceCents / 100;
}

export function selectKalshiTapeTickers(
  markets: KalshiMarket[],
  trades: KalshiTrade[],
  options: KalshiTapeTickerSelectionOptions = {},
): { trackedTickers: string[]; orderbookTickers: string[] } {
  const trackLimit = positiveInteger(options.trackLimit, 12);
  const orderbookLimit = positiveInteger(options.orderbookLimit, 6);
  const minTradeNotionalUsd = finiteNonNegative(options.minTradeNotionalUsd) || 50;
  const liquidTickers = selectExecutableMarkets(markets).map((market) => market.ticker);
  const tradeScores = new Map<string, { notional: number; firstSeen: number }>();

  trades.forEach((trade, index) => {
    const notional = tradeNotionalUsd(trade);
    if (notional < minTradeNotionalUsd) return;
    const current = tradeScores.get(trade.ticker);
    if (!current) {
      tradeScores.set(trade.ticker, { notional, firstSeen: index });
    } else if (notional > current.notional) {
      current.notional = notional;
    }
  });

  const tradeTickers = [...tradeScores.entries()]
    .sort((a, b) => b[1].notional - a[1].notional || a[1].firstSeen - b[1].firstSeen)
    .map(([ticker]) => ticker);
  const prioritized = unique([...tradeTickers, ...liquidTickers]);

  return {
    trackedTickers: prioritized.slice(0, Math.max(trackLimit, orderbookLimit)),
    orderbookTickers: prioritized.slice(0, orderbookLimit),
  };
}

export function hasExecutableOrderbook(book: KalshiOrderbook): boolean {
  return [...book.yes, ...book.no].some(
    (level) => isExecutablePrice(level.price) && Number.isFinite(level.quantity) && level.quantity > 0,
  );
}
