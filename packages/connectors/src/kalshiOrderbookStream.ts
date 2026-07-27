import { WebSocket } from 'ws';
import {
  getKalshiEndpointPolicy,
  type KalshiEnvironment,
  type KalshiMarket,
  type KalshiOrderbook,
  type OrderbookLevel,
} from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';
import type { KalshiWebSocketHeaderProvider } from './kalshiStream.js';
import {
  ProductionMarketProvenanceStore,
  type ProductionMarketProvenance,
} from './productionMarketProvenance.js';
import {
  KalshiProductionConnectionController,
  classifyKalshiWebSocketClose,
  classifyKalshiWebSocketError,
  createKalshiTransportFailure,
  type KalshiSocketHealthV2,
  type KalshiTransportFailure,
  type KalshiTransportFailureClass,
} from './kalshiTransportController.js';

const PING_INTERVAL_MS = 10_000;
const DEAD_CONNECTION_MS = 25_000;
// Pong-only / protocol-ping liveness can keep a half-open socket alive while
// orderbook application traffic has stopped (overnight soak 2026-07-23:
// lastMessageAt froze ~14h while client pings still earned pongs; Jul 25
// paper run: observation freshness climbed >3h with socketConnected true).
// When markets are tracked, require recent *application* ingest on a looser
// bound than DEAD_CONNECTION so quiet books do not thrash every 25s, but a
// multi-minute data-plane freeze still forces reconnect + resubscribe.
// Recovery must schedule reconnect itself — terminate()+close alone has left
// zombie OPEN sockets without a reconnect on Windows Electron builds.
export const ORDERBOOK_DATA_PLANE_SILENCE_MS = 90_000;
const DATA_PLANE_SILENCE_MS = ORDERBOOK_DATA_PLANE_SILENCE_MS;
// A socket stuck in CONNECTING never fires `open` or `close`, so nothing inside
// the socket can time it out. The supervisor owns that deadline from outside.
export const ORDERBOOK_CONNECT_DEADLINE_MS = 20_000;
// Supervisor backoff is deliberately independent of the transport controller's
// retry decision: the 2026-07-26 outage was caused by the controller returning
// noRetry() forever, so an owner that trusts that decision cannot recover.
export const ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS = 5_000;
export const ORDERBOOK_SUPERVISOR_MAX_BACKOFF_MS = 60_000;
// Consecutive supervised attempts that never reached open + first application
// frame before the supervisor tears the whole stream down and rebuilds it.
export const ORDERBOOK_SUPERVISOR_MAX_ESCALATIONS = 3;
const DEFAULT_MAX_TRACKED_TICKERS = 25;
// Credentials can be repaired at runtime; a permanently dead feed is strictly
// worse than a slow retry loop, so sticky classes back off to the cap and keep
// retrying with a durable warn instead of latching the stream off.
const SUPERVISOR_STICKY_FAILURE_CLASSES = new Set<KalshiTransportFailureClass>([
  'authentication',
  'authorization',
  'configuration',
]);
// Bounded freshness proves the stream is live, not that every second trades:
// a book with sequence continuity, a live pong, and an unchanged state is
// still current. One second disqualified the whole feed whenever no tracked
// market happened to tick, so the bound aligns with the liveness window.
const MAX_QUALIFICATION_EXCHANGE_AGE_MS = DEAD_CONNECTION_MS;
const MAX_EXCHANGE_FUTURE_SKEW_MS = 5_000;
const MIN_MILLISECOND_TIMESTAMP = 1_000_000_000_000;

/** Read-only projection of `WebSocket.readyState`; `none` means no socket object at all. */
export type OrderbookSocketState = 'none' | 'connecting' | 'open' | 'closing' | 'closed';

/**
 * Per-ticker book lifecycle. "Tracked" was one word for four different states,
 * which is why an 8h dead socket read as a provenance-shaped symptom.
 */
export type OrderbookBookState =
  /** Not in this stream's tracked set. */
  | 'untracked'
  /** Tracked, but this stream's provenance store no longer vouches for it. */
  | 'tracked-no-provenance'
  /** Tracked and provenanced, but no book object has arrived yet. */
  | 'subscribed-awaiting-snapshot'
  /** A snapshot exists but no qualifying sequenced delta under the current tracking revision. */
  | 'snapshot-quarantined'
  /** `getBook()` yields a book with a finite exchange timestamp and an integer sequence. */
  | 'sequenced';

export interface OrderbookBookStateSnapshot {
  state: OrderbookBookState;
  /** now - book.sequencedDeltaAt; null when no sequenced delta has ever landed. */
  sequencedAgeMs: number | null;
  /** now - book.receivedAt; null when no book object exists. */
  snapshotAgeMs: number | null;
}

export type OrderbookSupervisionAction =
  | 'none'
  | 'reconnect-silent'
  | 'reconnect-dead-socket'
  | 'reconnect-connect-timeout'
  | 'heartbeat-restarted'
  | 'stream-restarted'
  | 'invariant-violation';

export interface OrderbookSupervisionResult {
  action: OrderbookSupervisionAction;
  reason: string | null;
  /** Milliseconds until the supervisor will next attempt recovery, when one is pending. */
  nextAttemptInMs: number | null;
}

export interface KalshiOrderbookStreamTelemetry extends KalshiSocketHealthV2 {
  trackedTickers: number;
  booksWithExchangeTime: number;
  qualifiedTickers: number;
  reconnects: number;
  sequenceRegressions: number;
  sequenceGaps: number;
  quarantinedTickers: number;
  trackingReady: boolean;
  trackingRevision: number;
  acknowledgedTrackingRevision: number | null;
  serverTrackedTickers: number;
  verifiedTrackedTickers: number;
  membershipAcknowledged: boolean;
  lastSequencedDeltaAt: number | null;
  /** Last JSON application frame (subscribe/snapshot/delta/ok). Not protocol ping/pong. */
  lastApplicationMessageAt: number | null;
  lastCloseAt: number | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastCloseTrigger: string | null;
  subscriptionUpdates: number;
  subscriptionUpdateQueueDepth: number;
  subscriptionUpdateInFlight: boolean;
  socketState: OrderbookSocketState;
  /** A reconnect timer is armed. With socketState !== 'open' this is what proves recovery is owned. */
  reconnectScheduled: boolean;
  connectInFlight: boolean;
  supervisorEscalations: number;
  lastSupervisionAction: string | null;
  lastSupervisionAt: number | null;
}

/**
 * Definitive orderbook tracking evidence record. `trackingStateV2()` projects
 * the live telemetry into exactly this shape; the desktop runtime status
 * emits it verbatim, so runners and verifiers read one authoritative object.
 */
