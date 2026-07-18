import { WebSocket } from 'ws';
import { getKalshiEndpointPolicy, type KalshiEnvironment } from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';
import {
  KalshiProductionConnectionController,
  classifyKalshiWebSocketClose,
  classifyKalshiWebSocketError,
  createKalshiTransportFailure,
  type KalshiRetryDecision,
  type KalshiSocketHealthV2,
  type KalshiTransportFailure,
  type KalshiTransportFailureClass,
} from './kalshiTransportController.js';

const PING_INTERVAL_MS = 10_000;
const DEAD_CONNECTION_MS = 25_000;
const SUBSCRIPTION_BATCH_SIZE = 50;
const SUBSCRIPTION_BATCH_INTERVAL_MS = 250;
const MAX_TRACKED_TICKERS = 500;
const MAX_FUTURE_EXCHANGE_TIME_MS = 5_000;
const MIN_MILLISECOND_EPOCH = 1_500_000_000_000;

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

export interface KalshiTickerStreamTelemetry extends KalshiSocketHealthV2 {
  trackedTickers: number;
  reconnects: number;
  sequenceGaps: number;
  lastCloseAt: number | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastSequencedTickerAt: number | null;
}

type QuoteListener = (quote: KalshiTickerQuote) => void;

export class KalshiStream {
  private readonly quotes = new Map<string, KalshiTickerQuote>();
  private readonly tickers = new Set<string>();
  private readonly subscribed = new Set<string>();
  private socket: WebSocket | null = null;
  private commandId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptionPumpTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private generation = 0;
  private reconnects = 0;
  private sequenceGaps = 0;
  // Kalshi's ticker channel carries no per-message sequence, so integrity is
  // enforced by per-market exchange-timestamp monotonicity instead.
  private readonly lastExchangeTsByTicker = new Map<string, number>();
  private lastMessageAt: number | null = null;
  private lastPongAt: number | null = null;
  private authenticated = false;
  private lastCloseAt: number | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;
  private connectedAt: number | null = null;
  private lastSequencedTickerAt: number | null = null;
  private lastExchangeTimestamp: number | null = null;
  private pendingFailure: { generation: number; failure: KalshiTransportFailure } | null = null;
  private readonly pendingSubscriptionCommands = new Set<number>();
  private readonly listeners = new Set<QuoteListener>();
  private readonly transport: KalshiProductionConnectionController;

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly headers: KalshiWebSocketHeaderProvider = () => null,
    private readonly environment: KalshiEnvironment = 'production',
  ) {
    this.transport = new KalshiProductionConnectionController(
      environment,
      getKalshiEndpointPolicy(environment).websocketUrls,
      { attemptPrefix: 'kalshi-ticker' },
    );
  }

  onQuote(listener: QuoteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getQuote(ticker: string): KalshiTickerQuote | undefined {
    return this.quotes.get(ticker);
  }

  telemetry(now = Date.now()): KalshiTickerStreamTelemetry {
    const connected = this.socket?.readyState === WebSocket.OPEN;
    const transport = this.transport.telemetry();
    const qualificationReady = connected
      && this.authenticated
      && this.lastPongAt != null
      && now - this.lastPongAt <= DEAD_CONNECTION_MS
      && this.transport.qualificationReady(now, DEAD_CONNECTION_MS);
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
      endpointUrl: transport.activeEndpoint ?? transport.nextEndpoint ?? this.transport.currentEndpoint(),
      activeEndpoint: transport.activeEndpoint,
      failedEndpoint: transport.failedEndpoint,
      nextEndpoint: transport.nextEndpoint,
      attemptId: transport.attemptId,
      failureClass: transport.failureClass,
      errorCode: transport.errorCode,
      httpStatus: transport.httpStatus,
      nextRetryAt: transport.nextRetryAt,
      switchReason: transport.switchReason,
      subscriptionAcknowledged: transport.subscriptionAcknowledged,
      lastSequencedTickerAt: this.lastSequencedTickerAt,
      lastExchangeTimestamp: this.lastExchangeTimestamp,
      lastExchangeDataAt: transport.lastExchangeDataAt,
      failureCounters: transport.counters,
    };
  }

  track(tickers: string[]): void {
    this.replaceTracked(tickers);
  }

  replaceTracked(tickers: string[]): void {
    const replacement = new Set(
      [...new Set(tickers.map((ticker) => ticker.trim()).filter(Boolean))]
        .slice(0, MAX_TRACKED_TICKERS),
    );
    const removed = [...this.tickers].filter((ticker) => !replacement.has(ticker));
    const added = [...replacement].filter((ticker) => !this.tickers.has(ticker));
    if (removed.length === 0 && added.length === 0) return;
    this.tickers.clear();
    for (const ticker of replacement) this.tickers.add(ticker);
    for (const ticker of this.quotes.keys()) if (!replacement.has(ticker)) this.quotes.delete(ticker);
    for (const ticker of removed) {
      this.subscribed.delete(ticker);
    }
    if (removed.length > 0) this.lastExchangeTsByTicker.clear();
    if (removed.length > 0 && this.started) {
      // The ticker protocol does not provide a safe membership replacement
      // without subscription ids. A fresh generation guarantees the server
      // and local 500-market sets are identical.
      this.restart();
      return;
    }
    this.subscribeMissing();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  restart(): void {
    this.lastExchangeTsByTicker.clear();
    if (!this.started) return;
    this.clearReconnectTimer();
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
    const transportGeneration = this.transport.telemetry();
    if (transportGeneration.generation !== generation || transportGeneration.attemptId == null) return;
    this.lastMessageAt = Date.now();
    try {
      const packet = JSON.parse(raw) as Record<string, unknown>;
      const type = String(packet.type ?? '');
      if (type === 'ticker') {
        // The Kalshi ticker channel emits a full snapshot per update with no
        // per-message sequence number; ordering and replay protection come
        // from the per-market exchange timestamp (validated in handleTicker).
        if (!packet.msg || typeof packet.msg !== 'object') {
          this.rejectTickerPacket('protocol', 'ticker packet is missing its message body');
          return;
        }
        this.handleTicker(packet.msg as Record<string, unknown>, generation);
      } else if (type === 'subscribed' || type === 'ok') {
        // Kalshi answers the first subscribe on a connection with `subscribed`,
        // but answers any later subscribe against an existing sid with `ok`,
        // carrying the same command id and the merged market_tickers list
        // (proven by wire capture). Both are acknowledgements. Treating only
        // `subscribed` as one left every additive subscribe pending forever, so
        // subscriptionAcknowledged latched false and never recovered. This was
        // unreachable while membership changes forced a reconnect, because a
        // fresh connection always answers `subscribed`.
        const commandId = finiteNumber(packet.id);
        if (commandId != null) this.pendingSubscriptionCommands.delete(commandId);
        else if (this.pendingSubscriptionCommands.size === 1) this.pendingSubscriptionCommands.clear();
        if (this.pendingSubscriptionCommands.size === 0) this.transport.recordSubscriptionAck(generation);
        this.recordHealthy();
      } else if (type === 'error') {
        const detail = String((packet.msg as { msg?: string } | undefined)?.msg ?? 'subscription error');
        this.registry.recordWarn('kalshi-ticker-ws', detail);
        this.restartAfterFailure(createKalshiTransportFailure('protocol', detail));
      }
    } catch (error) {
      this.registry.recordWarn('kalshi-ticker-ws', 'malformed ticker stream message');
      this.restartAfterFailure(createKalshiTransportFailure(
        'protocol',
        error instanceof Error ? error.message : 'malformed ticker stream message',
      ));
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

    const attempt = this.transport.beginAttempt();
    if (!attempt) {
      // Telemetry-only: synthesizing a transport failure without a generation
      // would corrupt the controller's generation-gated accounting.
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
    const { generation, endpoint: endpointUrl } = attempt;
    this.generation = generation;
    let socket: WebSocket;
    try {
      socket = new WebSocket(endpointUrl, { headers });
    } catch (error) {
      const decision = this.transport.recordFailure(generation, classifyKalshiWebSocketError(error));
      this.scheduleReconnect(decision);
      this.recordHealthy();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.authenticated = true;
      this.subscribed.clear();
      this.lastExchangeTsByTicker.clear();
      this.pendingSubscriptionCommands.clear();
      this.lastMessageAt = null;
      this.lastPongAt = null;
      this.connectedAt = Date.now();
      this.lastSequencedTickerAt = null;
      this.lastExchangeTimestamp = null;
      this.startHeartbeat(socket, generation);
      this.recordHealthy();
      this.subscribeMissing();
    });
    socket.on('message', (data) => {
      if (this.isCurrent(socket, generation)) this.ingest(String(data), generation);
    });
    socket.on('ping', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastMessageAt = Date.now();
    });
    socket.on('pong', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastPongAt = Date.now();
      this.transport.recordPong(generation);
      this.recordHealthy();
    });
    socket.on('error', (error) => {
      if (!this.isCurrent(socket, generation)) return;
      this.pendingFailure = { generation, failure: classifyKalshiWebSocketError(error) };
      socket.close();
    });
    socket.on('unexpected-response', (_request, response) => {
      if (!this.isCurrent(socket, generation)) return;
      response.resume();
      this.restartAfterFailure(classifyKalshiWebSocketError({
        statusCode: response.statusCode,
        message: `websocket handshake returned HTTP ${response.statusCode}`,
      }));
    });
    socket.on('close', (code, reason) => this.handleClose(socket, generation, code, reason.toString('utf8') || null));
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isCurrent(socket, generation) || socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      const pongReferenceAt = this.lastPongAt ?? this.connectedAt;
      if (pongReferenceAt == null || now - pongReferenceAt > DEAD_CONNECTION_MS) {
        this.registry.recordWarn('kalshi-ticker-ws', 'ticker websocket liveness expired');
        this.pendingFailure = {
          generation,
          failure: createKalshiTransportFailure('timeout', 'ticker websocket pong expired'),
        };
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
    this.connectedAt = null;
    this.subscribed.clear();
    this.clearHeartbeatTimer();
    this.clearSubscriptionPump();
    const pendingFailure = this.pendingFailure?.generation === generation ? this.pendingFailure.failure : null;
    this.pendingFailure = null;
    const failure = pendingFailure ?? classifyKalshiWebSocketClose(code, reason, !this.started);
    if (!this.started) return;
    this.reconnects += 1;
    const decision = this.transport.recordFailure(generation, failure);
    const transport = this.transport.telemetry();
    this.registry.recordTelemetry('kalshi-ticker-ws', {
      status: decision.retry ? 'warn' : 'error',
      lastError: decision.retry
        ? 'ticker websocket disconnected; reconnect scheduled'
        : `ticker websocket stopped after ${failure.classification}`,
      reconnects: this.reconnects,
      transportConnected: false,
      authenticated: false,
      qualificationReady: false,
      endpointUrl: transport.nextEndpoint ?? transport.failedEndpoint,
      lastCloseAt: this.lastCloseAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
    });
    this.scheduleReconnect(decision);
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
    const id = this.commandId++;
    this.transport.recordSubscriptionPending(this.generation);
    this.socket.send(JSON.stringify({
      id,
      cmd: 'subscribe',
      params: tickers.length > 0
        ? { channels: ['ticker'], market_tickers: tickers }
        : { channels: ['ticker'] },
    }));
    this.pendingSubscriptionCommands.add(id);
  }

  private handleTicker(msg: Record<string, unknown>, generation: number): boolean {
    const ticker = String(msg.market_ticker ?? msg.ticker ?? '');
    if (!ticker) {
      this.rejectTickerPacket('protocol', 'ticker packet has no market ticker');
      return false;
    }
    if (!this.tickers.has(ticker) || !this.subscribed.has(ticker)) {
      this.rejectTickerPacket('protocol', `ticker packet referenced an unexpected market: ${ticker}`);
      return false;
    }
    const hasBid = msg.yes_bid_dollars != null || msg.yes_bid != null;
    const hasAsk = msg.yes_ask_dollars != null || msg.yes_ask != null;
    const yesBid = parsePrice(msg.yes_bid_dollars, msg.yes_bid);
    const yesAsk = parsePrice(msg.yes_ask_dollars, msg.yes_ask);
    if ((!hasBid && !hasAsk)
      || (hasBid && !validProbability(yesBid))
      || (hasAsk && !validProbability(yesAsk))
      || (yesBid != null && yesAsk != null && yesAsk < yesBid)) {
      this.rejectTickerPacket('protocol', `ticker packet has invalid price bounds for ${ticker}`);
      return false;
    }
    const bid = yesBid ?? yesAsk ?? 0.5;
    const ask = yesAsk ?? yesBid ?? bid;
    const now = Date.now();
    const exchangeTimestamp = validExchangeTimestamp(msg, now);
    if (exchangeTimestamp == null) {
      this.rejectTickerPacket('protocol', `ticker packet has an invalid exchange timestamp for ${ticker}`);
      return false;
    }
    // Replay/out-of-order protection without a sequence number: a ticker update
    // whose exchange timestamp predates the newest one already seen for this
    // market is stale and dropped, but does not fault the whole stream.
    const previousExchangeTs = this.lastExchangeTsByTicker.get(ticker);
    if (previousExchangeTs != null && exchangeTimestamp < previousExchangeTs) {
      this.registry.recordWarn('kalshi-ticker-ws', `dropped stale ticker update for ${ticker}`);
      return false;
    }
    this.lastExchangeTsByTicker.set(ticker, exchangeTimestamp);
    const quote: KalshiTickerQuote = {
      ticker,
      yesBid: bid,
      yesAsk: ask,
      yesPrice: (bid + ask) / 2,
      spread: Math.max(0.005, ask - bid),
      volume: finiteNumber(msg.volume_fp ?? msg.volume ?? msg.volume_24h) ?? 0,
      updatedAt: exchangeTimestamp ?? now,
    };
    this.quotes.set(ticker, quote);
    this.lastSequencedTickerAt = now;
    this.lastExchangeTimestamp = exchangeTimestamp;
    this.transport.recordExchangeData(generation, exchangeTimestamp);
    this.recordHealthy();
    for (const listener of this.listeners) listener(quote);
    return true;
  }

  private rejectTickerPacket(
    classification: Extract<KalshiTransportFailureClass, 'protocol' | 'sequence'>,
    detail: string,
  ): void {
    this.registry.recordWarn('kalshi-ticker-ws', detail);
    this.restartAfterFailure(createKalshiTransportFailure(classification, detail));
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
      generation: telemetry.generation,
      attemptId: telemetry.attemptId,
      activeEndpointUrl: telemetry.activeEndpoint,
      failedEndpointUrl: telemetry.failedEndpoint,
      nextEndpointUrl: telemetry.nextEndpoint,
      transportFailureClass: telemetry.failureClass,
      errorCode: telemetry.errorCode,
      httpStatus: telemetry.httpStatus,
      nextRetryAt: telemetry.nextRetryAt,
      switchReason: telemetry.switchReason,
      lastExchangeDataAt: telemetry.lastExchangeTimestamp,
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
    this.connectedAt = null;
    this.subscribed.clear();
    this.pendingSubscriptionCommands.clear();
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

  private restartAfterFailure(failure: KalshiTransportFailure): void {
    if (!this.started) {
      this.transport.recordFailure(this.generation, failure);
      this.recordHealthy();
      return;
    }
    const decision = this.transport.recordFailure(this.generation, failure);
    this.clearSubscriptionPump();
    this.closeCurrentSocket();
    this.scheduleReconnect(decision);
    this.recordHealthy();
  }

  private scheduleReconnect(decision: KalshiRetryDecision): void {
    this.clearReconnectTimer();
    if (!this.started || !decision.retry || decision.delayMs == null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, decision.delayMs);
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

function validProbability(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validExchangeTimestamp(msg: Record<string, unknown>, now: number): number | null {
  const raw = msg.ts_ms ?? msg.timestamp_ms ?? msg.ts ?? msg.timestamp;
  let timestamp: number;
  if (typeof raw === 'number') timestamp = raw;
  else if (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim())) timestamp = Number(raw);
  else if (typeof raw === 'string') timestamp = Date.parse(raw);
  else return null;
  if (!Number.isFinite(timestamp)
    || !Number.isInteger(timestamp)
    || timestamp < MIN_MILLISECOND_EPOCH
    || timestamp > now + MAX_FUTURE_EXCHANGE_TIME_MS
    || now - timestamp > DEAD_CONNECTION_MS) return null;
  return timestamp;
}
