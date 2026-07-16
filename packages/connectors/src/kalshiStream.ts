import { WebSocket } from 'ws';
import { getKalshiEndpointPolicy, type KalshiEnvironment } from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';

const PING_INTERVAL_MS = 10_000;
const DEAD_CONNECTION_MS = 25_000;
const SUBSCRIPTION_BATCH_SIZE = 50;
const SUBSCRIPTION_BATCH_INTERVAL_MS = 250;

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
  lastCloseAt: number | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  endpointUrl: string | null;
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
  private subscriptionPumpTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private generation = 0;
  // Keep endpoint affinity per stream. A network/DNS failure on the primary
  // host must not strand the stream when the production alias is available.
  private endpointIndex = 0;
  private reconnects = 0;
  private sequenceGaps = 0;
  private readonly sequenceBySubscription = new Map<string, number>();
  private lastMessageAt: number | null = null;
  private lastPongAt: number | null = null;
  private authenticated = false;
  private lastCloseAt: number | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;
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
      lastCloseAt: this.lastCloseAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      endpointUrl: this.currentEndpointUrl(),
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
    this.clearSubscriptionPump();
    this.closeCurrentSocket();
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.clearReconnectTimer();
    this.clearSubscriptionPump();
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
    const endpointUrl = this.currentEndpointUrl();
    if (!endpointUrl) {
      this.authenticated = false;
      this.registry.recordTelemetry('kalshi-ticker-ws', {
        status: 'error',
        lastError: 'no websocket endpoint in selected Kalshi environment policy',
        authenticated: false,
        transportConnected: false,
        qualificationReady: false,
        environment: this.environment,
      });
      return;
    }
    const socket = new WebSocket(endpointUrl, { headers });
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
    socket.on('close', (code, reason) => this.handleClose(socket, generation, code, reason.toString('utf8') || null));
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

  private handleClose(socket: WebSocket, generation: number, code: number, reason: string | null): void {
    if (!this.isCurrent(socket, generation)) return;
    this.lastCloseAt = Date.now();
    this.lastCloseCode = code;
    this.lastCloseReason = reason;
    this.socket = null;
    this.authenticated = false;
    this.subscribed.clear();
    this.clearHeartbeatTimer();
    this.clearSubscriptionPump();
    if (!this.started) return;
    this.reconnects += 1;
    this.advanceEndpoint();
    this.registry.recordTelemetry('kalshi-ticker-ws', {
      status: 'warn',
      lastError: 'ticker websocket disconnected; reconnect scheduled',
      reconnects: this.reconnects,
      transportConnected: false,
      authenticated: false,
      qualificationReady: false,
      endpointUrl: this.currentEndpointUrl(),
      lastCloseAt: this.lastCloseAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
    });
    const waitMs = this.reconnectMs;
    this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, waitMs);
  }

  private subscribeMissing(): void {
    if (this.socket?.readyState !== WebSocket.OPEN || this.subscriptionPumpTimer) return;
    const pump = () => {
      this.subscriptionPumpTimer = null;
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const batch = [...this.tickers]
        .filter((ticker) => !this.subscribed.has(ticker))
        .slice(0, SUBSCRIPTION_BATCH_SIZE);
      if (batch.length === 0) return;
      try {
        this.sendSubscription(batch);
      } catch {
        this.socket.close();
        return;
      }
      for (const ticker of batch) this.subscribed.add(ticker);
      if (this.subscribed.size < this.tickers.size) {
        this.subscriptionPumpTimer = setTimeout(pump, SUBSCRIPTION_BATCH_INTERVAL_MS);
      }
    };
    pump();
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
      lastCloseAt: telemetry.lastCloseAt,
      lastCloseCode: telemetry.lastCloseCode,
      lastCloseReason: telemetry.lastCloseReason,
      transportConnected: telemetry.connected,
      authenticated: telemetry.authenticated,
      qualificationReady: telemetry.qualificationReady,
      environment: telemetry.environment,
      endpointUrl: telemetry.endpointUrl,
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
      endpointUrl: telemetry.endpointUrl,
    });
  }

  private closeCurrentSocket(): void {
    this.clearHeartbeatTimer();
    this.clearSubscriptionPump();
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

  private clearSubscriptionPump(): void {
    if (this.subscriptionPumpTimer) clearTimeout(this.subscriptionPumpTimer);
    this.subscriptionPumpTimer = null;
  }

  private currentEndpointUrl(): string | null {
    const endpoints = getKalshiEndpointPolicy(this.environment).websocketUrls;
    return endpoints[this.endpointIndex] ?? endpoints[0] ?? null;
  }

  private advanceEndpoint(): void {
    const count = getKalshiEndpointPolicy(this.environment).websocketUrls.length;
    if (count > 1) this.endpointIndex = (this.endpointIndex + 1) % count;
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
