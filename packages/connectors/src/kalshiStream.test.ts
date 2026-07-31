import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { resetKalshiProductionRetryCoordinatorForTests } from '@nemesis/core';
import { ConnectorRegistry } from './registry.js';
import {
  KalshiStream,
  TICKER_CONNECT_DEADLINE_MS,
  TICKER_SUPERVISOR_BASE_BACKOFF_MS,
  TICKER_SUPERVISOR_MAX_BACKOFF_MS,
} from './kalshiStream.js';
import type { KalshiProductionConnectionController, KalshiSocketHealthV2 } from './kalshiTransportController.js';

interface StreamInternals {
  generation: number;
  authenticated: boolean;
  lastPongAt: number | null;
  lastMessageAt: number | null;
  connectedAt: number;
  started: boolean;
  socket: WebSocket | { readyState: number };
  tickers: Set<string>;
  subscribed: Set<string>;
  transport: KalshiProductionConnectionController;
  startHeartbeat(socket: WebSocket, generation: number): void;
}

function primeCurrentGeneration(stream: KalshiStream, tickers: string[]): { generation: number; internals: StreamInternals } {
  const internals = stream as unknown as StreamInternals;
  const attempt = internals.transport.beginAttempt()!;
  internals.generation = attempt.generation;
  for (const ticker of tickers) {
    internals.tickers.add(ticker);
    internals.subscribed.add(ticker);
  }
  return { generation: attempt.generation, internals };
}

