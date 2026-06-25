import { normalizeMarketPrice, type KalshiMarket, type KalshiOrderbook, type KalshiTrade, type OrderbookLevel } from '@nemesis/core';
import type { KalshiTickerQuote, KalshiStream } from './kalshiStream.js';

export type TapeRecordSource = 'rest-market' | 'ws-ticker';

export interface KalshiMarketSnapshotRecord {
  id: string;
  ticker: string;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_price: number;
  no_bid: number | null;
  no_ask: number | null;
  volume: number;
  spread: number | null;
  timestamp: number;
  source: TapeRecordSource;
}

export interface KalshiTradePrintRecord {
  id: string;
  ticker: string;
  yes_price: number;
  count: number;
  taker_side: 'yes' | 'no';
  created_time: string;
}

export interface KalshiOrderbookSnapshotRecord {
  id: string;
  ticker: string;
  yes_levels_json: string;
  no_levels_json: string;
  best_yes_bid: number | null;
  yes_ask: number | null;
  no_ask: number | null;
  spread: number | null;
  timestamp: number;
}

export interface KalshiTapeSink {
  insertMarketSnapshot(snapshot: KalshiMarketSnapshotRecord): void;
  insertTradePrint(trade: KalshiTradePrintRecord): void;
  insertOrderbookSnapshot(book: KalshiOrderbookSnapshotRecord): void;
}

export interface KalshiTapeState {
  snapshotCount: number;
  tradeCount: number;
  orderbookCount: number;
  trackedTickers: string[];
  latestSnapshots: KalshiMarketSnapshotRecord[];
  latestTrades: KalshiTradePrintRecord[];
  latestOrderbooks: KalshiOrderbookSnapshotRecord[];
  freshness: {
    kalshiTapeAgeMs: number | null;
    stale: boolean;
  };
}

export interface KalshiTapeEngineOptions {
  sink: KalshiTapeSink;
  stream?: KalshiStream;
  staleAfterMs?: number;
  retainRecords?: number;
}

type TapeListener = (state: KalshiTapeState) => void;

const DEFAULT_STALE_AFTER_MS = 15_000;
const DEFAULT_RETAIN_RECORDS = 250;

export function marketToTapeSnapshot(
  market: KalshiMarket,
  timestamp = Date.now(),
  source: TapeRecordSource = 'rest-market',
): KalshiMarketSnapshotRecord {
  const yesBid = priceFrom(market.yes_bid_dollars, market.yes_bid);
  const yesAsk = priceFrom(market.yes_ask_dollars, market.yes_ask);
  const noBid = priceFrom(market.no_bid_dollars, market.no_bid);
  const noAsk = priceFrom(market.no_ask_dollars, market.no_ask);
  const yesPrice = normalizeMarketPrice(market, 'yes');
  const spread = yesBid !== null && yesAsk !== null ? Math.max(0, yesAsk - yesBid) : null;

  return {
    id: `market-${market.ticker}-${timestamp}`,
    ticker: market.ticker,
    yes_bid: yesBid,
    yes_ask: yesAsk,
    yes_price: yesPrice,
    no_bid: noBid,
    no_ask: noAsk,
    volume: Number(market.volume_24h ?? market.volume ?? 0),
    spread,
    timestamp,
    source,
  };
}

export function quoteToTapeSnapshot(quote: KalshiTickerQuote): KalshiMarketSnapshotRecord {
  return {
    id: `quote-${quote.ticker}-${quote.updatedAt}`,
    ticker: quote.ticker,
    yes_bid: quote.yesBid,
    yes_ask: quote.yesAsk,
    yes_price: quote.yesPrice,
    no_bid: 1 - quote.yesAsk,
    no_ask: 1 - quote.yesBid,
    volume: quote.volume,
    spread: quote.spread,
    timestamp: quote.updatedAt,
    source: 'ws-ticker',
  };
}

export function tradeToTapePrint(trade: KalshiTrade): KalshiTradePrintRecord {
  return {
    id: trade.trade_id || `trade-${trade.ticker}-${trade.created_time}-${trade.count}`,
    ticker: trade.ticker,
    yes_price: toProbability(trade.yes_price),
    count: trade.count,
    taker_side: trade.taker_side,
    created_time: trade.created_time,
  };
}

