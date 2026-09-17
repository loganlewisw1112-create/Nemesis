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

/**
 * Supervisor bounds, mirroring the order-book stream's. The order-book stream
 * got this owner on 2026-07-27 after a sticky close left it with no socket, no
 * heartbeat and no reconnect armed for 7.9h; the ticker stream has the identical
 * dead end in `scheduleReconnect` and, until now, nothing on any timer watching
 * it. See `superviseDataPlane`.
 */
export const TICKER_SUPERVISOR_BASE_BACKOFF_MS = 5_000;
export const TICKER_SUPERVISOR_MAX_BACKOFF_MS = 60_000;
export const TICKER_CONNECT_DEADLINE_MS = 20_000;
export const TICKER_SUPERVISOR_MAX_ESCALATIONS = 3;

/**
 * Classes the transport controller refuses to retry at all. The supervisor keeps
 * retrying them at its cap with a durable warn rather than giving up: credentials
 * and configuration can be repaired at runtime, and a permanently dead quote feed
 * is strictly worse than a slow retry loop.
 */
const SUPERVISOR_STICKY_FAILURE_CLASSES = new Set<KalshiTransportFailureClass>([
  'authentication',
  'authorization',
  'configuration',
]);

export type TickerSocketState = 'none' | 'connecting' | 'open' | 'closing' | 'closed';

export type TickerSupervisionAction =
  | 'none'
  | 'heartbeat-restarted'
  | 'reconnect-dead-socket'
  | 'reconnect-connect-timeout'
  | 'stream-restarted'
  /**
   * A supervised attempt called `connect()` and got no socket back — the
   * headers provider returned null, or the endpoint policy is empty. Real and
   * worth a durable line (it is what a rejected API key looks like from here),
   * but recovery is still owned: the supervisor's own backoff is armed and will
   * try again. Distinct from `invariant-violation` so it cannot fail the gate
   * that exists to catch an unrecoverable stream.
   */
  | 'connect-produced-no-socket'
  | 'invariant-violation';

