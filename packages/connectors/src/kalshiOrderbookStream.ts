import { WebSocket } from 'ws';
import { getKalshiWebSocketUrl, type KalshiEnvironment, type KalshiOrderbook, type OrderbookLevel } from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';
import type { KalshiWebSocketHeaderProvider } from './kalshiStream.js';

const PING_INTERVAL_MS = 10_000;
const DEAD_CONNECTION_MS = 25_000;
const DEFAULT_MAX_TRACKED_TICKERS = 25;

export interface KalshiOrderbookStreamTelemetry {
  connected: boolean;
  trackedTickers: number;
  booksWithExchangeTime: number;
  qualifiedTickers: number;
  reconnects: number;
  sequenceRegressions: number;
  sequenceGaps: number;
  quarantinedTickers: number;
  authenticated: boolean;
  trackingReady: boolean;
  qualificationReady: boolean;
  generation: number;
  lastPongAt: number | null;
  lastMessageAt: number | null;
  lastSequencedDeltaAt: number | null;
  lastExchangeTimestamp: number | null;
  lastCloseAt: number | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastCloseTrigger: string | null;
  subscriptionUpdates: number;
  subscriptionUpdateQueueDepth: number;
  subscriptionUpdateInFlight: boolean;
}

interface MutableBook {
  ticker: string;
  yes: Map<number, number>;
  no: Map<number, number>;
  sequence: number;
  sourceTimestamp?: number;
  receivedAt: number;
  sequencedDeltaAt?: number;
}

type BookUpdateListener = (book: KalshiOrderbook) => void;
type SubscriptionUpdateAction = 'add_markets' | 'delete_markets' | 'get_snapshot';

interface SubscriptionUpdateCommand {
  sid: number;
  marketTickers: string[];
  action: SubscriptionUpdateAction;
}