export interface OrderbookTrackingStateV2 {
  /** Configured production tracking target (25 in production). */
  requiredTickers: number;
  trackedTickers: number;
  verifiedTrackedTickers: number;
  serverTrackedTickers: number;
  qualifiedTickers: number;
  reconnects: number;
  sequenceGaps: number;
  sequenceRegressions: number;
  trackingRevision: number;
  acknowledgedTrackingRevision: number | null;
  membershipAcknowledged: boolean;
  subscriptionUpdateQueueDepth: number;
  subscriptionUpdateInFlight: boolean;
  trackingReady: boolean;
  qualificationReady: boolean;
  transportQualificationReady: boolean;
  authenticated: boolean;
  connected: boolean;
  lastSequencedDeltaAt: number | null;
  lastExchangeTimestamp: number | null;
  activeEndpoint: string | null;
  failedEndpoint: string | null;
  nextEndpoint: string | null;
  generation: number;
  attemptId: string | null;
  failureClass: KalshiTransportFailureClass | null;
  errorCode: string | null;
  httpStatus: number | null;
  nextRetryAt: number | null;
  switchReason: string | null;
  failureCounters: Readonly<Record<KalshiTransportFailureClass, number>>;
}

interface MutableBook {
  ticker: string;
  yes: Map<number, number>;
  no: Map<number, number>;
  sequence: number;
  sourceTimestamp?: number;
  receivedAt: number;
  sequencedDeltaAt?: number;
  snapshotTrackingRevision?: number;
  deltaTrackingRevision?: number;
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

interface InitialSubscriptionCommand {
  id: number;
  revision: number;
  marketTickers: string[];
}

interface PendingTransportFailure {
  generation: number;
  failure: KalshiTransportFailure;
}

function parseNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSequence(value: unknown): number | undefined {
  const parsed = parseNumber(value);
  return parsed != null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function internalPrice(price: number, side: 'yes' | 'no'): number {
  const normalized = side === 'no' ? 1 - price : price;
  return Math.round(normalized * 1_000_000_000) / 1_000_000_000;
}

function parseLevels(value: unknown, side: 'yes' | 'no'): Map<number, number> {
  const levels = new Map<number, number>();
  if (!Array.isArray(value)) return levels;
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = parseNumber(row[0]);
    const quantity = parseNumber(row[1]);
    if (price == null || quantity == null || price <= 0 || price >= 1 || quantity <= 0) continue;
    levels.set(internalPrice(price, side), quantity);
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
  private readonly snapshotRequestRevisionBySubscription = new Map<string, number>();
  private socket: WebSocket | null = null;
  private started = false;
  private commandId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private reconnects = 0;
  private sequenceRegressions = 0;
  private sequenceGaps = 0;
  private authenticated = false;
  private connectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastApplicationMessageAt: number | null = null;
  private lastPongAt: number | null = null;
  private lastSequencedDeltaAt: number | null = null;
  private lastExchangeTimestamp: number | null = null;
  private lastCloseAt: number | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;
  private lastCloseTrigger: string | null = null;
  private pendingCloseTrigger: string | null = null;
  private pendingTransportFailure: PendingTransportFailure | null = null;
  private subscriptionUpdates = 0;
  private readonly subscriptionUpdateQueue: SubscriptionUpdateCommand[] = [];
  private pendingSubscriptionUpdate: PendingSubscriptionUpdate | null = null;
  private initialSubscriptionCommand: InitialSubscriptionCommand | null = null;
  private connectAttemptStartedAt: number | null = null;
  private supervisorBackoffMs = ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS;
  private supervisorNextAttemptAt: number | null = null;
  private supervisedAttemptPending = false;
  private supervisedAttemptFailures = 0;
  private supervisorEscalations = 0;
  private supervisionInvariantReported = false;
  private lastSupervisionAction: string | null = null;
  private lastSupervisionAt: number | null = null;
  private trackingRevision = 0;
  private acknowledgedTrackingRevision: number | null = null;
  private readonly bookUpdateListeners = new Set<BookUpdateListener>();
  private readonly transportController: KalshiProductionConnectionController;

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly headers: KalshiWebSocketHeaderProvider,
    private readonly environment: KalshiEnvironment = 'production',
    private readonly maxTrackedTickers = DEFAULT_MAX_TRACKED_TICKERS,
    private readonly marketProvenance = new ProductionMarketProvenanceStore(),
  ) {
    this.transportController = new KalshiProductionConnectionController(
      environment,
      getKalshiEndpointPolicy(environment).websocketUrls,
      { attemptPrefix: 'kalshi-orderbook-ws' },
    );
  }

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
    this.snapshotRequestRevisionBySubscription.clear();
    this.subscriptionUpdateQueue.length = 0;
    this.pendingSubscriptionUpdate = null;
    this.initialSubscriptionCommand = null;
    this.acknowledgedTrackingRevision = null;
    this.closeCurrentSocket();
    if (this.started) this.connect();
  }

  /**
   * Back-compat wrapper for the desktop health tick. True iff supervision
   * actually attempted a new connection this call.
   */
  recoverIfDataPlaneSilent(now = Date.now()): boolean {
    const { action } = this.superviseDataPlane(now);
    return action === 'reconnect-silent'
      || action === 'reconnect-dead-socket'
      || action === 'reconnect-connect-timeout'
      || action === 'stream-restarted';
  }

  socketState(): OrderbookSocketState {
    const socket = this.socket;
    if (!socket) return 'none';
    if (socket.readyState === WebSocket.CONNECTING) return 'connecting';
    if (socket.readyState === WebSocket.OPEN) return 'open';
    if (socket.readyState === WebSocket.CLOSING) return 'closing';
    return 'closed';
  }

  /**
   * Where one ticker actually is in the book lifecycle. Deliberately derived
   * from `getBook`, so `sequenced` can never mean anything weaker than the
   * exchange-origin evidence `getBook` already enforces.
   */
  bookState(ticker: string, now = Date.now()): OrderbookBookStateSnapshot {
    const book = this.books.get(ticker);
    const snapshotAgeMs = book ? now - book.receivedAt : null;
    const sequencedAgeMs = book?.sequencedDeltaAt != null ? now - book.sequencedDeltaAt : null;
    const at = (state: OrderbookBookState): OrderbookBookStateSnapshot => ({ state, sequencedAgeMs, snapshotAgeMs });
    if (!this.tickers.has(ticker)) return at('untracked');
    if (!this.marketProvenance.has(ticker, now)) return at('tracked-no-provenance');
    if (!book) return at('subscribed-awaiting-snapshot');
    const delivered = this.getBook(ticker, now);
    const sequenced = delivered != null
      && delivered.sourceTimestamp != null
      && Number.isFinite(delivered.sourceTimestamp)
      && Number.isInteger(delivered.sequence);
    return at(sequenced ? 'sequenced' : 'snapshot-quarantined');
  }