describe('KalshiStream replay safety', () => {
  beforeEach(() => resetKalshiProductionRetryCoordinatorForTests());
  afterEach(() => vi.useRealTimers());

  it('emits telemetry that is a valid KalshiSocketHealthV2 evidence record', () => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => null);
    const health: KalshiSocketHealthV2 = stream.telemetry();
    expect(health).toMatchObject({
      connected: false,
      authenticated: false,
      qualificationReady: false,
      environment: 'production',
      lastExchangeDataAt: null,
    });
    expect(health.failureCounters).toHaveProperty('configuration', 0);
  });

  it('ignores callbacks from stale socket generations', () => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => null);
    const seen: string[] = [];
    stream.onQuote((quote) => seen.push(quote.ticker));
    const first = primeCurrentGeneration(stream, ['KXSTALE']);
    const current = first.internals.transport.beginAttempt()!;
    first.internals.generation = current.generation;
    stream.ingest(JSON.stringify({
      type: 'ticker',
      seq: 1,
      msg: { market_ticker: 'KXSTALE', yes_bid: 40, yes_ask: 42, ts_ms: Date.now() },
    }), first.generation);
    expect(seen).toEqual([]);
    expect(stream.getQuote('KXSTALE')).toBeUndefined();
  });

  it('publishes seq-less ticker updates and drops stale exchange timestamps without faulting', () => {
    // The Kalshi ticker channel carries no per-message sequence; integrity is
    // by per-market exchange-timestamp monotonicity.
    const registry = new ConnectorRegistry();
    const stream = new KalshiStream(registry, () => null);
    const seen: number[] = [];
    stream.onQuote((quote) => seen.push(quote.updatedAt));
    const { generation } = primeCurrentGeneration(stream, ['KXONE']);
    const now = Date.now();
    stream.ingest(JSON.stringify({ type: 'ticker', sid: 1, msg: { market_ticker: 'KXONE', yes_bid: 40, yes_ask: 42, ts_ms: now } }), generation);
    stream.ingest(JSON.stringify({ type: 'ticker', sid: 1, msg: { market_ticker: 'KXONE', yes_bid: 41, yes_ask: 43, ts_ms: now + 1_000 } }), generation);
    // A stale update (older exchange timestamp) is dropped, not faulted.
    stream.ingest(JSON.stringify({ type: 'ticker', sid: 1, msg: { market_ticker: 'KXONE', yes_bid: 10, yes_ask: 90, ts_ms: now - 5_000 } }), generation);
    expect(seen).toEqual([now, now + 1_000]);
    expect(stream.telemetry().sequenceGaps).toBe(0);
    expect(stream.telemetry().failureClass).toBeNull();
  });

  it('requires ack, a real pong, and a current sequenced exchange timestamp', () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const { generation, internals } = primeCurrentGeneration(stream, ['KXREADY']);
    internals.authenticated = true;
    internals.lastPongAt = now;
    internals.socket = { readyState: WebSocket.OPEN };

    internals.transport.recordPong(generation);
    stream.ingest(JSON.stringify({ type: 'subscribed', id: 1 }), generation);
    expect(stream.telemetry(now).qualificationReady).toBe(false);
    stream.ingest(JSON.stringify({
      type: 'ticker', sid: 1, seq: 1,
      msg: { market_ticker: 'KXREADY', yes_bid: 40, yes_ask: 42, ts_ms: now },
    }), generation);
    expect(stream.telemetry(now)).toMatchObject({
      connected: true,
      authenticated: true,
      subscriptionAcknowledged: true,
      lastExchangeTimestamp: now,
      qualificationReady: true,
    });
    expect(stream.telemetry(now + 25_001).qualificationReady).toBe(false);
  });

  it('stays transport-qualified while the tracked markets are quiet', () => {
    // A healthy socket tracking markets that simply are not trading is still a
    // healthy socket. qualificationReady folds in market-data recency and so
    // drops; transportQualificationReady must not, or every consumer gating on
    // sustained feed health fails during ordinary Kalshi lulls.
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const { generation, internals } = primeCurrentGeneration(stream, ['KXQUIET']);
    internals.authenticated = true;
    internals.lastPongAt = now;
    internals.socket = { readyState: WebSocket.OPEN };
    internals.transport.recordPong(generation);
    stream.ingest(JSON.stringify({ type: 'subscribed', id: 1 }), generation);
    stream.ingest(JSON.stringify({
      type: 'ticker', sid: 1, seq: 1,
      msg: { market_ticker: 'KXQUIET', yes_bid: 40, yes_ask: 42, ts_ms: now },
    }), generation);

    expect(stream.telemetry(now)).toMatchObject({
      qualificationReady: true,
      transportQualificationReady: true,
    });

    // 60s later: no market has ticked, but pongs keep arriving.
    const later = now + 60_000;
    vi.setSystemTime(later);
    internals.lastPongAt = later - 1_000;
    internals.transport.recordPong(generation);

    const quiet = stream.telemetry(later);
    expect(quiet.qualificationReady).toBe(false);
    expect(quiet.transportQualificationReady).toBe(true);
  });

  it('drops transport qualification when the socket goes silent', () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const { generation, internals } = primeCurrentGeneration(stream, ['KXQUIET']);
    internals.authenticated = true;
    internals.socket = { readyState: WebSocket.OPEN };
    internals.transport.recordPong(generation);
    stream.ingest(JSON.stringify({ type: 'subscribed', id: 1 }), generation);
    internals.lastPongAt = now;
    internals.lastMessageAt = now;
    internals.connectedAt = now;

    expect(stream.telemetry(now).transportQualificationReady).toBe(true);
    // No pong, no traffic of any kind, past the dead-connection bound.
    expect(stream.telemetry(now + 25_001).transportQualificationReady).toBe(false);
  });

  it('accepts type:ok as a subscription acknowledgement', () => {
    // Kalshi answers the first subscribe on a connection with `subscribed`, but
    // answers a later subscribe against an existing sid with `ok` carrying the
    // same command id and the merged market_tickers list. Wire capture:
    // {"type":"ok","id":3,"sid":1,"msg":{"market_tickers":[...]}}
    // Treating only `subscribed` as an ack latched subscriptionAcknowledged
    // false forever once ticker tracking became additive.
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const { generation, internals } = primeCurrentGeneration(stream, ['KXREADY']);
    internals.socket = { readyState: WebSocket.OPEN };

    const pending = internals as unknown as { pendingSubscriptionCommands: Set<number> };
    pending.pendingSubscriptionCommands.add(7);
    internals.transport.recordSubscriptionPending(generation);
    expect(stream.telemetry().subscriptionAcknowledged).toBe(false);

    stream.ingest(JSON.stringify({
      type: 'ok', id: 7, sid: 1, msg: { market_tickers: ['KXREADY'] },
    }), generation);

    expect(pending.pendingSubscriptionCommands.size).toBe(0);
    expect(stream.telemetry().subscriptionAcknowledged).toBe(true);
  });

  it('keeps a subscription pending until every outstanding command is acknowledged', () => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const { generation, internals } = primeCurrentGeneration(stream, ['KXREADY']);
    internals.socket = { readyState: WebSocket.OPEN };

    const pending = internals as unknown as { pendingSubscriptionCommands: Set<number> };
    pending.pendingSubscriptionCommands.add(1);
    pending.pendingSubscriptionCommands.add(2);
    internals.transport.recordSubscriptionPending(generation);

    stream.ingest(JSON.stringify({ type: 'ok', id: 1, sid: 1 }), generation);
    expect(stream.telemetry().subscriptionAcknowledged).toBe(false);

    stream.ingest(JSON.stringify({ type: 'subscribed', id: 2 }), generation);
    expect(stream.telemetry().subscriptionAcknowledged).toBe(true);
  });

  it('rejects seconds, stale, and materially future exchange timestamps', () => {
    vi.useFakeTimers();
    const now = 1_700_000_100_000;
    vi.setSystemTime(now);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const invalidTickers = ['KXINVALID-0', 'KXINVALID-1', 'KXINVALID-2'];
    const { generation, internals } = primeCurrentGeneration(stream, invalidTickers);
    internals.authenticated = true;
    internals.lastPongAt = now;
    internals.socket = { readyState: WebSocket.OPEN };
    internals.transport.recordPong(generation);
    stream.ingest(JSON.stringify({ type: 'subscribed' }), generation);

    const timestamps = [Math.floor(now / 1_000), now - 25_001, now + 5_001];
    timestamps.forEach((ts_ms, index) => stream.ingest(JSON.stringify({
      type: 'ticker', sid: 1, seq: index + 1,
      msg: { market_ticker: `KXINVALID-${index}`, yes_bid: 40, yes_ask: 42, ts_ms },
    }), generation));
    expect(stream.telemetry(now)).toMatchObject({
      qualificationReady: false,
      lastExchangeTimestamp: null,
    });
    for (const ticker of invalidTickers) expect(stream.getQuote(ticker)).toBeUndefined();
  });

  it('replaces and bounds tracking at 500 while evicting removed quote state', () => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => null);
    const { generation } = primeCurrentGeneration(stream, ['KXOLD']);
    stream.ingest(JSON.stringify({
      type: 'ticker', seq: 1,
      msg: { market_ticker: 'KXOLD', yes_bid: 40, yes_ask: 42, ts_ms: Date.now() },
    }), generation);
    expect(stream.getQuote('KXOLD')).toBeDefined();
    stream.track([
      ...Array.from({ length: 500 }, () => 'KX-DUPLICATE'),
      ...Array.from({ length: 700 }, (_, index) => `KX-${index}`),
    ]);
    expect(stream.telemetry().trackedTickers).toBe(500);
    expect(stream.getQuote('KXOLD')).toBeUndefined();

    stream.track(['KX-499', 'KX-NEW', 'KX-NEW']);
    expect(stream.telemetry().trackedTickers).toBe(2);
  });

  it.each([
    [{ yes_bid: -1, yes_ask: 42 }, 'negative bid'],
    [{ yes_bid: 40, yes_ask: 101 }, 'ask over one dollar'],
    [{ yes_bid: 60, yes_ask: 40 }, 'crossed book'],
    [{ yes_bid_dollars: 'bad', yes_ask_dollars: '0.4200' }, 'malformed fixed-point bid'],
  ])('rejects %s price data before caching or emitting (%s)', (prices, _label: string) => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => null);
    const seen: string[] = [];
    stream.onQuote((quote) => seen.push(quote.ticker));
    const { generation } = primeCurrentGeneration(stream, ['KXBADPRICE']);
    stream.ingest(JSON.stringify({
      type: 'ticker', sid: 1, seq: 1,
      msg: { market_ticker: 'KXBADPRICE', ...prices, ts_ms: Date.now() },
    }), generation);
    expect(stream.getQuote('KXBADPRICE')).toBeUndefined();
    expect(seen).toEqual([]);
    expect(stream.telemetry().failureClass).toBe('protocol');
  });

  it('rejects a valid packet for a ticker outside the current subscription', () => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => null);
    const seen: string[] = [];
    stream.onQuote((quote) => seen.push(quote.ticker));
    const { generation } = primeCurrentGeneration(stream, ['KXEXPECTED']);
    stream.ingest(JSON.stringify({
      type: 'ticker', sid: 1, seq: 1,
      msg: { market_ticker: 'KXUNEXPECTED', yes_bid: 40, yes_ask: 42, ts_ms: Date.now() },
    }), generation);
    expect(stream.getQuote('KXUNEXPECTED')).toBeUndefined();
    expect(seen).toEqual([]);
    expect(stream.telemetry().failureClass).toBe('protocol');
  });

  it('revokes readiness and closes the current socket on a live protocol fault', () => {
    vi.useFakeTimers();
    const now = 1_700_000_250_000;
    vi.setSystemTime(now);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const { generation, internals } = primeCurrentGeneration(stream, ['KXLIVE']);
    const socket = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
    internals.started = true;
    internals.socket = socket;
    internals.authenticated = true;
    internals.lastPongAt = now;
    internals.transport.recordSubscriptionAck(generation);
    internals.transport.recordPong(generation);

    stream.ingest(JSON.stringify({
      type: 'ticker', sid: 1, seq: 1,
      msg: { market_ticker: 'KXLIVE', yes_bid: 80, yes_ask: 20, ts_ms: now },
    }), generation);

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(stream.getQuote('KXLIVE')).toBeUndefined();
    expect(stream.telemetry()).toMatchObject({
      connected: false,
      qualificationReady: false,
      failureClass: 'protocol',
    });
    stream.stop();
  });

  it('terminates a half-open ticker socket only after the 25-second pong window', async () => {
    vi.useFakeTimers();
    const startedAt = 1_700_000_300_000;
    vi.setSystemTime(startedAt);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const socket = {
      readyState: WebSocket.OPEN,
      ping: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const { generation, internals } = primeCurrentGeneration(stream, []);
    internals.authenticated = true;
    internals.connectedAt = startedAt;
    internals.socket = socket;
    internals.startHeartbeat(socket, generation);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    stream.stop();
  });
});

