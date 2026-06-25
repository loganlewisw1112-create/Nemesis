import type { ConnectorRegistry } from './registry.js';

const REST_URL = 'https://data-api.binance.vision/api/v3/ticker/bookTicker';

export interface BinanceQuote {
  symbol: string;
  price: number;
  lagMs: number;
  fetchedAt: number;
}

export class BinanceStream {
  private quotes = new Map<string, BinanceQuote>();
  private ws: WebSocket | null = null;
  private symbols = new Set<string>(['BTCUSDT']);
  private reconnectMs = 1000;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private registry: ConnectorRegistry) {}

  getQuote(symbol: string): BinanceQuote | undefined {
    return this.quotes.get(symbol.toUpperCase());
  }

  track(symbol: string) {
    const s = symbol.toUpperCase();
    if (this.symbols.has(s)) return;
    this.symbols.add(s);
    if (this.started) this.reconnect();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
    this.pollTimer = setInterval(() => void this.restPoll(), 5_000);
  }

  stop() {
    this.started = false;
    this.ws?.close();
    this.ws = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private reconnect() {
    this.ws?.close();
    this.ws = null;
    if (this.started) setTimeout(() => this.connect(), 300);
  }

  private wsUrl(): string {
    const streams = [...this.symbols].map((s) => `${s.toLowerCase()}@bookTicker`);
    if (streams.length === 1) {
      return `wss://data-stream.binance.vision/ws/${streams[0]}`;
    }
    return `wss://data-stream.binance.vision/stream?streams=${streams.join('/')}`;
  }

  private connect() {
    if (typeof WebSocket === 'undefined' || this.symbols.size === 0) return;

    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectMs = 1000;
      this.registry.recordSuccess('binance-ws', 0);
    };

    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(String(ev.data)) as {
          data?: { s?: string; b?: string; a?: string };
          s?: string;
          b?: string;
          a?: string;
        };
        const data = raw.data ?? raw;
        const symbol = data.s;
        const bid = parseFloat(data.b ?? '');
        const ask = parseFloat(data.a ?? '');
        if (!symbol || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
        this.quotes.set(symbol, {
          symbol,
          price: (bid + ask) / 2,
          lagMs: 0,
          fetchedAt: Date.now(),
        });
        this.registry.recordSuccess('binance-ws', 0);
      } catch {
        /* ignore malformed tick */
      }
    };

    ws.onclose = () => {
      if (!this.started) return;
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    };

    ws.onerror = () => ws.close();
  }

  private async restPoll() {
    for (const symbol of this.symbols) {
      const start = Date.now();
      try {
        const res = await fetch(`${REST_URL}?symbol=${symbol}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'NEMESIS/1.0' },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) continue;
        const data = await res.json() as { bidPrice?: string; askPrice?: string };
        const bid = parseFloat(data.bidPrice ?? '');
        const ask = parseFloat(data.askPrice ?? '');
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
        this.quotes.set(symbol, {
          symbol,
          price: (bid + ask) / 2,
          lagMs: Date.now() - start,
          fetchedAt: Date.now(),
        });
        this.registry.recordSuccess('binance-ws', Date.now() - start);
      } catch {
        /* REST backup */
      }
    }
  }
}