  /**
   * The stream's own outside owner. Everything inside the socket dies with the
   * socket, so recovery has to be driven from here: on 2026-07-26 a sticky
   * close left `socket === null`, the heartbeat cleared, and no reconnect timer
   * armed — an absorbing dead state that ran for 7.9h.
   */
  superviseDataPlane(now = Date.now()): OrderbookSupervisionResult {
    if (!this.started) return { action: 'none', reason: null, nextAttemptInMs: null };
    const state = this.socketState();

    // 1. OPEN but application-silent with live membership: pre-existing 3158ef9
    //    behavior, unchanged.
    if (state === 'open' && this.tickers.size > 0) {
      const dataReferenceAt = this.lastApplicationMessageAt ?? this.connectedAt;
      if (dataReferenceAt == null || now - dataReferenceAt > DATA_PLANE_SILENCE_MS) {
        const reason = `application silence for ${dataReferenceAt == null ? 'unknown' : now - dataReferenceAt}ms on an open socket`;
        const escalate = this.noteSupervisedAttempt();
        this.scheduleSupervisorBackoff(now);
        if (escalate) return this.restartStreamAfterEscalation(now, reason);
        const waitMs = this.forceLocalReconnect(
          this.generation,
          createKalshiTransportFailure('timeout', 'order-book websocket data-plane silence'),
          'local_data_plane_silence',
        );
        return this.checkSupervisionInvariant(now, this.finishSupervision(now, 'reconnect-silent', reason, waitMs));
      }
    }

    // 2. OPEN with no heartbeat handle: closeCurrentSocket clears the interval,
    //    so a stale-generation race can leave an OPEN socket unpinged forever.
    if (state === 'open' && this.heartbeatTimer == null && this.socket) {
      this.registry.recordWarn('kalshi-orderbook-ws', 'order-book heartbeat interval missing on an open socket; restarting it');
      this.startHeartbeat(this.socket, this.generation);
      return this.finishSupervision(now, 'heartbeat-restarted', 'open socket had no heartbeat interval', null);
    }

    // 3. Stuck in CONNECTING: no `open`, no `close`, nothing else can time it out.
    if (state === 'connecting') {
      const startedAt = this.connectAttemptStartedAt;
      if (startedAt == null || now - startedAt <= ORDERBOOK_CONNECT_DEADLINE_MS) {
        return { action: 'none', reason: 'connect in flight', nextAttemptInMs: null };
      }
      const reason = `connect attempt exceeded ${ORDERBOOK_CONNECT_DEADLINE_MS}ms`;
      return this.attemptSupervisedConnect(now, 'reconnect-connect-timeout', reason, true);
    }

    // 4. No live socket and nobody armed to bring one back. Membership is
    //    deliberately not required: an empty tracked set still needs a socket.
    if (state !== 'open' && this.reconnectTimer == null) {
      const dueAt = this.supervisorNextAttemptAt;
      if (dueAt != null && now < dueAt) {
        return this.checkSupervisionInvariant(now, {
          action: 'none',
          reason: 'supervisor backoff pending',
          nextAttemptInMs: dueAt - now,
        });
      }
      return this.attemptSupervisedConnect(now, 'reconnect-dead-socket', `socket state ${state} with no reconnect armed`, false);
    }

    return this.checkSupervisionInvariant(now, { action: 'none', reason: null, nextAttemptInMs: null });
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.resetSupervisorBackoff();
    this.closeCurrentSocket();
  }

  recordProductionMarkets(
    markets: KalshiMarket[],
    sourceBaseUrl: string,
    verifiedAt = Date.now(),
  ): ProductionMarketProvenance[] {
    return this.marketProvenance.recordMany(markets, {
      environment: this.environment,
      sourceBaseUrl,
      verifiedAt,
    });
  }

  track(tickers: string[], now = Date.now()): void {
    const before = this.tickers.size;
    for (const ticker of this.marketProvenance.selectVerified(tickers, this.maxTrackedTickers, now)) {
      if (this.tickers.has(ticker) || this.tickers.size >= this.maxTrackedTickers) continue;
      this.tickers.add(ticker);
    }
    if (this.tickers.size !== before) this.markTrackingChanged();
    this.subscribeMissing();
  }

  /** Replaces the bounded live-book working set without accumulating stale thesis tickers. */
  replaceTracked(tickers: string[], now = Date.now()): void {
    const desired = new Set(this.marketProvenance.selectVerified(tickers, this.maxTrackedTickers, now));
    if (desired.size === this.tickers.size && [...desired].every((ticker) => this.tickers.has(ticker))) return;
    const removed = [...this.tickers].filter((ticker) => !desired.has(ticker));
    this.tickers.clear();
    for (const ticker of desired) this.tickers.add(ticker);
    for (const ticker of removed) {
      this.books.delete(ticker);
      this.quarantined.delete(ticker);
    }
    this.markTrackingChanged();
    this.subscribeMissing();
  }

  /**
   * Whether this stream's own provenance store currently vouches for the ticker.
   * `track`/`replaceTracked` silently drop anything this rejects, so a caller
   * that adds a ticker and never sees a book needs to distinguish "subscription
   * is still warming up" from "the ticker was never admitted at all".
   */
  hasProductionProvenance(ticker: string, now = Date.now()): boolean {
    return this.marketProvenance.has(ticker, now);
  }

  isTracked(ticker: string): boolean {
    return this.tickers.has(ticker);
  }

  onBookUpdate(listener: BookUpdateListener): () => void {
    this.bookUpdateListeners.add(listener);
    return () => this.bookUpdateListeners.delete(listener);
  }