export function orderbookToTapeSnapshot(
  book: KalshiOrderbook,
  timestamp = Date.now(),
): KalshiOrderbookSnapshotRecord {
  return {
    id: `book-${book.ticker}-${timestamp}`,
    ticker: book.ticker,
    yes_levels_json: JSON.stringify(normalizeLevels(book.yes)),
    no_levels_json: JSON.stringify(normalizeLevels(book.no)),
    best_yes_bid: book.yes[0]?.price ?? null,
    yes_ask: book.yesAsk ?? null,
    no_ask: book.noAsk ?? null,
    spread: book.spread ?? null,
    timestamp,
  };
}

export class KalshiTapeEngine {
  private latestSnapshots: KalshiMarketSnapshotRecord[] = [];
  private latestTrades: KalshiTradePrintRecord[] = [];
  private latestOrderbooks: KalshiOrderbookSnapshotRecord[] = [];
  private tickers = new Set<string>();
  private listeners = new Set<TapeListener>();
  private unsubscribeStream: (() => void) | null = null;
  private readonly staleAfterMs: number;
  private readonly retainRecords: number;

  constructor(private options: KalshiTapeEngineOptions) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.retainRecords = options.retainRecords ?? DEFAULT_RETAIN_RECORDS;
  }

  onUpdate(listener: TapeListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(tickers: string[] = []) {
    if (!this.options.stream || this.unsubscribeStream) return;
    if (tickers.length > 0) {
      this.track(tickers);
      this.options.stream.track(tickers);
    }
    this.unsubscribeStream = this.options.stream.onQuote((quote) => this.ingestQuote(quote));
    this.options.stream.start();
  }

  stop() {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.options.stream?.stop();
  }

  track(tickers: string[]) {
    for (const ticker of tickers) {
      if (ticker.trim()) this.tickers.add(ticker.trim());
    }
    this.options.stream?.track([...this.tickers]);
    this.emit();
  }

  ingestMarket(market: KalshiMarket, timestamp = Date.now()) {
    const snapshot = marketToTapeSnapshot(market, timestamp);
    this.writeSnapshot(snapshot);
  }

  ingestQuote(quote: KalshiTickerQuote) {
    this.writeSnapshot(quoteToTapeSnapshot(quote));
  }

  ingestTrade(trade: KalshiTrade) {
    const record = tradeToTapePrint(trade);
    this.tickers.add(record.ticker);
    this.options.sink.insertTradePrint(record);
    this.latestTrades = retain([record, ...this.latestTrades], this.retainRecords);
    this.emit();
  }

  ingestOrderbook(book: KalshiOrderbook, timestamp = Date.now()) {
    const record = orderbookToTapeSnapshot(book, timestamp);
    this.tickers.add(record.ticker);
    this.options.sink.insertOrderbookSnapshot(record);
    this.latestOrderbooks = retain([record, ...this.latestOrderbooks], this.retainRecords);
    this.emit();
  }

  getState(now = Date.now()): KalshiTapeState {
    const lastAt = this.latestSnapshots[0]?.timestamp ?? this.latestOrderbooks[0]?.timestamp ?? null;
    const kalshiTapeAgeMs = lastAt === null ? null : Math.max(0, now - lastAt);
    return {
      snapshotCount: this.latestSnapshots.length,
      tradeCount: this.latestTrades.length,
      orderbookCount: this.latestOrderbooks.length,
      trackedTickers: [...this.tickers].sort(),
      latestSnapshots: [...this.latestSnapshots],
      latestTrades: [...this.latestTrades],
      latestOrderbooks: [...this.latestOrderbooks],
      freshness: {
        kalshiTapeAgeMs,
        stale: kalshiTapeAgeMs === null || kalshiTapeAgeMs > this.staleAfterMs,
      },
    };
  }

  private writeSnapshot(snapshot: KalshiMarketSnapshotRecord) {
    this.tickers.add(snapshot.ticker);
    this.options.sink.insertMarketSnapshot(snapshot);
    this.latestSnapshots = retain([snapshot, ...this.latestSnapshots], this.retainRecords);
    this.emit();
  }

  private emit() {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

function priceFrom(dollars: string | undefined, cents: number | undefined): number | null {
  if (typeof dollars === 'string' && dollars.length > 0) {
    const n = Number.parseFloat(dollars);
    if (Number.isFinite(n)) return n;
  }
  if (typeof cents === 'number' && Number.isFinite(cents)) return toProbability(cents);
  return null;
}

function toProbability(value: number): number {
  return value > 1 ? value / 100 : value;
}

function normalizeLevels(levels: OrderbookLevel[]): OrderbookLevel[] {
  return levels.map((level) => ({
    price: toProbability(level.price),
    quantity: level.quantity,
  }));
}

function retain<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(0, limit) : items;
}
