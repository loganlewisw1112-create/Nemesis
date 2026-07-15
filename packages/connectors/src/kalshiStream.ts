import { WebSocket } from 'ws';
import { getKalshiWebSocketUrl, type KalshiEnvironment } from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';

const PING_INTERVAL_MS = 10_000;
const DEAD_CONNECTION_MS = 25_000;

export type KalshiWebSocketHeaderProvider = () => Record<string, string> | null;

export interface KalshiTickerQuote {
  ticker: string;
  yesBid: number;
  yesAsk: number;
  yesPrice: number;
  spread: number;
  volume: number;
  updatedAt: number;
  exchangeSequence?: number;
}

export interface KalshiTickerStreamTelemetry {
  connected: boolean;
  authenticated: boolean;
  qualificationReady: boolean;
  environment: KalshiEnvironment;
  generation: number;
  trackedTickers: number;
  reconnects: number;
  sequenceGaps: number;
  lastMessageAt: number | null;
  lastPongAt: number | null;
}

type QuoteListener = (quote: KalshiTickerQuote) => void;

export class KalshiStream {
  private readonly quotes = new Map<string, KalshiTickerQuote>();
  private readonly tickers = new Set<string>();
  private readonly subscribed = new Set<string>();
  private socket: WebSocket | null = null;
  private commandId = 1;
  private reconnectMs = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private generation = 0;
  private reconnects = 0;
  private sequenceGaps = 0;
  private readonly sequenceBySubscription = new Map<string, number>();
  private lastMessageAt: number | null = null;
  private lastPongAt: number | null = null;
  private authenticated = false;
  private readonly listeners = new Set<QuoteListener>();

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly headers: KalshiWebSocketHeaderProvider = () => null,
    private readonly environment: KalshiEnvironment = 'production',
  ) {}

  onQuote(listener: QuoteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getQuote(ticker: string): KalshiTickerQuote | undefined {
    return this.quotes.get(ticker);
  }

  telemetry(now = Date.now()): KalshiTickerStreamTelemetry {
    const connected = this.socket?.readyState === WebSocket.OPEN;
    const freshestTrafficAt = Math.max(this.lastMessageAt ?? 0, this.lastPongAt ?? 0);
    const qualificationReady = connected
      && this.authenticated
      && freshestTrafficAt > 0
      && now - freshestTrafficAt <= DEAD_CONNECTION_MS;
    return {
      connected,
      authenticated: this.authenticated,
      qualificationReady,
      environment: this.environment,
      generation: this.generation,
      trackedTickers: this.tickers.size,
      reconnects: this.reconnects,
      sequenceGaps: this.sequenceGaps,
      lastMessageAt: this.lastMessageAt,
      lastPongAt: this.lastPongAt,
    };
  }

  track(tickers: string[]): void {
    for (const ticker of tickers) if (ticker) this.tickers.add(ticker);
    this.subscribeMissing();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  restart(): void {
    this.sequenceBySubscription.clear();
    if (!this.started) return;
    this.closeCurrentSocket();
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.clearReconnectTimer();
    this.closeCurrentSocket();
  }

  /** Ingest one official packet; public for deterministic replay tests. */
  ingest(raw: string, generation = this.generation): void {
    if (generation !== this.generation) return;
    this.lastMessageAt = Date.now();
    try {
      const packet = JSON.parse(raw) as Record<string, unknown>;
      const type = String(packet.type ?? '');
      const sequence = finiteNumber(packet.seq);
      if (type === 'ticker' && packet.msg && typeof packet.msg === 'object') {
        const subscription = String(packet.sid ?? 'default');
        const previousSequence = this.sequenceBySubscription.get(subscription);
        if (sequence != null && previousSequence != null && sequence !== previousSequence + 1) {
          this.sequenceGaps += 1;
          this.registry.recordWarn('kalshi-ticker-ws', `ticker sequence gap: expected ${previousSequence + 1}, received ${sequence}`);
          this.restart();
          return;
        }
        if (sequence != null) this.sequenceBySubscription.set(subscription, sequence);
        this.handleTicker(packet.msg as Record<string, unknown>, sequence ?? undefined);
      } else if (type === 'subscribed') {
        this.recordHealthy();
      } else if (type === 'error') {
        this.registry.recordWarn('kalshi-ticker-ws', String((packet.msg as { msg?: string } | undefined)?.msg ?? 'subscription error'));
      }
    } catch {
      this.registry.recordWarn('kalshi-ticker-ws', 'malformed ticker stream message');
    }
  }

  private connect(): void {
    if (!this.started || this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    const headers = this.headers();
    if (!headers) {
      this.authenticated = false;
      this.registry.recordTelemetry('kalshi-ticker-ws', {
        status: 'warn',
        lastError: 'credentials required for Kalshi ticker websocket',
        authenticated: false,
        transportConnected: false,
        qualificationReady: false,
        environment: this.environment,
      });
      return;
    }

    const generation = ++this.generation;
    const socket = new WebSocket(getKalshiWebSocketUrl(this.environment), { headers });
    this.socket = socket;
    socket.on('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.authenticated = true;
      this.reconnectMs = 1_000;
      this.subscribed.clear();
      this.sequenceBySubscription.clear();
      this.lastMessageAt = Date.now();
      this.lastPongAt = Date.now();
      this.startHeartbeat(socket, generation);
      this.recordHealthy();
      this.subscribeMissing();
      if (this.tickers.size === 0) this.sendSubscription([]);
    });
    socket.on('message', (data) => {
      if (this.isCurrent(socket, generation)) this.ingest(String(data), generation);
    });
    socket.on('ping', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastMessageAt = Date.now();
      this.recordHealthy();
    });
    socket.on('pong', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastPongAt = Date.now();
      this.recordHealthy();
    });
    socket.on('error', () => socket.close());
    socket.on('close', () => this.handleClose(socket, generation));
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isCurrent(socket, generation) || socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      const freshestTrafficAt = Math.max(this.lastMessageAt ?? 0, this.lastPongAt ?? 0);
      if (freshestTrafficAt === 0 || now - freshestTrafficAt > DEAD_CONNECTION_MS) {
        this.registry.recordWarn('kalshi-ticker-ws', 'ticker websocket liveness expired');
        socket.terminate();
        return;
      }
      socket.ping();
    }, PING_INTERVAL_MS);
  }

  private handleClose(socket: WebSocket, generation: number): void {
    if (!this.isCurrent(socket, generation)) return;
    this.socket = null;
    this.authenticated = false;
    this.subscribed.clear();
    this.clearHeartbeatTimer();
    if (!this.started) return;
    this.reconnects += 1;
    this.registry.recordTelemetry('kalshi-ticker-ws', {
      status: 'warn',
      lastError: 'ticker websocket disconnected; reconnect scheduled',
      reconnects: this.reconnects,
      transportConnected: false,
      authenticated: false,
      qualificationReady: false,
    });
    const waitMs = this.reconnectMs;
    this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, waitMs);
  }

  private subscribeMissing(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const missing = [...this.tickers].filter((ticker) => !this.subscribed.has(ticker));
    for (let index = 0; index < missing.length; index += 50) {
      const batch = missing.slice(index, index + 50);
      this.sendSubscription(batch);
      for (const ticker of batch) this.subscribed.add(ticker);
    }
  }

  private sendSubscription(tickers: string[]): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      id: this.commandId++,
      cmd: 'subscribe',
      params: tickers.length > 0
        ? { channels: ['ticker'], market_tickers: tickers }
        : { channels: ['ticker'] },
    }));
  }

  private handleTicker(msg: Record<string, unknown>, sequence?: number): void {
    const ticker = String(msg.market_ticker ?? msg.ticker ?? '');
    if (!ticker) return;
    const yesBid = parsePrice(msg.yes_bid_dollars, msg.yes_bid);
    const yesAsk = parsePrice(msg.yes_ask_dollars, msg.yes_ask);
    if (yesBid === undefined && yesAsk === undefined) return;
    const bid = yesBid ?? yesAsk ?? 0.5;
    const ask = yesAsk ?? yesBid ?? bid;
    const quote: KalshiTickerQuote = {
      ticker,
      yesBid: bid,
      yesAsk: ask,
      yesPrice: (bid + ask) / 2,
      spread: Math.max(0.005, ask - bid),
      volume: finiteNumber(msg.volume_fp ?? msg.volume ?? msg.volume_24h) ?? 0,
      updatedAt: Date.now(),
      exchangeSequence: sequence,
    };
    this.quotes.set(ticker, quote);
    this.recordHealthy();
    for (const listener of this.listeners) listener(quote);
  }

  private recordHealthy(): void {
    const telemetry = this.telemetry();
    this.registry.recordTelemetry('kalshi-ticker-ws', {
      status: telemetry.qualificationReady ? 'ok' : 'warn',
      lastSuccess: telemetry.qualificationReady ? Date.now() : this.registry.get('kalshi-ticker-ws')?.lastSuccess ?? null,
      lastError: telemetry.qualificationReady ? null : 'ticker websocket awaiting recent traffic',
      lastMessageAt: telemetry.lastMessageAt,
      lastPongAt: telemetry.lastPongAt,
      reconnects: telemetry.reconnects,
      sequenceGaps: telemetry.sequenceGaps,
      transportConnected: telemetry.connected,
      authenticated: telemetry.authenticated,
      qualificationReady: telemetry.qualificationReady,
      environment: telemetry.environment,
      endpointClass: 'market-data',
    });
    this.registry.recordTelemetry('kalshi-ws', {
      status: telemetry.qualificationReady ? 'ok' : 'warn',
      lastMessageAt: telemetry.lastMessageAt,
      lastPongAt: telemetry.lastPongAt,
      transportConnected: telemetry.connected,
      authenticated: telemetry.authenticated,
      qualificationReady: telemetry.qualificationReady,
      reconnects: telemetry.reconnects,
    });
  }

  private closeCurrentSocket(): void {
    this.clearHeartbeatTimer();
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.subscribed.clear();
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close();
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePrice(dollars: unknown, cents: unknown): number | undefined {
  const dollarValue = finiteNumber(dollars);
  if (dollarValue != null) return dollarValue;
  const centValue = finiteNumber(cents);
  return centValue == null ? undefined : centValue / 100;
}