export interface TickerSupervisionResult {
  action: TickerSupervisionAction;
  reason: string | null;
  nextAttemptInMs: number | null;
}
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
  socketState: TickerSocketState;
  /** A reconnect timer is armed. With socketState !== 'open' this is what proves recovery is owned. */
  reconnectScheduled: boolean;
  connectInFlight: boolean;
  supervisorEscalations: number;
  lastSupervisionAction: string | null;
  lastSupervisionAt: number | null;
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
  private connectAttemptStartedAt: number | null = null;
  private supervisorBackoffMs = TICKER_SUPERVISOR_BASE_BACKOFF_MS;
  private supervisorNextAttemptAt: number | null = null;
  private supervisedAttemptPending = false;
  private supervisedAttemptFailures = 0;
  private supervisionInvariantReported = false;
  private supervisorEscalations = 0;
  private lastSupervisionAction: string | null = null;
  private lastSupervisionAt: number | null = null;
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
    // Pong-or-traffic, not pong alone: lastPongAt is null on every fresh
    // connection until the first ping cycle completes, so keying purely on it
    // reports a healthy new socket as dead.
    const livenessAt = Math.max(this.lastPongAt ?? 0, this.lastMessageAt ?? 0, this.connectedAt ?? 0);
    const transportQualificationReady = connected
      && this.authenticated
      && livenessAt > 0
      && now - livenessAt <= DEAD_CONNECTION_MS
      && this.transport.transportQualificationReady();
    return {
      connected,
      authenticated: this.authenticated,
      qualificationReady,
      transportQualificationReady,
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
      socketState: this.socketState(),
      reconnectScheduled: this.reconnectTimer != null,
      connectInFlight: this.socketState() === 'connecting',
      supervisorEscalations: this.supervisorEscalations,
      lastSupervisionAction: this.lastSupervisionAction,
      lastSupervisionAt: this.lastSupervisionAt,
      lastSequencedTickerAt: this.lastSequencedTickerAt,
      lastExchangeTimestamp: this.lastExchangeTimestamp,
      lastExchangeDataAt: transport.lastExchangeDataAt,
      failureCounters: transport.counters,
    };
  }

  socketState(): TickerSocketState {
    const socket = this.socket;
    if (!socket) return 'none';
    if (socket.readyState === WebSocket.CONNECTING) return 'connecting';
    if (socket.readyState === WebSocket.OPEN) return 'open';
    if (socket.readyState === WebSocket.CLOSING) return 'closing';
    return 'closed';
  }

  /**
   * The stream's own outside owner, mirroring `KalshiOrderbookStream`.
   *
   * `scheduleReconnect` arms nothing when `transport.recordFailure` answers
   * no-retry -- a sticky authentication/authorization/configuration class, any
   * class the controller does not map, or a stale generation. By then
   * `closeCurrentSocket` has nulled the socket and cleared the heartbeat, so
   * nothing inside the stream can revive it, while `started` stays true and
   * every caller keeps reading quotes that will never update again. That is the
   * same absorbing dead state that ran the order-book stream dark for 7.9h on
   * 2026-07-26; this one was never supervised at all.
   *
   * Recovery has to be driven from outside the socket, because everything inside
   * it dies with it. Backoff here is the supervisor's own and deliberately
   * independent of the controller's retry verdict.
   */
  superviseDataPlane(now = Date.now()): TickerSupervisionResult {
    if (!this.started) return { action: 'none', reason: null, nextAttemptInMs: null };
    const state = this.socketState();

    // An OPEN socket with no heartbeat handle can never be pinged or timed out:
    // closeCurrentSocket clears the interval, so a stale-generation race leaves
    // it silent forever.
    if (state === 'open' && this.heartbeatTimer == null && this.socket) {
      this.registry.recordWarn('kalshi-ticker-ws', 'ticker heartbeat interval missing on an open socket; restarting it');
      this.startHeartbeat(this.socket, this.generation);
      return this.finishSupervision(now, 'heartbeat-restarted', 'open socket had no heartbeat interval', null);
    }

    // Stuck in CONNECTING: no `open`, no `close`, and nothing else times it out.
    if (state === 'connecting') {
      const startedAt = this.connectAttemptStartedAt;
      if (startedAt == null || now - startedAt <= TICKER_CONNECT_DEADLINE_MS) {
        return { action: 'none', reason: 'connect in flight', nextAttemptInMs: null };
      }
      return this.attemptSupervisedConnect(
        now,
        'reconnect-connect-timeout',
        `connect attempt exceeded ${TICKER_CONNECT_DEADLINE_MS}ms`,
        true,
      );
    }

    // No live socket and nobody armed to bring one back. Membership is
    // deliberately not required: an empty tracked set still needs a socket.
    if (state !== 'open' && this.reconnectTimer == null) {
      const dueAt = this.supervisorNextAttemptAt;
      if (dueAt != null && now < dueAt) {
        return this.checkSupervisionInvariant(now, {
          action: 'none',
          reason: 'supervisor backoff pending',
          nextAttemptInMs: dueAt - now,
        });
      }
      return this.attemptSupervisedConnect(
        now,
        'reconnect-dead-socket',
        `socket state ${state} with no reconnect armed`,
        false,
      );
    }

    return this.checkSupervisionInvariant(now, { action: 'none', reason: null, nextAttemptInMs: null });
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
    this.resetSupervisorBackoff();
  }

  /** Ingest one official packet; public for deterministic replay tests. */
  ingest(raw: string, generation = this.generation): void {
    if (generation !== this.generation) return;
    const transportGeneration = this.transport.telemetry();
    if (transportGeneration.generation !== generation || transportGeneration.attemptId == null) return;
    this.lastMessageAt = Date.now();
    // An application frame is the only proof a supervised attempt actually
    // restored the feed; `open` alone has produced silent zombies before.
    this.resetSupervisorBackoff();
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
    this.connectAttemptStartedAt = Date.now();
    let socket: WebSocket;
    try {
      socket = new WebSocket(endpointUrl, { headers });
    } catch (error) {
      this.connectAttemptStartedAt = null;
      const decision = this.transport.recordFailure(generation, classifyKalshiWebSocketError(error));
      this.scheduleReconnect(decision);
      this.recordHealthy();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.connectAttemptStartedAt = null;
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
    this.connectAttemptStartedAt = null;
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
    this.connectAttemptStartedAt = null;
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
    // Returning here arms nothing. That is intentional -- the controller's verdict
    // is respected -- but it is only safe because superviseDataPlane owns recovery
    // from the resulting state. Do not make this the only path back.
    if (!this.started || !decision.retry || decision.delayMs == null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, decision.delayMs);
  }

  /**
   * Counts one supervised recovery attempt. Returns true when previous attempts
   * never reached open + a first application frame often enough that a full
   * stream rebuild is warranted.
   */
  private noteSupervisedAttempt(): boolean {
    if (this.supervisedAttemptPending) this.supervisedAttemptFailures += 1;
    this.supervisedAttemptPending = true;
    this.supervisionInvariantReported = false;
    return this.supervisedAttemptFailures >= TICKER_SUPERVISOR_MAX_ESCALATIONS;
  }

  /** Arms the supervisor's own backoff. Returns the delay until the next attempt. */
  private scheduleSupervisorBackoff(now: number): number {
    const failureClass = this.transport.telemetry().failureClass;
    if (failureClass != null && SUPERVISOR_STICKY_FAILURE_CLASSES.has(failureClass)) {
      this.supervisorBackoffMs = TICKER_SUPERVISOR_MAX_BACKOFF_MS;
      this.registry.recordWarn(
        'kalshi-ticker-ws',
        `ticker websocket sticky ${failureClass} failure; capping supervised retry at ${TICKER_SUPERVISOR_MAX_BACKOFF_MS}ms and continuing to retry`,
      );
    }
    const backoffMs = this.supervisorBackoffMs;
    this.supervisorNextAttemptAt = now + backoffMs;
    this.supervisorBackoffMs = Math.min(TICKER_SUPERVISOR_MAX_BACKOFF_MS, backoffMs * 2);
    return backoffMs;
  }

  private resetSupervisorBackoff(): void {
    this.supervisorBackoffMs = TICKER_SUPERVISOR_BASE_BACKOFF_MS;
    this.supervisorNextAttemptAt = null;
    this.supervisedAttemptPending = false;
    this.supervisedAttemptFailures = 0;
    this.supervisionInvariantReported = false;
  }

  private attemptSupervisedConnect(
    now: number,
    action: TickerSupervisionAction,
    reason: string,
    tearDownFirst: boolean,
  ): TickerSupervisionResult {
    const escalate = this.noteSupervisedAttempt();
    const backoffMs = this.scheduleSupervisorBackoff(now);
    if (tearDownFirst) {
      this.clearSubscriptionPump();
      this.closeCurrentSocket();
      this.recordHealthy();
    }
    if (escalate) return this.restartStreamAfterEscalation(now, reason);
    this.registry.recordWarn(
      'kalshi-ticker-ws',
      `ticker data-plane supervisor reconnecting (${action}): ${reason}; next supervised attempt in ${backoffMs}ms`,
    );
    this.connect();
    const produced = this.socketState();
    if (produced === 'none' || produced === 'closed') {
      // connect() returned without installing a socket: no headers, or no
      // endpoint in the environment policy. The backoff is already armed, so
      // this is a diagnostic, not a lost stream.
      this.registry.recordWarn(
        'kalshi-ticker-ws',
        `ticker supervised connect produced no socket (${reason}); retrying in ${backoffMs}ms`,
      );
      return this.checkSupervisionInvariant(
        now,
        this.finishSupervision(now, 'connect-produced-no-socket', reason, backoffMs),
      );
    }
    return this.checkSupervisionInvariant(now, this.finishSupervision(now, action, reason, backoffMs));
  }

  /**
   * Bounded last resort: rebuild the stream when repeated supervised reconnects
   * never produced a frame. Drops the per-ticker exchange-timestamp memory so
   * every quote must re-prove itself, and forces a full resubscribe.
   */
  private restartStreamAfterEscalation(now: number, reason: string): TickerSupervisionResult {
    this.supervisedAttemptFailures = 0;
    this.registry.recordWarn(
      'kalshi-ticker-ws',
      `ticker data-plane supervisor escalating to a full stream restart after ${TICKER_SUPERVISOR_MAX_ESCALATIONS} failed supervised attempts: ${reason}`,
    );
    this.clearReconnectTimer();
    this.clearSubscriptionPump();
    this.subscribed.clear();
    this.pendingSubscriptionCommands.clear();
    this.lastExchangeTsByTicker.clear();
    this.pendingFailure = null;
    this.closeCurrentSocket();
    this.recordHealthy();
    this.connect();
    const nextAttemptInMs = this.supervisorNextAttemptAt == null ? null : this.supervisorNextAttemptAt - now;
    return this.checkSupervisionInvariant(now, this.finishSupervision(now, 'stream-restarted', reason, nextAttemptInMs));
  }

  /**
   * Tripwire for the next variant of this bug: a started stream that is not open,
   * has no reconnect armed and no connect in flight has nobody who can revive it.
   * Reported once per supervised attempt so it cannot spam.
   *
   * The supervisor's own pending attempt counts as ownership. Without that, this
   * fired on every backoff wait — 2026-07-31 saw it report a violation while the
   * supervisor was holding a timer with 55 seconds still to run, which both
   * diluted the signal and failed the Phase 4 gate that exists to catch a stream
   * nothing can revive. An attempt that produces no socket is reported as
   * `connect-produced-no-socket` instead; this stays for the case where nothing
   * whatsoever is arranged.
   */
  private checkSupervisionInvariant(now: number, result: TickerSupervisionResult): TickerSupervisionResult {
    if (!this.started) return result;
    const state = this.socketState();
    if (state === 'open' || state === 'connecting' || this.reconnectTimer != null) return result;
    if (this.supervisorNextAttemptAt != null) return result;
    if (this.supervisionInvariantReported) return result;
    this.supervisionInvariantReported = true;
    const reason = `started stream has socketState=${state} with no reconnect scheduled and no connect in flight`;
    this.registry.recordWarn('kalshi-ticker-ws', `ticker data-plane invariant violated: ${reason}`);
    if (result.action !== 'none') return result;
    return this.finishSupervision(now, 'invariant-violation', reason, result.nextAttemptInMs);
  }

  private finishSupervision(
    now: number,
    action: TickerSupervisionAction,
    reason: string | null,
    nextAttemptInMs: number | null,
  ): TickerSupervisionResult {
    if (action !== 'none') {
      this.supervisorEscalations += 1;
      this.lastSupervisionAction = action;
      this.lastSupervisionAt = now;
    }
    return { action, reason, nextAttemptInMs };
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
