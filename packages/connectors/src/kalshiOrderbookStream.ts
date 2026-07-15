import { WebSocket } from 'ws';
import { KALSHI_WS_URL, type KalshiOrderbook, type OrderbookLevel } from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';

export interface KalshiOrderbookStreamTelemetry {
  connected: boolean;
  trackedTickers: number;
  booksWithExchangeTime: number;
  reconnects: number;
  sequenceRegressions: number;
  lastMessageAt: number | null;
  lastExchangeTimestamp: number | null;
}

interface MutableBook {
  ticker: string;
  yes: Map<number, number>;
  no: Map<number, number>;
  sequence: number;
  sourceTimestamp?: number;
  receivedAt: number;
}

type HeaderProvider = () => Record<string, string> | null;

function parseNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseLevels(value: unknown): Map<number, number> {
  const levels = new Map<number, number>();
  if (!Array.isArray(value)) return levels;
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = parseNumber(row[0]);
    const quantity = parseNumber(row[1]);
    if (price == null || quantity == null || price <= 0 || price >= 1 || quantity <= 0) continue;
    levels.set(price, quantity);
  }
  return levels;
}

function sortedLevels(levels: Map<number, number>): OrderbookLevel[] {
  return [...levels.entries()]
    .map(([price, quantity]) => ({ price, quantity }))
    .sort((a, b) => b.price - a.price);
}

export class KalshiOrderbookStream {
  private readonly tickers = new Set<string>();
  private readonly subscribed = new Set<string>();
  private readonly books = new Map<string, MutableBook>();
  private socket: WebSocket | null = null;
  private started = false;
  private commandId = 1;
  private reconnectDelayMs = 1_000;
  private reconnects = 0;
  private sequenceRegressions = 0;
  private lastMessageAt: number | null = null;
  private lastExchangeTimestamp: number | null = null;

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly headers: HeaderProvider,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  restart(): void {
    this.socket?.close();
    this.socket = null;
    this.subscribed.clear();
    if (this.started) this.connect();
  }

  stop(): void {
    this.started = false;
    this.socket?.close();
    this.socket = null;
  }

  track(tickers: string[]): void {
    for (const ticker of tickers) if (ticker) this.tickers.add(ticker);
    this.subscribeMissing();
  }

  getBook(ticker: string): KalshiOrderbook | null {
    const book = this.books.get(ticker);
    if (!book) return null;
    const yes = sortedLevels(book.yes);
    const no = sortedLevels(book.no);
    const bestYesBid = yes[0]?.price;
    const bestNoBid = no[0]?.price;
    const yesAsk = bestNoBid == null ? undefined : 1 - bestNoBid;
    const noAsk = bestYesBid == null ? undefined : 1 - bestYesBid;
    return {
      ticker,
      yes,
      no,
      yesAsk,
      noAsk,
      spread: yesAsk != null && bestYesBid != null ? yesAsk - bestYesBid : undefined,
      sequence: book.sequence,
      sourceTimestamp: book.sourceTimestamp,
      receivedAt: book.receivedAt,
    };
  }

  telemetry(): KalshiOrderbookStreamTelemetry {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      trackedTickers: this.tickers.size,
      booksWithExchangeTime: [...this.books.values()].filter((book) => book.sourceTimestamp != null).length,
      reconnects: this.reconnects,
      sequenceRegressions: this.sequenceRegressions,
      lastMessageAt: this.lastMessageAt,
      lastExchangeTimestamp: this.lastExchangeTimestamp,
    };
  }

  private connect(): void {
    if (!this.started || this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    const headers = this.headers();
    if (!headers) {
      this.registry.recordWarn('kalshi-ws', 'credentials required for exchange-timestamped order books');
      return;
    }
    const socket = new WebSocket(KALSHI_WS_URL, { headers });
    this.socket = socket;
    socket.on('open', () => {
      this.reconnectDelayMs = 1_000;
      this.subscribed.clear();
      this.registry.recordSuccess('kalshi-ws', 0);
      this.subscribeMissing();
    });
    socket.on('message', (raw) => this.ingest(String(raw)));
    socket.on('error', () => socket.close());
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.subscribed.clear();
      if (!this.started) return;
      this.reconnects += 1;
      this.registry.recordWarn('kalshi-ws', 'order-book stream disconnected; reconnect scheduled');
      const waitMs = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
      setTimeout(() => this.connect(), waitMs);
    });
  }

  private subscribeMissing(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const missing = [...this.tickers].filter((ticker) => !this.subscribed.has(ticker));
    for (let index = 0; index < missing.length; index += 50) {
      const batch = missing.slice(index, index + 50);
      if (batch.length === 0) continue;
      this.socket.send(JSON.stringify({
        id: this.commandId++,
        cmd: 'subscribe',
        params: { channels: ['orderbook_delta'], market_tickers: batch },
      }));
      for (const ticker of batch) this.subscribed.add(ticker);
    }
  }

  /** Ingests one official WebSocket packet; public to support deterministic replay tests. */
  ingest(raw: string): void {
    this.lastMessageAt = Date.now();
    try {
      const packet = JSON.parse(raw) as Record<string, unknown>;
      const type = String(packet.type ?? '');
      const sequence = parseNumber(packet.seq);
      const msg = packet.msg && typeof packet.msg === 'object' ? packet.msg as Record<string, unknown> : null;
      if (!msg || sequence == null) {
        if (type === 'error') this.registry.recordWarn('kalshi-ws', String((msg as { msg?: unknown } | null)?.msg ?? 'subscription error'));
        return;
      }
      const ticker = String(msg.market_ticker ?? '');
      if (!ticker) return;
      if (type === 'orderbook_snapshot') this.applySnapshot(ticker, sequence, msg);
      else if (type === 'orderbook_delta') this.applyDelta(ticker, sequence, msg);
      else return;
      this.registry.recordSuccess('kalshi-ws', 0);
    } catch {
      this.registry.recordWarn('kalshi-ws', 'malformed order-book stream message');
    }
  }

  private applySnapshot(ticker: string, sequence: number, msg: Record<string, unknown>): void {
    const yes = parseLevels(msg.yes_dollars_fp ?? msg.yes_dollars ?? msg.yes);
    const no = parseLevels(msg.no_dollars_fp ?? msg.no_dollars ?? msg.no);
    this.books.set(ticker, { ticker, yes, no, sequence, receivedAt: Date.now() });
  }

  private applyDelta(ticker: string, sequence: number, msg: Record<string, unknown>): void {
    const book = this.books.get(ticker);
    if (!book) return;
    if (sequence <= book.sequence) {
      this.sequenceRegressions += 1;
      this.books.delete(ticker);
      return;
    }
    const side = msg.side === 'yes' || msg.side === 'no' ? msg.side : null;
    const price = parseNumber(msg.price_dollars ?? msg.price_dollars_fp ?? msg.price);
    const delta = parseNumber(msg.delta_fp ?? msg.delta);
    const timestamp = parseNumber(msg.ts_ms) ?? (typeof msg.ts === 'string' ? Date.parse(msg.ts) : undefined);
    if (!side || price == null || delta == null || timestamp == null || !Number.isFinite(timestamp)) return;
    const levels = book[side];
    const next = (levels.get(price) ?? 0) + delta;
    if (next <= 0) levels.delete(price);
    else levels.set(price, next);
    book.sequence = sequence;
    book.sourceTimestamp = timestamp;
    book.receivedAt = Date.now();
    this.lastExchangeTimestamp = timestamp;
  }
}