  getBook(ticker: string, now = Date.now()): KalshiOrderbook | null {
    if (this.quarantined.has(ticker) || !this.marketProvenance.has(ticker, now)) return null;
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
    const socketState = this.socketState();
    const connected = socketState === 'open';
    const verifiedTrackedTickers = [...this.tickers]
      .filter((ticker) => this.marketProvenance.has(ticker, now)).length;
    const qualifiedTickers = [...this.books.values()].filter((book) => {
      if (this.quarantined.has(book.ticker)
        || !this.tickers.has(book.ticker)
        || !this.marketProvenance.has(book.ticker, now)
        || book.sourceTimestamp == null
        || book.sequencedDeltaAt == null
        || book.snapshotTrackingRevision !== this.trackingRevision
        || book.deltaTrackingRevision !== this.trackingRevision) return false;
      const receiveAgeMs = now - book.sequencedDeltaAt;
      const exchangeAgeMs = now - book.sourceTimestamp;
      return receiveAgeMs >= 0
        && receiveAgeMs <= DEAD_CONNECTION_MS
        && exchangeAgeMs >= 0
        && exchangeAgeMs <= MAX_QUALIFICATION_EXCHANGE_AGE_MS;
    }).length;
    const membershipAcknowledged = this.acknowledgedTrackingRevision === this.trackingRevision
      && this.initialSubscriptionCommand == null
      && this.pendingSubscriptionUpdate == null
      && this.subscriptionUpdateQueue.length === 0
      && this.subscribed.size === this.tickers.size
      && [...this.tickers].every((ticker) => this.subscribed.has(ticker));
    // Qualification requires exactly the configured production target of
    // current production REST proofs (25 in production) and an acknowledgement
    // for the same immutable membership revision.
    const trackingReady = this.tickers.size === this.maxTrackedTickers
      && verifiedTrackedTickers === this.maxTrackedTickers
      && membershipAcknowledged;
    const pongFresh = this.lastPongAt != null
      && now - this.lastPongAt >= 0
      && now - this.lastPongAt <= DEAD_CONNECTION_MS;
    const qualificationReady = connected
      && this.authenticated
      && pongFresh
      && trackingReady
      && qualifiedTickers > 0;
    // Transport liveness alone: is this socket up and healthy. Deliberately
    // excludes qualifiedTickers (books that produced exchange data inside the
    // liveness window -- a property of whether markets are trading) and also
    // trackingReady, because membershipAcknowledged goes false while a routine
    // membership update is in flight. Both would make a healthy feed flap.
    // Membership correctness is still asserted directly and strictly, by the
    // orderbook_tracked/verified/server/membership conditions in the readiness
    // runner and by the cutoff checks in the soak runner.
    // Pong-or-traffic, since lastPongAt is null on every fresh connection.
    const livenessAt = Math.max(this.lastPongAt ?? 0, this.lastMessageAt ?? 0, this.connectedAt ?? 0);
    const transportQualificationReady = connected
      && this.authenticated
      && livenessAt > 0
      && now - livenessAt <= DEAD_CONNECTION_MS
      && this.transportController.transportQualificationReady();
    const transport = this.transportController.telemetry();
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
      subscriptionAcknowledged: membershipAcknowledged,
      trackingReady,
      qualificationReady,
      transportQualificationReady,
      trackingRevision: this.trackingRevision,
      acknowledgedTrackingRevision: this.acknowledgedTrackingRevision,
      serverTrackedTickers: this.subscribed.size,
      verifiedTrackedTickers,
      membershipAcknowledged,
      generation: this.generation,
      lastPongAt: this.lastPongAt,
      lastMessageAt: this.lastMessageAt,
      lastApplicationMessageAt: this.lastApplicationMessageAt,
      lastSequencedDeltaAt: this.lastSequencedDeltaAt,
      lastExchangeTimestamp: this.lastExchangeTimestamp,
      lastCloseAt: this.lastCloseAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      lastCloseTrigger: this.lastCloseTrigger,
      subscriptionUpdates: this.subscriptionUpdates,
      subscriptionUpdateQueueDepth: this.subscriptionUpdateQueue.length,
      subscriptionUpdateInFlight: this.initialSubscriptionCommand != null || this.pendingSubscriptionUpdate != null,
      socketState,
      reconnectScheduled: this.reconnectTimer != null,
      connectInFlight: socketState === 'connecting',
      supervisorEscalations: this.supervisorEscalations,
      lastSupervisionAction: this.lastSupervisionAction,
      lastSupervisionAt: this.lastSupervisionAt,
      endpointUrl: this.currentEndpointUrl(),
      activeEndpoint: transport.activeEndpoint,
      failedEndpoint: transport.failedEndpoint,
      nextEndpoint: transport.nextEndpoint,
      environment: this.environment,
      attemptId: transport.attemptId,
      failureClass: transport.failureClass,
      errorCode: transport.errorCode,
      httpStatus: transport.httpStatus,
      nextRetryAt: transport.nextRetryAt,
      switchReason: transport.switchReason,
      lastExchangeDataAt: transport.lastExchangeDataAt,
      failureCounters: transport.counters,
    };
  }

  trackingStateV2(now = Date.now()): OrderbookTrackingStateV2 {
    const telemetry = this.telemetry(now);
    return {
      requiredTickers: this.maxTrackedTickers,
      trackedTickers: telemetry.trackedTickers,
      verifiedTrackedTickers: telemetry.verifiedTrackedTickers,
      serverTrackedTickers: telemetry.serverTrackedTickers,
      qualifiedTickers: telemetry.qualifiedTickers,
      reconnects: telemetry.reconnects,
      sequenceGaps: telemetry.sequenceGaps,
      sequenceRegressions: telemetry.sequenceRegressions,
      trackingRevision: telemetry.trackingRevision,
      acknowledgedTrackingRevision: telemetry.acknowledgedTrackingRevision,
      membershipAcknowledged: telemetry.membershipAcknowledged,
      subscriptionUpdateQueueDepth: telemetry.subscriptionUpdateQueueDepth,
      subscriptionUpdateInFlight: telemetry.subscriptionUpdateInFlight,
      trackingReady: telemetry.trackingReady,
      qualificationReady: telemetry.qualificationReady,
      transportQualificationReady: telemetry.transportQualificationReady,
      authenticated: telemetry.authenticated,
      connected: telemetry.connected,
      lastSequencedDeltaAt: telemetry.lastSequencedDeltaAt,
      lastExchangeTimestamp: telemetry.lastExchangeTimestamp,
      activeEndpoint: telemetry.activeEndpoint,
      failedEndpoint: telemetry.failedEndpoint,
      nextEndpoint: telemetry.nextEndpoint,
      generation: telemetry.generation,
      attemptId: telemetry.attemptId,
      failureClass: telemetry.failureClass,
      errorCode: telemetry.errorCode,
      httpStatus: telemetry.httpStatus,
      nextRetryAt: telemetry.nextRetryAt,
      switchReason: telemetry.switchReason,
      failureCounters: telemetry.failureCounters,
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
    const attempt = this.transportController.beginAttempt();
    if (!attempt) {
      // Telemetry-only: synthesizing a transport failure without a generation
      // would corrupt the controller's generation-gated accounting.
      this.authenticated = false;
      this.registry.recordTelemetry('kalshi-orderbook-ws', {
        status: 'error',
        lastError: 'no websocket endpoint in selected Kalshi environment policy',
        authenticated: false,
        transportConnected: false,
        trackingReady: false,
        qualificationReady: false,
        environment: this.environment,
      });
      return;
    }
    const { generation, endpoint: endpointUrl } = attempt;
    this.generation = generation;
    const socket = new WebSocket(endpointUrl, { headers });
    this.socket = socket;
    // Owned by the supervisor: a socket that never leaves CONNECTING fires
    // neither `open` nor `close`, so only an external deadline can reap it.
    this.connectAttemptStartedAt = Date.now();
    socket.on('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.connectAttemptStartedAt = null;
      this.authenticated = true;
      this.subscribed.clear();
      this.books.clear();
      this.sequenceBySubscription.clear();
      this.tickersBySubscription.clear();
      this.subscriptionIdByKey.clear();
      this.pendingSnapshotRepair.clear();
      this.snapshotRequestRevisionBySubscription.clear();
      this.subscriptionUpdateQueue.length = 0;
      this.pendingSubscriptionUpdate = null;
      this.initialSubscriptionCommand = null;
      this.acknowledgedTrackingRevision = null;
      this.pendingCloseTrigger = null;
      this.pendingTransportFailure = null;
      this.lastSequencedDeltaAt = null;
      for (const ticker of this.tickers) this.quarantined.add(ticker);
      this.connectedAt = Date.now();
      this.lastMessageAt = this.connectedAt;
      this.lastApplicationMessageAt = this.connectedAt;
      this.lastPongAt = null;
      this.startHeartbeat(socket, generation);
      this.recordHealth();
      this.subscribeMissing();
    });
    socket.on('message', (raw) => {
      if (this.isCurrent(socket, generation)) this.ingest(String(raw), generation);
    });
    socket.on('ping', () => {
      // Protocol ping proves the control plane only — do NOT treat it as
      // orderbook application traffic (that masked multi-hour OB freezes).
      if (!this.isCurrent(socket, generation)) return;
      this.lastMessageAt = Date.now();
      this.recordHealth();
    });
    socket.on('pong', () => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastPongAt = Date.now();
      this.transportController.recordPong(generation);
      this.recordHealth();
    });
    socket.on('error', (error) => {
      if (!this.isCurrent(socket, generation)) return;
      const failure = classifyKalshiWebSocketError(error);
      this.pendingTransportFailure = { generation, failure };
      this.pendingCloseTrigger = `socket_error:${failure.classification}`;
      socket.close();
    });
    socket.on('unexpected-response', (_request, response) => {
      if (!this.isCurrent(socket, generation)) return;
      response.resume();
      this.restartAfterFailure(generation, classifyKalshiWebSocketError({
        statusCode: response.statusCode,
        message: `websocket handshake returned HTTP ${response.statusCode}`,
      }));
    });
    socket.on('close', (code, reason) => this.handleSocketClose(socket, generation, code, reason));
  }

  /**
   * Extracted from the `close` listener so recovery tests can drive the real
   * close path (including its non-retryable dead end) without a live socket.
   */
  private handleSocketClose(socket: WebSocket, generation: number, code: number, reason: Buffer): void {
    if (!this.isCurrent(socket, generation)) return;
    this.lastCloseAt = Date.now();
    this.lastCloseCode = code;
    this.lastCloseTrigger = this.pendingCloseTrigger ?? 'remote_close_without_reason';
    const rawReason = reason.toString('utf8') || null;
    const failure = this.pendingTransportFailure?.generation === generation
      ? this.pendingTransportFailure.failure
      : classifyKalshiWebSocketClose(code, rawReason, !this.started);
    this.lastCloseReason = failure.closeReason ?? (rawReason ? failure.detail : this.lastCloseTrigger);
    const retry = this.transportController.recordFailure(generation, failure);
    const transportTelemetry = this.transportController.telemetry();
    this.pendingCloseTrigger = null;
    this.pendingTransportFailure = null;
    this.socket = null;
    this.connectAttemptStartedAt = null;
    this.authenticated = false;
    this.connectedAt = null;
    this.clearHeartbeatTimer();
    this.subscribed.clear();
    this.subscriptionUpdateQueue.length = 0;
    this.pendingSubscriptionUpdate = null;
    // A non-retryable decision here used to be terminal. It is now merely
    // "unscheduled": superviseDataPlane owns recovery from this state.
    if (!this.started || !retry.retry) return;
    this.reconnects += 1;
    this.registry.recordTelemetry('kalshi-orderbook-ws', {
      status: 'warn',
      lastError: 'order-book stream disconnected; reconnect scheduled',
      reconnects: this.reconnects,
      transportConnected: false,
      authenticated: false,
      qualificationReady: false,
      endpointUrl: transportTelemetry.failedEndpoint,
      lastCloseAt: this.lastCloseAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      lastCloseTrigger: this.lastCloseTrigger,
    });
    const waitMs = retry.delayMs ?? 0;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, waitMs);
  }

  private subscribeMissing(): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const subscriptionEntry = [...this.subscriptionIdByKey.entries()][0];
    if (!subscriptionEntry) {
      if (this.initialSubscriptionCommand || this.tickers.size === 0) return;
      const initial = [...this.tickers];
      const id = this.commandId++;
      try {
        socket.send(JSON.stringify({
          id,
          cmd: 'subscribe',
          params: {
            channels: ['orderbook_delta'],
            market_tickers: initial,
            use_yes_price: true,
          },
        }));
      } catch {
        this.setPendingFailure(this.generation, createKalshiTransportFailure('tcp', 'initial subscription send failed'), 'initial_subscription_send_failed');
        socket.close();
        return;
      }
      this.initialSubscriptionCommand = {
        id,
        revision: this.trackingRevision,
        marketTickers: initial,
      };
      return;
    }

    if (this.initialSubscriptionCommand || this.pendingSubscriptionUpdate || this.subscriptionUpdateQueue.length > 0) return;
    const [subscription, sid] = subscriptionEntry;
    const removed = [...this.subscribed].filter((ticker) => !this.tickers.has(ticker));
    const added = [...this.tickers].filter((ticker) => !this.subscribed.has(ticker));
    this.enqueueSubscriptionUpdate({ sid, marketTickers: removed, action: 'delete_markets' });
    this.enqueueSubscriptionUpdate({ sid, marketTickers: added, action: 'add_markets' });
    if (removed.length === 0 && added.length === 0) this.acknowledgeMembershipAndRequestSnapshots(subscription, sid);
  }

  /** Ingests one official WebSocket packet; public to support deterministic replay tests. */
  ingest(raw: string, generation = this.generation): void {
    if (generation !== this.generation) return;
    const receivedAt = Date.now();
    this.lastMessageAt = receivedAt;
    this.lastApplicationMessageAt = receivedAt;
    // An application frame is the only proof a supervised attempt actually
    // restored the data plane; `open` alone has produced silent zombies.
    this.resetSupervisorBackoff();
    try {
      const packet = JSON.parse(raw) as Record<string, unknown>;
      const type = String(packet.type ?? '');
      const msg = packet.msg && typeof packet.msg === 'object' ? packet.msg as Record<string, unknown> : null;
      const packetCommandId = parseNumber(packet.id);
      const acknowledgesPendingUpdate = type === 'ok'
        && packetCommandId != null
        && packetCommandId === this.pendingSubscriptionUpdate?.id;
      const rejectsInitialSubscription = type === 'error'
        && packetCommandId != null
        && packetCommandId === this.initialSubscriptionCommand?.id;
      if (rejectsInitialSubscription) {
        const errorMessage = String((msg as { msg?: unknown } | null)?.msg ?? 'initial subscription failed');
        this.initialSubscriptionCommand = null;
        const failure = createKalshiTransportFailure('protocol', errorMessage);
        this.registry.recordWarn('kalshi-orderbook-ws', failure.detail);
        this.setPendingFailure(generation, failure, 'initial_subscription_error');
        this.socket?.close();
        return;
      }
      if (type === 'error' && packetCommandId != null && packetCommandId === this.pendingSubscriptionUpdate?.id) {
        const errorMessage = String((msg as { msg?: unknown } | null)?.msg ?? 'subscription update failed');
        this.pendingSubscriptionUpdate = null;
        this.subscriptionUpdateQueue.length = 0;
        const failure = createKalshiTransportFailure('protocol', errorMessage);
        this.registry.recordWarn('kalshi-orderbook-ws', failure.detail);
        this.setPendingFailure(generation, failure, 'subscription_update_error');
        this.socket?.close();
        return;
      }
      if (type === 'subscribed') {
        const subscribedSid = parseSequence(msg?.sid ?? packet.sid);
        if (subscribedSid != null) {
          const subscription = String(subscribedSid);
          this.subscriptionIdByKey.set(subscription, subscribedSid);
          const initial = this.initialSubscriptionCommand;
          if (initial && (packetCommandId == null || packetCommandId === initial.id)) {
            this.subscribed.clear();
            for (const ticker of initial.marketTickers) this.subscribed.add(ticker);
            this.tickersBySubscription.set(subscription, new Set(initial.marketTickers));
            this.initialSubscriptionCommand = null;
            this.transportController.recordSubscriptionAck(generation);
          }
          this.subscribeMissing();
        }
        this.recordHealth();
        return;
      }
      const sequence = parseSequence(packet.seq);
      if (sequence == null) {
        if (acknowledgesPendingUpdate) {
          this.registry.recordWarn('kalshi-orderbook-ws', 'subscription update acknowledgement lacked a sequence');
          this.setPendingFailure(generation, createKalshiTransportFailure('protocol', 'subscription update acknowledgement lacked a valid sequence'), 'subscription_update_ack_missing_sequence');
          this.socket?.close();
          return;
        }
        if (type === 'error') {
          const detail = String((msg as { msg?: unknown } | null)?.msg ?? 'unsolicited subscription error');
          this.registry.recordWarn('kalshi-orderbook-ws', detail);
          this.setPendingFailure(generation, createKalshiTransportFailure('protocol', detail), 'unsolicited_protocol_error');
          this.socket?.close();
        }
        return;
      }
      const numericSubscriptionId = parseSequence(packet.sid);
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
          this.setPendingFailure(generation, createKalshiTransportFailure('sequence', 'subscription update acknowledgement broke sequence continuity'), 'subscription_update_ack_sequence_gap');
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
      if (acknowledgesPendingUpdate) this.completePendingSubscriptionUpdate(subscription);
      if (this.started && ticker && !this.tickers.has(ticker)) {
        this.books.delete(ticker);
        this.quarantined.delete(ticker);
        this.recordHealth();
        return;
      }
      if (!ticker || !msg) {
        if (type === 'error') {
          const detail = String((msg as { msg?: unknown } | null)?.msg ?? 'unsolicited subscription error');
          this.registry.recordWarn('kalshi-orderbook-ws', detail);
          this.setPendingFailure(generation, createKalshiTransportFailure('protocol', detail), 'unsolicited_protocol_error');
          this.socket?.close();
          return;
        }
        this.recordHealth();
        if (acknowledgesPendingUpdate) {
          this.pumpSubscriptionUpdates();
          this.subscribeMissing();
        }
        return;
      }
      if (type === 'orderbook_snapshot') this.applySnapshot(subscription, ticker, sequence, msg);
      else if (type === 'orderbook_delta') {
        this.applyDelta(ticker, sequence, msg);
        const book = this.getBook(ticker, Date.now());
        if (book?.sourceTimestamp != null) {
          for (const listener of this.bookUpdateListeners) listener(book);
        }
      }
      else return;
      this.recordHealth();
      if (acknowledgesPendingUpdate) {
        this.pumpSubscriptionUpdates();
        this.subscribeMissing();
      }
    } catch {
      this.registry.recordWarn('kalshi-ws', 'malformed order-book stream message');
      this.setPendingFailure(generation, createKalshiTransportFailure('protocol', 'malformed order-book stream message'), 'malformed_protocol_message');
      this.socket?.close();
    }
  }

  private applySnapshot(subscription: string, ticker: string, sequence: number, msg: Record<string, unknown>): void {
    const yes = parseLevels(msg.yes_dollars_fp ?? msg.yes_dollars ?? msg.yes, 'yes');
    const no = parseLevels(msg.no_dollars_fp ?? msg.no_dollars ?? msg.no, 'no');
    const snapshotTrackingRevision = !this.started || this.acknowledgedTrackingRevision === this.trackingRevision
      ? this.trackingRevision
      : undefined;
    this.books.set(ticker, {
      ticker,
      yes,
      no,
      sequence,
      receivedAt: Date.now(),
      snapshotTrackingRevision,
    });
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
    const receivedAt = Date.now();
    if (!side || price == null || price <= 0 || price >= 1 || delta == null || timestamp == null
      || !this.isValidExchangeTimestamp(timestamp, receivedAt)) {
      this.quarantined.add(ticker);
      return;
    }
    const levels = book[side];
    const normalizedPrice = internalPrice(price, side);
    const next = (levels.get(normalizedPrice) ?? 0) + delta;
    if (next <= 0) levels.delete(normalizedPrice);
    else levels.set(normalizedPrice, next);
    book.sequence = sequence;
    book.sourceTimestamp = timestamp;
    book.receivedAt = receivedAt;
    this.lastSequencedDeltaAt = book.receivedAt;
    book.sequencedDeltaAt = book.receivedAt;
    book.deltaTrackingRevision = book.snapshotTrackingRevision === this.trackingRevision
      && (!this.started || this.acknowledgedTrackingRevision === this.trackingRevision)
      ? this.trackingRevision
      : undefined;
    this.lastExchangeTimestamp = timestamp;
    if (book.deltaTrackingRevision === this.trackingRevision) {
      this.quarantined.delete(ticker);
      this.transportController.recordExchangeData(this.generation, timestamp);
    }
  }

  private markTrackingChanged(): void {
    this.trackingRevision += 1;
    this.acknowledgedTrackingRevision = null;
    this.snapshotRequestRevisionBySubscription.clear();
    for (const ticker of this.tickers) {
      this.books.delete(ticker);
      this.quarantined.add(ticker);
    }
  }

  private completePendingSubscriptionUpdate(subscription: string): void {
    const pending = this.pendingSubscriptionUpdate;
    if (!pending) return;
    const subscriptionTickers = this.tickersBySubscription.get(subscription) ?? new Set<string>();
    if (pending.action === 'delete_markets') {
      for (const ticker of pending.marketTickers) {
        this.subscribed.delete(ticker);
        subscriptionTickers.delete(ticker);
      }
    } else if (pending.action === 'add_markets') {
      for (const ticker of pending.marketTickers) {
        this.subscribed.add(ticker);
        subscriptionTickers.add(ticker);
        this.quarantined.add(ticker);
      }
    }
    this.tickersBySubscription.set(subscription, subscriptionTickers);
    this.pendingSubscriptionUpdate = null;
  }

  private acknowledgeMembershipAndRequestSnapshots(subscription: string, sid: number): void {
    const membershipMatches = this.subscribed.size === this.tickers.size
      && [...this.tickers].every((ticker) => this.subscribed.has(ticker));
    if (!membershipMatches || this.pendingSubscriptionUpdate || this.subscriptionUpdateQueue.length > 0) return;
    if (this.acknowledgedTrackingRevision === this.trackingRevision) return;
    this.acknowledgedTrackingRevision = this.trackingRevision;
    if (this.snapshotRequestRevisionBySubscription.get(subscription) === this.trackingRevision) return;
    this.snapshotRequestRevisionBySubscription.set(subscription, this.trackingRevision);
    const affected = [...this.tickers].sort();
    this.pendingSnapshotRepair.set(subscription, new Set(affected));
    for (const ticker of affected) {
      this.books.delete(ticker);
      this.quarantined.add(ticker);
    }
    this.enqueueSubscriptionUpdate({ sid, marketTickers: affected, action: 'get_snapshot' });
  }

  private isValidExchangeTimestamp(timestamp: number, now: number): boolean {
    return Number.isSafeInteger(timestamp)
      && timestamp >= MIN_MILLISECOND_TIMESTAMP
      && timestamp <= now + MAX_EXCHANGE_FUTURE_SKEW_MS;
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
      const pongReferenceAt = this.lastPongAt ?? this.connectedAt;
      if (pongReferenceAt == null || now - pongReferenceAt > DEAD_CONNECTION_MS) {
        this.forceLocalReconnect(
          generation,
          createKalshiTransportFailure('timeout', 'order-book websocket pong expired'),
          'local_pong_expired',
        );
        return;
      }
      // Data-plane silence while membership is non-empty: pongs / protocol
      // pings alone are not proof that orderbook_delta traffic still flows.
      if (this.tickers.size > 0) {
        const dataReferenceAt = this.lastApplicationMessageAt ?? this.connectedAt;
        if (dataReferenceAt == null || now - dataReferenceAt > DATA_PLANE_SILENCE_MS) {
          this.forceLocalReconnect(
            generation,
            createKalshiTransportFailure('timeout', 'order-book websocket data-plane silence'),
            'local_data_plane_silence',
          );
          return;
        }
      }
      socket.ping();
    }, PING_INTERVAL_MS);
  }

  /**
   * Local watchdog kill: tear down the socket and *always* schedule reconnect
   * when started. Do not rely on the WebSocket `close` event — terminate/close
   * alone has left zombie OPEN sockets without reconnect on Electron/Windows.
   */
  private forceLocalReconnect(generation: number, failure: KalshiTransportFailure, trigger: string): number | null {
    if (generation !== this.generation) return null;
    this.lastCloseAt = Date.now();
    this.lastCloseTrigger = trigger;
    this.lastCloseReason = failure.detail;
    this.lastCloseCode = null;
    this.pendingCloseTrigger = null;
    this.pendingTransportFailure = null;
    // Best-effort controller accounting; local recovery still reconnects if the
    // controller rejects a stale/missing attempt id (unit tests / races).
    const decision = this.transportController.recordFailure(generation, failure);
    this.closeCurrentSocket();
    this.recordHealth();
    if (!this.started) return null;
    this.reconnects += 1;
    const waitMs = decision.retry && decision.delayMs != null ? decision.delayMs : 0;
    this.registry.recordWarn(
      'kalshi-orderbook-ws',
      `order-book websocket ${trigger}; forcing reconnect+resubscribe in ${waitMs}ms (reconnects=${this.reconnects})`,
    );
    this.registry.recordTelemetry('kalshi-orderbook-ws', {
      status: 'warn',
      lastError: `order-book stream ${trigger}; reconnect scheduled`,
      reconnects: this.reconnects,
      transportConnected: false,
      authenticated: false,
      qualificationReady: false,
      lastCloseAt: this.lastCloseAt,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      lastCloseTrigger: this.lastCloseTrigger,
      lastMessageAt: this.lastApplicationMessageAt,
    });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, waitMs);
    return waitMs;
  }

  /**
   * Counts one supervised recovery attempt. Returns true when the previous
   * attempts never reached open + first application frame often enough that a
   * full stream rebuild is warranted.
   */
  private noteSupervisedAttempt(): boolean {
    if (this.supervisedAttemptPending) this.supervisedAttemptFailures += 1;
    this.supervisedAttemptPending = true;
    this.supervisionInvariantReported = false;
    return this.supervisedAttemptFailures >= ORDERBOOK_SUPERVISOR_MAX_ESCALATIONS;
  }

  /** Arms the supervisor's own backoff. Returns the delay until the next attempt. */
  private scheduleSupervisorBackoff(now: number): number {
    const failureClass = this.transportController.telemetry().failureClass;
    if (failureClass != null && SUPERVISOR_STICKY_FAILURE_CLASSES.has(failureClass)) {
      this.supervisorBackoffMs = ORDERBOOK_SUPERVISOR_MAX_BACKOFF_MS;
      this.registry.recordWarn(
        'kalshi-orderbook-ws',
        `order-book websocket sticky ${failureClass} failure; capping supervised retry at ${ORDERBOOK_SUPERVISOR_MAX_BACKOFF_MS}ms and continuing to retry`,
      );
    }
    const backoffMs = this.supervisorBackoffMs;
    this.supervisorNextAttemptAt = now + backoffMs;
    this.supervisorBackoffMs = Math.min(ORDERBOOK_SUPERVISOR_MAX_BACKOFF_MS, backoffMs * 2);
    return backoffMs;
  }

  private resetSupervisorBackoff(): void {
    this.supervisorBackoffMs = ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS;
    this.supervisorNextAttemptAt = null;
    this.supervisedAttemptPending = false;
    this.supervisedAttemptFailures = 0;
    this.supervisionInvariantReported = false;
  }

  private attemptSupervisedConnect(
    now: number,
    action: OrderbookSupervisionAction,
    reason: string,
    tearDownFirst: boolean,
  ): OrderbookSupervisionResult {
    const escalate = this.noteSupervisedAttempt();
    const backoffMs = this.scheduleSupervisorBackoff(now);
    if (tearDownFirst) {
      this.closeCurrentSocket();
      this.recordHealth();
    }
    if (escalate) return this.restartStreamAfterEscalation(now, reason);
    this.registry.recordWarn(
      'kalshi-orderbook-ws',
      `order-book data-plane supervisor reconnecting (${action}): ${reason}; next supervised attempt in ${backoffMs}ms`,
    );
    this.connect();
    return this.checkSupervisionInvariant(now, this.finishSupervision(now, action, reason, backoffMs));
  }

  /**
   * Bounded last resort: rebuild the stream from scratch (stop() then start()
   * semantics) when repeated supervised reconnects never produced a frame.
   */
  private restartStreamAfterEscalation(now: number, reason: string): OrderbookSupervisionResult {
    this.supervisedAttemptFailures = 0;
    this.registry.recordWarn(
      'kalshi-orderbook-ws',
      `order-book data-plane supervisor escalating to a full stream restart after ${ORDERBOOK_SUPERVISOR_MAX_ESCALATIONS} failed supervised attempts: ${reason}`,
    );
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.sequenceBySubscription.clear();
    this.tickersBySubscription.clear();
    this.subscriptionIdByKey.clear();
    this.pendingSnapshotRepair.clear();
    this.snapshotRequestRevisionBySubscription.clear();
    this.subscriptionUpdateQueue.length = 0;
    this.pendingSubscriptionUpdate = null;
    this.initialSubscriptionCommand = null;
    this.acknowledgedTrackingRevision = null;
    this.pendingCloseTrigger = null;
    this.pendingTransportFailure = null;
    this.lastSequencedDeltaAt = null;
    // Fail closed: every book must re-prove sequence continuity after a rebuild.
    for (const ticker of this.tickers) {
      this.books.delete(ticker);
      this.quarantined.add(ticker);
    }
    this.closeCurrentSocket();
    this.recordHealth();
    this.connect();
    const nextAttemptInMs = this.supervisorNextAttemptAt == null ? null : this.supervisorNextAttemptAt - now;
    return this.checkSupervisionInvariant(now, this.finishSupervision(now, 'stream-restarted', reason, nextAttemptInMs));
  }

  /**
   * Tripwire for the next variant of the 2026-07-26 bug: a started stream that
   * is not open, has no reconnect armed and no connect in flight has nobody who
   * can revive it. Reported once per supervised attempt so it cannot spam.
   */
  private checkSupervisionInvariant(now: number, result: OrderbookSupervisionResult): OrderbookSupervisionResult {
    if (!this.started) return result;
    const state = this.socketState();
    if (state === 'open' || state === 'connecting' || this.reconnectTimer != null) return result;
    if (this.supervisionInvariantReported) return result;
    this.supervisionInvariantReported = true;
    const reason = `started stream has socketState=${state} with no reconnect scheduled and no connect in flight`;
    this.registry.recordWarn('kalshi-orderbook-ws', `order-book data-plane invariant violated: ${reason}`);
    if (result.action !== 'none') return result;
    return this.finishSupervision(now, 'invariant-violation', reason, result.nextAttemptInMs);
  }

  private finishSupervision(
    now: number,
    action: OrderbookSupervisionAction,
    reason: string | null,
    nextAttemptInMs: number | null,
  ): OrderbookSupervisionResult {
    if (action !== 'none') {
      this.supervisorEscalations += 1;
      this.lastSupervisionAction = action;
      this.lastSupervisionAt = now;
    }
    return { action, reason, nextAttemptInMs };
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
      endpointUrl: telemetry.endpointUrl,
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
      endpointUrl: telemetry.endpointUrl,
    });
  }

  private closeCurrentSocket(): void {
    this.clearHeartbeatTimer();
    const socket = this.socket;
    this.socket = null;
    this.connectAttemptStartedAt = null;
    this.authenticated = false;
    this.connectedAt = null;
    this.subscribed.clear();
    this.subscriptionUpdateQueue.length = 0;
    this.pendingSubscriptionUpdate = null;
    this.initialSubscriptionCommand = null;
    this.acknowledgedTrackingRevision = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close();
  }

  private restartAfterFailure(generation: number, failure: KalshiTransportFailure): void {
    const decision = this.transportController.recordFailure(generation, failure);
    this.closeCurrentSocket();
    this.recordHealth();
    if (!this.started || !decision.retry || decision.delayMs == null) return;
    this.reconnects += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, decision.delayMs);
  }

  private setPendingFailure(generation: number, failure: KalshiTransportFailure, trigger: string): void {
    if (generation !== this.generation) return;
    this.pendingTransportFailure = { generation, failure };
    this.pendingCloseTrigger = trigger;
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
    while (!this.pendingSubscriptionUpdate && this.socket?.readyState === WebSocket.OPEN) {
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
        this.subscriptionUpdates += 1;
        // get_snapshot does not modify the subscription and Kalshi answers it
        // with orderbook_snapshot messages only — no `ok` acknowledgement —
        // so it must not hold the pending-update slot. Per-ticker completion
        // is tracked by pendingSnapshotRepair as each snapshot arrives.
        if (command.action !== 'get_snapshot') {
          this.pendingSubscriptionUpdate = pending;
        }
      } catch {
        this.subscriptionUpdateQueue.unshift(command);
        this.setPendingFailure(this.generation, createKalshiTransportFailure('tcp', 'subscription update send failed'), 'subscription_update_send_failed');
        this.socket.close();
        return;
      }
    }
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private currentEndpointUrl(): string | null {
    return this.transportController.currentEndpoint();
  }
}
