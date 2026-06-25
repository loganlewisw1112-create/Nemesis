import { KALSHI_WS_URL } from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';

const WS_OPEN = 1;

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

function createWebSocket(url: string): WsLike | null {
  if (typeof WebSocket !== 'undefined') {
    return new WebSocket(url) as unknown as WsLike;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WS = require('ws') as { default: new (url: string) => import('ws').WebSocket };
    const raw = new WS.default(url);
    const bridge: WsLike = {
      readyState: raw.readyState,
      send: (data) => raw.send(data),
      close: () => raw.close(),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    raw.on('open', () => bridge.onopen?.());
    raw.on('message', (data: unknown) => bridge.onmessage?.({ data: String(data) }));
    raw.on('close', () => bridge.onclose?.());
    raw.on('error', () => bridge.onerror?.());
    Object.defineProperty(bridge, 'readyState', { get: () => raw.readyState });
    return bridge;
  } catch {
    return null;
  }
}

export interface KalshiTickerQuote {
  ticker: string;
  yesBid: number;
  yesAsk: number;
  yesPrice: number;
  spread: number;
  volume: number;
  updatedAt: number;
}

type QuoteListener = (quote: KalshiTickerQuote) => void;

export class KalshiStream {
  private quotes = new Map<string, KalshiTickerQuote>();
  private tickers = new Set<string>();
  private ws: WsLike | null = null;
  private cmdId = 1;
  private reconnectMs = 1000;
  private started = false;
  private listeners = new Set<QuoteListener>();

  constructor(private registry: ConnectorRegistry) {}

  onQuote(listener: QuoteListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getQuote(ticker: string): KalshiTickerQuote | undefined {
    return this.quotes.get(ticker);
  }

  track(tickers: string[]) {
    for (const t of tickers) this.tickers.add(t);
    if (this.started && this.ws?.readyState === WS_OPEN) {
      this.subscribe([...this.tickers]);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop() {
    this.started = false;
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    const ws = createWebSocket(KALSHI_WS_URL);
    if (!ws) {
      this.registry.recordWarn('kalshi-ws', 'WebSocket unavailable — using REST health only');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectMs = 1000;
      this.registry.recordSuccess('kalshi-ws', 0);
      if (this.tickers.size > 0) {
        this.subscribe([...this.tickers]);
      } else {
        ws.send(JSON.stringify({
          id: this.cmdId++,
          cmd: 'subscribe',
          params: { channels: ['ticker'] },
        }));
      }
    };

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as Record<string, unknown>;
        const type = String(data.type ?? '');
        if (type === 'ticker' && data.msg && typeof data.msg === 'object') {
          this.handleTicker(data.msg as Record<string, unknown>);
        } else if (type === 'subscribed') {
          this.registry.recordSuccess('kalshi-ws', 0);
        } else if (type === 'error') {
          this.registry.recordWarn('kalshi-ws', String((data.msg as { msg?: string })?.msg ?? 'subscription error'));
        }
      } catch {
        /* ignore malformed */
      }
    };

    ws.onclose = () => {
      if (!this.started) return;
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    };

    ws.onerror = () => ws.close();
  }

  private subscribe(tickers: string[]) {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    const batch = tickers.slice(0, 50);
    this.ws.send(JSON.stringify({
      id: this.cmdId++,
      cmd: 'subscribe',
      params: {
        channels: ['ticker'],
        market_tickers: batch,
      },
    }));
  }

  private handleTicker(msg: Record<string, unknown>) {
    const ticker = String(msg.market_ticker ?? msg.ticker ?? '');
    if (!ticker) return;

    const yesBid = parsePrice(msg.yes_bid_dollars, msg.yes_bid);
    const yesAsk = parsePrice(msg.yes_ask_dollars, msg.yes_ask);
    if (yesBid === undefined && yesAsk === undefined) return;

    const bid = yesBid ?? yesAsk ?? 0.5;
    const ask = yesAsk ?? yesBid ?? bid;
    const yesPrice = (bid + ask) / 2;
    const spread = Math.max(0.005, ask - bid);
    const volume = Number(msg.volume ?? msg.volume_24h ?? 0);

    const quote: KalshiTickerQuote = {
      ticker,
      yesBid: bid,
      yesAsk: ask,
      yesPrice,
      spread,
      volume,
      updatedAt: Date.now(),
    };
    this.quotes.set(ticker, quote);
    this.registry.recordSuccess('kalshi-ws', 0);
    for (const fn of this.listeners) fn(quote);
  }
}

function parsePrice(dollars: unknown, cents: unknown): number | undefined {
  if (typeof dollars === 'string' && dollars.length > 0) {
    const n = parseFloat(dollars);
    if (Number.isFinite(n)) return n;
  }
  if (typeof dollars === 'number' && Number.isFinite(dollars)) return dollars;
  if (typeof cents === 'number' && Number.isFinite(cents)) return cents / 100;
  return undefined;
}