function fakeSocket(readyState: number) {
  return { readyState, close: vi.fn(), ping: vi.fn(), send: vi.fn(), terminate: vi.fn() };
}

/**
 * Reuses the fake-socket seam for `connect()`: the stub installs a CONNECTING
 * socket exactly as the real WebSocket constructor would, so the supervisor sees
 * the same post-attempt state it sees in production without opening a socket.
 */
function stubConnect(stream: KalshiStream) {
  const sockets: Array<ReturnType<typeof fakeSocket>> = [];
  const spy = vi.spyOn(stream as unknown as { connect(): void }, 'connect').mockImplementation(() => {
    const socket = fakeSocket(WebSocket.CONNECTING);
    sockets.push(socket);
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket,
      connectAttemptStartedAt: Date.now(),
    });
  });
  return { spy, sockets };
}

describe('KalshiStream data-plane supervisor', () => {
  beforeEach(() => resetKalshiProductionRetryCoordinatorForTests());
  afterEach(() => vi.restoreAllMocks());

  it('recovers a started stream the transport controller refused to retry', () => {
    // The absorbing dead state: scheduleReconnect arms nothing on a no-retry
    // verdict, closeCurrentSocket has already nulled the socket and cleared the
    // heartbeat, and `started` stays true. Nothing inside the stream can revive
    // it, and until the supervisor existed nothing outside was looking.
    const closedAt = 1_700_000_000_000;
    vi.setSystemTime(closedAt);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ Authorization: 'test' }));
    const warn = vi.spyOn(ConnectorRegistry.prototype, 'recordWarn');
    const socket = fakeSocket(WebSocket.OPEN);
    const { generation, internals } = primeCurrentGeneration(stream, ['KXBTCD-TEST']);
    internals.started = true;
    internals.authenticated = true;
    internals.socket = socket as unknown as WebSocket;
    internals.connectedAt = closedAt;
    const { spy } = stubConnect(stream);

    // 1008 + "invalid credentials" classifies as sticky `authentication`, so
    // recordFailure returns noRetry() -- the exact dead end.
    (stream as unknown as { handleClose(s: WebSocket, g: number, c: number, r: string | null): void })
      .handleClose(socket as unknown as WebSocket, generation, 1008, 'invalid credentials');

    expect(stream.socketState()).toBe('none');
    expect(stream.telemetry(closedAt)).toMatchObject({
      socketState: 'none',
      reconnectScheduled: false,
      connectInFlight: false,
    });
    expect(spy).not.toHaveBeenCalled();

    const recovered = stream.superviseDataPlane(closedAt + 1);
    expect(recovered.action).toBe('reconnect-dead-socket');
    // Sticky classes go straight to the cap and keep retrying, never latch off.
    expect(recovered.nextAttemptInMs).toBe(TICKER_SUPERVISOR_MAX_BACKOFF_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(stream.socketState()).toBe('connecting');
    expect(stream.telemetry(closedAt + 1)).toMatchObject({
      connectInFlight: true,
      supervisorEscalations: 1,
      lastSupervisionAction: 'reconnect-dead-socket',
    });
    expect(warn.mock.calls.some(([id, detail]) => id === 'kalshi-ticker-ws' && /sticky authentication/.test(detail)))
      .toBe(true);

    // A connect in flight is left alone.
    expect(stream.superviseDataPlane(closedAt + 2)).toMatchObject({ action: 'none', reason: 'connect in flight' });
    expect(spy).toHaveBeenCalledTimes(1);
    stream.stop();
  });

  it('leaves a stopped stream stopped', () => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => null);
    const { spy } = stubConnect(stream);
    expect(stream.superviseDataPlane()).toEqual({ action: 'none', reason: null, nextAttemptInMs: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves a healthy open socket alone', () => {
    const at = 1_700_001_000_000;
    vi.setSystemTime(at);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ Authorization: 'test' }));
    const socket = fakeSocket(WebSocket.OPEN);
    const { generation, internals } = primeCurrentGeneration(stream, ['KXBTCD-TEST']);
    internals.started = true;
    internals.authenticated = true;
    internals.socket = socket as unknown as WebSocket;
    internals.connectedAt = at;
    internals.lastMessageAt = at;
    internals.startHeartbeat(socket as unknown as WebSocket, generation);
    const { spy } = stubConnect(stream);

    expect(stream.superviseDataPlane(at)).toEqual({ action: 'none', reason: null, nextAttemptInMs: null });
    expect(spy).not.toHaveBeenCalled();
    stream.stop();
  });

  it('restarts a heartbeat that went missing on an open socket', () => {
    const at = 1_700_002_000_000;
    vi.setSystemTime(at);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ Authorization: 'test' }));
    const socket = fakeSocket(WebSocket.OPEN);
    const { internals } = primeCurrentGeneration(stream, ['KXBTCD-TEST']);
    internals.started = true;
    internals.authenticated = true;
    internals.socket = socket as unknown as WebSocket;
    internals.connectedAt = at;

    expect(stream.superviseDataPlane(at)).toMatchObject({ action: 'heartbeat-restarted' });
    // Idempotent: once restarted there is nothing left to fix.
    expect(stream.superviseDataPlane(at)).toMatchObject({ action: 'none' });
    stream.stop();
  });

  it('reaps a connect that never opened or closed', () => {
    const at = 1_700_003_000_000;
    vi.setSystemTime(at);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ Authorization: 'test' }));
    const { internals } = primeCurrentGeneration(stream, []);
    internals.started = true;
    const socket = fakeSocket(WebSocket.CONNECTING);
    Object.assign(stream as unknown as Record<string, unknown>, { socket, connectAttemptStartedAt: at });
    const { spy } = stubConnect(stream);

    expect(stream.superviseDataPlane(at + TICKER_CONNECT_DEADLINE_MS))
      .toMatchObject({ action: 'none', reason: 'connect in flight' });
    expect(spy).not.toHaveBeenCalled();

    const reaped = stream.superviseDataPlane(at + TICKER_CONNECT_DEADLINE_MS + 1);
    expect(reaped.action).toBe('reconnect-connect-timeout');
    expect(socket.close).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    stream.stop();
  });

  it('backs off between supervised attempts and resets once a frame arrives', () => {
    const at = 1_700_004_000_000;
    vi.setSystemTime(at);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ Authorization: 'test' }));
    const { generation, internals } = primeCurrentGeneration(stream, ['KXBTCD-TEST']);
    internals.started = true;
    const { spy } = stubConnect(stream);

    expect(stream.superviseDataPlane(at)).toMatchObject({
      action: 'reconnect-dead-socket',
      nextAttemptInMs: TICKER_SUPERVISOR_BASE_BACKOFF_MS,
    });
    // The attempt dies without opening or closing. Recovery is still owned by
    // the backoff the supervisor just armed, so this is not a tripwire state.
    Object.assign(stream as unknown as Record<string, unknown>, { socket: null, connectAttemptStartedAt: null });
    expect(stream.superviseDataPlane(at + 1)).toMatchObject({ action: 'none', reason: 'supervisor backoff pending' });
    expect(stream.superviseDataPlane(at + 2)).toMatchObject({ action: 'none', reason: 'supervisor backoff pending' });
    expect(spy).toHaveBeenCalledTimes(1);

    // Second attempt only once the backoff is due, and it doubles.
    expect(stream.superviseDataPlane(at + TICKER_SUPERVISOR_BASE_BACKOFF_MS)).toMatchObject({
      action: 'reconnect-dead-socket',
      nextAttemptInMs: TICKER_SUPERVISOR_BASE_BACKOFF_MS * 2,
    });
    expect(spy).toHaveBeenCalledTimes(2);

    // An application frame is the only proof recovery worked, so it is what
    // clears the backoff -- `open` alone has produced silent zombies.
    internals.generation = generation;
    stream.ingest(JSON.stringify({ type: 'ok', id: 1 }), generation);
    Object.assign(stream as unknown as Record<string, unknown>, { socket: null, connectAttemptStartedAt: null });
    expect(stream.superviseDataPlane(at + TICKER_SUPERVISOR_BASE_BACKOFF_MS + 1)).toMatchObject({
      action: 'reconnect-dead-socket',
      nextAttemptInMs: TICKER_SUPERVISOR_BASE_BACKOFF_MS,
    });
    stream.stop();
  });

  it('escalates to a bounded full stream restart after three failed supervised attempts', () => {
    let now = 1_700_005_000_000;
    vi.setSystemTime(now);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ Authorization: 'test' }));
    const { internals } = primeCurrentGeneration(stream, ['KXBTCD-TEST']);
    internals.started = true;
    internals.subscribed.add('KXBTCD-TEST');
    stubConnect(stream);

    const actions: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      Object.assign(stream as unknown as Record<string, unknown>, { socket: null, connectAttemptStartedAt: null });
      actions.push(stream.superviseDataPlane(now).action);
      now += TICKER_SUPERVISOR_MAX_BACKOFF_MS;
    }

    expect(actions.slice(0, 3)).toEqual([
      'reconnect-dead-socket',
      'reconnect-dead-socket',
      'reconnect-dead-socket',
    ]);
    expect(actions[3]).toBe('stream-restarted');
    // A rebuild must force a full resubscribe rather than trusting stale membership.
    expect(internals.subscribed.size).toBe(0);
    expect(internals.tickers.has('KXBTCD-TEST')).toBe(true);
    stream.stop();
  });

  it('reports a supervised connect that produced no socket, without calling it an invariant breach', () => {
    // This is what a rejected API key looks like from in here: connect() returns
    // early, no socket is installed. Worth a durable line -- it named the live
    // 403 on 2026-07-31 inside a minute -- but recovery is still owned by the
    // backoff just armed, so it must not fail the unrecoverable-stream gate.
    const at = 1_700_006_000_000;
    vi.setSystemTime(at);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ Authorization: 'test' }));
    const warn = vi.spyOn(ConnectorRegistry.prototype, 'recordWarn');
    const { internals } = primeCurrentGeneration(stream, []);
    internals.started = true;
    // connect() that no-ops -- e.g. the headers provider returns null.
    vi.spyOn(stream as unknown as { connect(): void }, 'connect').mockImplementation(() => {});
    Object.assign(stream as unknown as Record<string, unknown>, { socket: null, connectAttemptStartedAt: null });

    expect(stream.superviseDataPlane(at)).toMatchObject({ action: 'connect-produced-no-socket' });
    expect(warn.mock.calls.some(([id, detail]) => id === 'kalshi-ticker-ws' && /produced no socket/.test(detail)))
      .toBe(true);
    expect(warn.mock.calls.some(([, detail]) => /invariant violated/.test(detail))).toBe(false);
    const warnsAfterFirst = warn.mock.calls.length;
    // Backoff still holds the next attempt back, and nothing spams the ledger.
    expect(stream.superviseDataPlane(at + 1)).toMatchObject({ action: 'none', reason: 'supervisor backoff pending' });
    expect(warn.mock.calls.length).toBe(warnsAfterFirst);
    stream.stop();
  });

  it('still trips when nothing whatsoever is arranged', () => {
    const at = 1_700_007_000_000;
    vi.setSystemTime(at);
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ Authorization: 'test' }));
    const warn = vi.spyOn(ConnectorRegistry.prototype, 'recordWarn');
    const { internals } = primeCurrentGeneration(stream, []);
    internals.started = true;
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket: null,
      reconnectTimer: null,
      supervisorNextAttemptAt: null,
    });
    const result = (stream as unknown as {
      checkSupervisionInvariant(now: number, r: unknown): { action: string; reason: string | null };
    }).checkSupervisionInvariant(at, { action: 'none', reason: null, nextAttemptInMs: null });

    expect(result.action).toBe('invariant-violation');
    expect(result.reason).toContain('no reconnect scheduled');
    expect(warn.mock.calls.some(([id, detail]) => id === 'kalshi-ticker-ws' && /invariant violated/.test(detail)))
      .toBe(true);
    stream.stop();
  });
});