interface PendingSubscriptionUpdate extends SubscriptionUpdateCommand {
  id: number;
}

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
  private readonly quarantined = new Set<string>();
  private readonly books = new Map<string, MutableBook>();
  private readonly sequenceBySubscription = new Map<string, number>();
  private readonly tickersBySubscription = new Map<string, Set<string>>();
  private readonly subscriptionIdByKey = new Map<string, number>();
  private readonly pendingSnapshotRepair = new Map<string, Set<string>>();
  private socket: WebSocket | null = null;
  private started = false;
  private commandId = 1;
  private reconnectDelayMs = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private reconnects = 0;
  private sequenceRegressions = 0;
  private sequenceGaps = 0;
  private authenticated = false;
  private lastMessageAt: number | null = null;
  private lastPongAt: number | null = null;
  private lastSequencedDeltaAt: number | null = null;
  private lastExchangeTimestamp: number | null = null;
  private lastCloseAt: number | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;
  private lastCloseTrigger: string | null = null;
  private pendingCloseTrigger: string | null = null;
  private subscriptionUpdates = 0;
  private readonly subscriptionUpdateQueue: SubscriptionUpdateCommand[] = [];
  private pendingSubscriptionUpdate: PendingSubscriptionUpdate | null = null;
  private readonly bookUpdateListeners = new Set<BookUpdateListener>();

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly headers: KalshiWebSocketHeaderProvider,
    private readonly environment: KalshiEnvironment = 'production',
    private readonly maxTrackedTickers = DEFAULT_MAX_TRACKED_TICKERS,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  restart(): void {
    this.sequenceBySubscription.clear();
    this.tickersBySubscription.clear();
    this.subscriptionIdByKey.clear();
    this.pendingSnapshotRepair.clear();
    this.subscriptionUpdateQueue.length = 0;
    this.pendingSubscriptionUpdate = null;
    this.closeCurrentSocket();
    if (this.started) this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeCurrentSocket();
  }

  track(tickers: string[]): void {
    for (const ticker of tickers) {
      if (!ticker || this.tickers.has(ticker) || this.tickers.size >= this.maxTrackedTickers) continue;
      this.tickers.add(ticker);
    }
    this.subscribeMissing();
  }

  /** Replaces the bounded live-book working set without accumulating stale thesis tickers. */
  replaceTracked(tickers: string[]): void {
    const desired = new Set<string>();
    for (const ticker of tickers) {
      if (!ticker || desired.has(ticker)) continue;
      desired.add(ticker);
      if (desired.size >= this.maxTrackedTickers) break;
    }
    if (desired.size === this.tickers.size && [...desired].every((ticker) => this.tickers.has(ticker))) return;
    const removed = [...this.tickers].filter((ticker) => !desired.has(ticker));
    this.tickers.clear();
    for (const ticker of desired) this.tickers.add(ticker);
    for (const ticker of removed) {
      this.books.delete(ticker);
      this.quarantined.delete(ticker);
    }
    this.subscribeMissing();
  }

  onBookUpdate(listener: BookUpdateListener): () => void {
    this.bookUpdateListeners.add(listener);
    return () => this.bookUpdateListeners.delete(listener);
  }

  getBook(ticker: string): KalshiOrderbook | null {
    if (this.quarantined.has(ticker)) return null;
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

  telemetry(now = Date.now()): KalshiOrderbookStreamTelemetry {
    const connected = this.socket?.readyState === WebSocket.OPEN;
    const qualifiedTickers = [...this.books.values()].filter((book) => {
      if (this.quarantined.has(book.ticker) || book.sourceTimestamp == null || book.sequencedDeltaAt == null) return false;
      const ageMs = now - book.sequencedDeltaAt;
      return ageMs >= 0 && ageMs <= DEAD_CONNECTION_MS;
    }).length;
    // Qualification requires the full bounded tracking set. A single fresh
    // ticker is useful for display, but never sufficient campaign evidence.
    const trackingReady = this.tickers.size === DEFAULT_MAX_TRACKED_TICKERS;
    const qualificationReady = connected
      && this.authenticated
      && trackingReady
      && qualifiedTickers > 0;
    return {
      connected,
      trackedTickers: this.tickers.size,
      booksWithExchangeTime: [...this.books.values()].filter((book) => book.sourceTimestamp != null).length,
      qualifiedTickers,
      reconnects: this.reconnects,
      sequenceRegressions: this.sequenceRegressions,
      sequenceGaps: this.sequenceGaps,
      quarantinedTickers: this.quarantined.size,
      authenticated: this.authenticated,
      trackingReady,
      qualificationReady,
      generation: this.generation,
      lastPongAt: this.lastPongAt,
      lastMessageAt: this.lastMessageAt,
      lastSequencedDeltaAt: this.lastSequencedDeltaAt,
      lastExchangeTimestamp: this.lastExchangeTimestamp,
      lastCloseAt: this.lastCloseAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      lastCloseTrigger: this.lastCloseTrigger,
      subscriptionUpdates: this.subscriptionUpdates,
      subscriptionUpdateQueueDepth: this.subscriptionUpdateQueue.length,
      subscriptionUpdateInFlight: this.pendingSubscriptionUpdate != null,
    };
  }

  private connect(): void {
    if (!this.started || this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    const headers = this.headers();
    if (!headers) {
      this.authenticated = false;
      this.registry.recordTelemetry('kalshi-orderbook-ws', {
        status: 'warn',
        lastError: 'credentials required for exchange-timestamped order books',
        authenticated: false,
        transportConnected: false,
        trackingReady: false,
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
      this.reconnectDelayMs = 1_000;
      this.subscribed.clear();
      this.books.clear();
      this.sequenceBySubscription.clear();
      this.tickersBySubscription.clear();
      this.subscriptionIdByKey.clear();
      this.pendingSnapshotRepair.clear();
      this.subscriptionUpdateQueue.length = 0;
      this.pendingSubscriptionUpdate = null;
      this.pendingCloseTrigger = null;
      this.lastSequencedDeltaAt = null;
      for (const ticker of this.tickers) this.quarantined.add(ticker);
      this.lastMessageAt = Date.now();
      this.lastPongAt = Date.now();
      this.startHeartbeat(socket, generation);
      this.recordHealth();
      this.subscribeMissing();
    });
    socket.on('message', (raw) => {
      if (this.isCurrent(socket, generation)) this.ingest(String(raw), generation);
    });
    socket.on('ping', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastMessageAt = Date.now();
      this.recordHealth();
    });
    socket.on('pong', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastPongAt = Date.now();
      this.recordHealth();
    });
    socket.on('error', (error) => {
      this.pendingCloseTrigger = `socket_error:${error instanceof Error ? error.message : String(error)}`;
      socket.close();
    });
    socket.on('close', (code, reason) => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastCloseAt = Date.now();
      this.lastCloseCode = code;
      this.lastCloseTrigger = this.pendingCloseTrigger ?? 'remote_close_without_reason';
      this.lastCloseReason = reason.toString('utf8') || this.lastCloseTrigger;
      this.pendingCloseTrigger = null;
      this.socket = null;
      this.authenticated = false;
      this.clearHeartbeatTimer();
      this.subscribed.clear();
      this.subscriptionUpdateQueue.length = 0;
      this.pendingSubscriptionUpdate = null;
      if (!this.started) return;
      this.reconnects += 1;
      this.registry.recordTelemetry('kalshi-orderbook-ws', {
        status: 'warn',
        lastError: 'order-book stream disconnected; reconnect scheduled',
        reconnects: this.reconnects,
        transportConnected: false,
        authenticated: false,
        qualificationReady: false,
        lastCloseAt: this.lastCloseAt,
        lastCloseCode: this.lastCloseCode,
        lastCloseReason: this.lastCloseReason,
        lastCloseTrigger: this.lastCloseTrigger,
      });
      const waitMs = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, waitMs);
    });
  }

  private subscribeMissing(): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const subscriptionEntry = [...this.subscriptionIdByKey.entries()][0];
    if (!subscriptionEntry) {
      if (this.subscribed.size > 0 || this.tickers.size === 0) return;
      const initial = [...this.tickers];
      try {
        socket.send(JSON.stringify({
          id: this.commandId++,
          cmd: 'subscribe',
          params: { channels: ['orderbook_delta'], market_tickers: initial },
        }));
      } catch {
        this.pendingCloseTrigger = 'initial_subscription_send_failed';
        socket.close();
        return;
      }
      for (const ticker of initial) this.subscribed.add(ticker);
      return;
    }

    const [subscription, sid] = subscriptionEntry;
    const removed = [...this.subscribed].filter((ticker) => !this.tickers.has(ticker));
    const added = [...this.tickers].filter((ticker) => !this.subscribed.has(ticker));
    this.enqueueSubscriptionUpdate({ sid, marketTickers: removed, action: 'delete_markets' });
    this.enqueueSubscriptionUpdate({ sid, marketTickers: added, action: 'add_markets' });
    const subscriptionTickers = this.tickersBySubscription.get(subscription) ?? new Set<string>();
    for (const ticker of removed) {
      this.subscribed.delete(ticker);
      subscriptionTickers.delete(ticker);
    }
    for (const ticker of added) {
      this.subscribed.add(ticker);
      this.quarantined.add(ticker);
      subscriptionTickers.add(ticker);
    }
    this.tickersBySubscription.set(subscription, subscriptionTickers);
  }

  /** Ingests one official WebSocket packet; public to support deterministic replay tests. */
  ingest(raw: string, generation = this.generation): void {
    if (generation !== this.generation) return;
    this.lastMessageAt = Date.now();
    try {
      const packet = JSON.parse(raw) as Record<string, unknown>;
      const type = String(packet.type ?? '');
      const msg = packet.msg && typeof packet.msg === 'object' ? packet.msg as Record<string, unknown> : null;
      const packetCommandId = parseNumber(packet.id);
      const acknowledgesPendingUpdate = type === 'ok'
        && packetCommandId != null
        && packetCommandId === this.pendingSubscriptionUpdate?.id;
      if (type === 'error' && packetCommandId != null && packetCommandId === this.pendingSubscriptionUpdate?.id) {
        const errorMessage = String((msg as { msg?: unknown } | null)?.msg ?? 'subscription update failed');
        this.pendingSubscriptionUpdate = null;
        this.subscriptionUpdateQueue.length = 0;
        this.registry.recordWarn('kalshi-orderbook-ws', errorMessage);
        this.pendingCloseTrigger = `subscription_update_error:${errorMessage}`;
        this.socket?.close();
        return;
      }
      if (type === 'subscribed') {
        const subscribedSid = parseNumber(msg?.sid ?? packet.sid);
        if (subscribedSid != null) {
          const subscription = String(subscribedSid);
          this.subscriptionIdByKey.set(subscription, subscribedSid);
          this.tickersBySubscription.set(subscription, new Set(this.subscribed));
          this.subscribeMissing();
        }
        this.recordHealth();
        return;
      }
      const sequence = parseNumber(packet.seq);
      if (sequence == null) {
        if (acknowledgesPendingUpdate) {
          this.registry.recordWarn('kalshi-orderbook-ws', 'subscription update acknowledgement lacked a sequence');
          this.pendingCloseTrigger = 'subscription_update_ack_missing_sequence';
          this.socket?.close();
          return;
        }
        if (type === 'error') this.registry.recordWarn('kalshi-ws', String((msg as { msg?: unknown } | null)?.msg ?? 'subscription error'));
        return;
      }
      const numericSubscriptionId = parseNumber(packet.sid);
      const subscription = numericSubscriptionId == null ? 'default' : String(numericSubscriptionId);
      if (numericSubscriptionId != null) this.subscriptionIdByKey.set(subscription, numericSubscriptionId);
      const subscriptionTickers = this.tickersBySubscription.get(subscription) ?? new Set<string>();
      const ticker = String(msg?.market_ticker ?? '');
      if (ticker && (!this.started || this.subscribed.has(ticker))) subscriptionTickers.add(ticker);
      if (Array.isArray(msg?.market_tickers)) {
        for (const value of msg.market_tickers) {
          const controlTicker = String(value ?? '');
          if (controlTicker && (!this.started || this.subscribed.has(controlTicker))) subscriptionTickers.add(controlTicker);
        }
      }
      this.tickersBySubscription.set(subscription, subscriptionTickers);
      const previousSequence = this.sequenceBySubscription.get(subscription);
      if (previousSequence != null && sequence !== previousSequence + 1) {
        if (acknowledgesPendingUpdate) {
          this.registry.recordWarn('kalshi-orderbook-ws', 'subscription update acknowledgement broke sequence continuity');
          this.pendingCloseTrigger = 'subscription_update_ack_sequence_gap';
          this.socket?.close();
          return;
        }
        if (sequence <= previousSequence) this.sequenceRegressions += 1;
        this.sequenceGaps += 1;
        this.sequenceBySubscription.set(subscription, Math.max(previousSequence, sequence));
        this.quarantineSubscriptionAndRequestSnapshot(subscription, ticker || null, previousSequence + 1, sequence);
        this.recordHealth();
        return;
      }
      this.sequenceBySubscription.set(subscription, sequence);
      if (acknowledgesPendingUpdate) this.pendingSubscriptionUpdate = null;
      if (this.started && ticker && !this.tickers.has(ticker)) {
        this.books.delete(ticker);
        this.quarantined.delete(ticker);
        this.recordHealth();
        return;
      }
      if (!ticker || !msg) {
        if (type === 'error') this.registry.recordWarn('kalshi-ws', String((msg as { msg?: unknown } | null)?.msg ?? 'subscription error'));
        this.recordHealth();
        if (acknowledgesPendingUpdate) this.pumpSubscriptionUpdates();
        return;
      }
      if (type === 'orderbook_snapshot') this.applySnapshot(subscription, ticker, sequence, msg);
      else if (type === 'orderbook_delta') {
        this.applyDelta(ticker, sequence, msg);
        const book = this.getBook(ticker);
        if (book?.sourceTimestamp != null) {
          for (const listener of this.bookUpdateListeners) listener(book);
        }
      }
      else return;
      this.recordHealth();
    } catch {
      this.registry.recordWarn('kalshi-ws', 'malformed order-book stream message');
    }
  }

  private applySnapshot(subscription: string, ticker: string, sequence: number, msg: Record<string, unknown>): void {
    const yes = parseLevels(msg.yes_dollars_fp ?? msg.yes_dollars ?? msg.yes);
    const no = parseLevels(msg.no_dollars_fp ?? msg.no_dollars ?? msg.no);
    this.books.set(ticker, { ticker, yes, no, sequence, receivedAt: Date.now() });
    // A snapshot repairs structure, but qualification stays quarantined until a
    // later sequenced exchange delta proves the stream is advancing.
    this.quarantined.add(ticker);
    const pending = this.pendingSnapshotRepair.get(subscription);
    pending?.delete(ticker);
    if (pending?.size === 0) this.pendingSnapshotRepair.delete(subscription);
  }

  private applyDelta(ticker: string, sequence: number, msg: Record<string, unknown>): void {
    const book = this.books.get(ticker);
    if (!book) return;
    if (sequence <= book.sequence) {
      this.sequenceRegressions += 1;
      this.sequenceGaps += 1;
      this.quarantineSubscriptionAndRequestSnapshot('default', ticker, book.sequence + 1, sequence);
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
    this.lastSequencedDeltaAt = book.receivedAt;
    book.sequencedDeltaAt = book.receivedAt;
    this.lastExchangeTimestamp = timestamp;
    this.quarantined.delete(ticker);
  }

  private quarantineSubscriptionAndRequestSnapshot(
    subscription: string,
    ticker: string | null,
    expected: number,
    received: number,
  ): void {
    const affected = new Set(this.tickersBySubscription.get(subscription));
    if (ticker) affected.add(ticker);
    for (const affectedTicker of affected) {
      this.books.delete(affectedTicker);
      this.quarantined.add(affectedTicker);
    }
    this.registry.recordWarn(
      'kalshi-orderbook-ws',
      `order-book sequence gap for sid ${subscription}: expected ${expected}, received ${received}; quarantined ${affected.size} ticker(s)`,
    );
    if (affected.size === 0 || this.pendingSnapshotRepair.has(subscription)) return;
    this.pendingSnapshotRepair.set(subscription, new Set(affected));
    const sid = this.subscriptionIdByKey.get(subscription);
    if (sid == null || this.socket?.readyState !== WebSocket.OPEN) return;
    this.enqueueSubscriptionUpdate({
      sid,
      marketTickers: [...affected].sort(),
      action: 'get_snapshot',
    });
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isCurrent(socket, generation) || socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      const freshestTrafficAt = Math.max(this.lastMessageAt ?? 0, this.lastPongAt ?? 0);
      if (freshestTrafficAt === 0 || now - freshestTrafficAt > DEAD_CONNECTION_MS) {
        this.registry.recordWarn('kalshi-orderbook-ws', 'order-book websocket liveness expired');
        this.pendingCloseTrigger = 'local_liveness_expired';
        socket.terminate();
        return;
      }
      socket.ping();
    }, PING_INTERVAL_MS);
  }

  private recordHealth(): void {
    const telemetry = this.telemetry();
    this.registry.recordTelemetry('kalshi-orderbook-ws', {
      status: telemetry.qualificationReady ? 'ok' : 'warn',
      lastSuccess: telemetry.qualificationReady ? Date.now() : this.registry.get('kalshi-orderbook-ws')?.lastSuccess ?? null,
      lastError: telemetry.qualificationReady ? null : 'order-book websocket awaiting repaired sequenced delta',
      lastMessageAt: telemetry.lastMessageAt,
      lastPongAt: telemetry.lastPongAt,
      reconnects: telemetry.reconnects,
      sequenceGaps: telemetry.sequenceGaps,
      lastCloseAt: telemetry.lastCloseAt,
      lastCloseCode: telemetry.lastCloseCode,
      lastCloseReason: telemetry.lastCloseReason,
      lastCloseTrigger: telemetry.lastCloseTrigger,
      trackedTickers: telemetry.trackedTickers,
      qualifiedTickers: telemetry.qualifiedTickers,
      subscriptionUpdates: telemetry.subscriptionUpdates,
      subscriptionUpdateQueueDepth: telemetry.subscriptionUpdateQueueDepth,
      subscriptionUpdateInFlight: telemetry.subscriptionUpdateInFlight,
      transportConnected: telemetry.connected,
      authenticated: telemetry.authenticated,
      trackingReady: telemetry.trackingReady,
      qualificationReady: telemetry.qualificationReady,
      environment: this.environment,
      endpointClass: 'market-data',
    });
    const tickerReady = this.registry.get('kalshi-ticker-ws')?.qualificationReady === true;
    this.registry.recordTelemetry('kalshi-ws', {
      status: tickerReady && telemetry.qualificationReady ? 'ok' : 'warn',
      lastMessageAt: telemetry.lastMessageAt,
      lastPongAt: telemetry.lastPongAt,
      transportConnected: telemetry.connected,
      authenticated: telemetry.authenticated,
      qualificationReady: tickerReady && telemetry.qualificationReady,
      reconnects: telemetry.reconnects,
      sequenceGaps: telemetry.sequenceGaps,
    });
  }

  private closeCurrentSocket(): void {
    this.clearHeartbeatTimer();
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.subscribed.clear();
    this.subscriptionUpdateQueue.length = 0;
    this.pendingSubscriptionUpdate = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close();
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private enqueueSubscriptionUpdate(command: SubscriptionUpdateCommand): void {
    if (command.marketTickers.length === 0) return;
    this.subscriptionUpdateQueue.push(command);
    this.pumpSubscriptionUpdates();
  }

  private pumpSubscriptionUpdates(): void {
    if (this.pendingSubscriptionUpdate || this.socket?.readyState !== WebSocket.OPEN) return;
    const command = this.subscriptionUpdateQueue.shift();
    if (!command) return;
    const pending: PendingSubscriptionUpdate = { ...command, id: this.commandId++ };
    try {
      this.socket.send(JSON.stringify({
        id: pending.id,
        cmd: 'update_subscription',
        params: {
          sids: [pending.sid],
          market_tickers: pending.marketTickers,
          action: pending.action,
        },
      }));
      this.pendingSubscriptionUpdate = pending;
      this.subscriptionUpdates += 1;
    } catch {
      this.subscriptionUpdateQueue.unshift(command);
      this.pendingCloseTrigger = 'subscription_update_send_failed';
      this.socket.close();
    }
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }
}
