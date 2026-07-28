import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { getKalshiEndpointPolicy, resetKalshiProductionRetryCoordinatorForTests } from '@nemesis/core';
import { ConnectorRegistry } from './registry.js';
import { DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS } from './productionMarketProvenance.js';
import {
  KalshiOrderbookStream,
  ORDERBOOK_CONNECT_DEADLINE_MS,
  ORDERBOOK_DATA_PLANE_SILENCE_MS,
  ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS,
  ORDERBOOK_SUPERVISOR_MAX_BACKOFF_MS,
  type OrderbookTrackingStateV2,
} from './kalshiOrderbookStream.js';
import {
  classifyKalshiWebSocketError,
  createKalshiTransportFailure,
  type KalshiProductionConnectionController,
  type KalshiSocketHealthV2,
  type KalshiTransportFailure,
} from './kalshiTransportController.js';

const productionRestBase = getKalshiEndpointPolicy('production').restBaseUrls[0]!;

function verifyTickers(stream: KalshiOrderbookStream, tickers: string[], verifiedAt = Date.now()): void {
  stream.recordProductionMarkets(tickers.map((ticker) => ({
    ticker,
    title: ticker,
    status: 'active',
  })), productionRestBase, verifiedAt);
}

function fakeSocket(readyState: number) {
  return { readyState, close: vi.fn(), ping: vi.fn(), send: vi.fn() };
}

function controllerOf(stream: KalshiOrderbookStream): KalshiProductionConnectionController {
  return (stream as unknown as { transportController: KalshiProductionConnectionController }).transportController;
}

/**
 * Reuses the existing fake-socket seam for `connect()`: the stub installs a
 * CONNECTING socket exactly as the real WebSocket constructor would, so the
 * supervisor's invariant sees the same post-attempt state it sees in production
 * without opening a real socket.
 */
function stubConnect(stream: KalshiOrderbookStream) {
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

function killSocket(stream: KalshiOrderbookStream): void {
  Object.assign(stream as unknown as Record<string, unknown>, { socket: null, connectAttemptStartedAt: null });
}

describe('KalshiOrderbookStream', () => {
  beforeEach(() => resetKalshiProductionRetryCoordinatorForTests());
  afterEach(() => vi.useRealTimers());

  it('emits telemetry that is a valid KalshiSocketHealthV2 evidence record', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    const health: KalshiSocketHealthV2 = stream.telemetry();
    expect(health).toMatchObject({
      connected: false,
      authenticated: false,
      qualificationReady: false,
      environment: 'production',
      lastExchangeDataAt: null,
    });
  });

  it('projects trackingStateV2 directly from the live telemetry', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    verifyTickers(stream, ['KXTEST']);
    stream.track(['KXTEST']);
    const now = Date.now();
    const state: OrderbookTrackingStateV2 = stream.trackingStateV2(now);
    const telemetry = stream.telemetry(now);
    expect(state.requiredTickers).toBe(25);
    for (const key of Object.keys(state) as Array<keyof OrderbookTrackingStateV2>) {
      if (key === 'requiredTickers') continue;
      expect(state[key]).toEqual(telemetry[key as keyof typeof telemetry]);
    }
  });

  it('uses exchange delta timestamp and sequence, never local snapshot time', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    verifyTickers(stream, ['KXTEST']);
    const observed: Array<{ sequence?: number; sourceTimestamp?: number }> = [];
    stream.onBookUpdate((book) => observed.push(book));
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot',
      seq: 2,
      msg: {
        market_ticker: 'KXTEST',
        yes_dollars_fp: [['0.4000', '10.00']],
        no_dollars_fp: [['0.5800', '20.00']],
      },
    }));
    // A snapshot repairs structure but cannot qualify until a later exchange delta.
    expect(stream.getBook('KXTEST')).toBeNull();

    stream.ingest(JSON.stringify({
      type: 'orderbook_delta',
      seq: 3,
      msg: {
        market_ticker: 'KXTEST',
        price_dollars: '0.5900',
        delta_fp: '5.00',
        side: 'no',
        ts_ms: 1_669_149_841_000,
      },
    }));
    const book = stream.getBook('KXTEST');
    expect(book).toMatchObject({ sequence: 3, sourceTimestamp: 1_669_149_841_000 });
    // use_yes_price emits the NO order at a YES-scale price. Internally the
    // existing NO leg remains a NO-scale bid.
    expect(book?.no).toContainEqual({ price: 0.41, quantity: 5 });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ sequence: 3, sourceTimestamp: 1_669_149_841_000 });
  });

  it('drops a book on sequence regression', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    verifyTickers(stream, ['KXTEST']);
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', seq: 5,
      msg: { market_ticker: 'KXTEST', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    }));
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 4,
      msg: { market_ticker: 'KXTEST', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: 1_669_149_841_000 },
    }));
    expect(stream.getBook('KXTEST')).toBeNull();
    expect(stream.telemetry().sequenceRegressions).toBe(1);
    expect(stream.telemetry()).toMatchObject({ sequenceGaps: 1, quarantinedTickers: 1 });
  });

  it('requires a fresh snapshot and later delta after a sequence gap', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    verifyTickers(stream, ['KXTEST']);
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', seq: 10,
      msg: { market_ticker: 'KXTEST', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    }));
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 12,
      msg: { market_ticker: 'KXTEST', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: 1_669_149_841_000 },
    }));
    expect(stream.getBook('KXTEST')).toBeNull();

    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', seq: 13,
      msg: { market_ticker: 'KXTEST', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    }));
    expect(stream.getBook('KXTEST')).toBeNull();
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 14,
      msg: { market_ticker: 'KXTEST', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: 1_669_149_842_000 },
    }));
    expect(stream.getBook('KXTEST')).toMatchObject({ sequence: 14, sourceTimestamp: 1_669_149_842_000 });
  });

  it('rejects second-based and materially future exchange timestamps', () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    verifyTickers(stream, ['KXTIME'], now);
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', seq: 1,
      msg: { market_ticker: 'KXTIME', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    }));
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 2,
      msg: { market_ticker: 'KXTIME', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: 1_700_000_000 },
    }));
    expect(stream.getBook('KXTIME')).toBeNull();
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 3,
      msg: { market_ticker: 'KXTIME', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: now + 5_001 },
    }));
    expect(stream.getBook('KXTIME')).toBeNull();
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 4,
      msg: { market_ticker: 'KXTIME', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: now },
    }));
    expect(stream.getBook('KXTIME')).toMatchObject({ sequence: 4, sourceTimestamp: now });
  });

  it('never returns or emits a book after its production REST provenance expires', () => {
    vi.useFakeTimers();
    const at = 1_700_000_050_000;
    vi.setSystemTime(at);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    const listener = vi.fn();
    stream.onBookUpdate(listener);
    verifyTickers(stream, ['KXPROVENANCE'], at);
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', seq: 1,
      msg: { market_ticker: 'KXPROVENANCE', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    }));
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 2,
      msg: { market_ticker: 'KXPROVENANCE', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: at },
    }));
    expect(stream.getBook('KXPROVENANCE')).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    const expiredAt = at + DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS + 1;
    vi.setSystemTime(expiredAt);
    expect(stream.getBook('KXPROVENANCE')).toBeNull();
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 3,
      msg: { market_ticker: 'KXPROVENANCE', price_dollars: '0.4200', delta_fp: '1.00', side: 'yes', ts_ms: expiredAt },
    }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects negative, fractional, and unsafe sequences before book mutation', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    verifyTickers(stream, ['KXSEQ']);
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      stream.ingest(JSON.stringify({
        type: 'orderbook_snapshot', seq,
        msg: { market_ticker: 'KXSEQ', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
      }));
    }
    expect(stream.getBook('KXSEQ')).toBeNull();
    expect(stream.telemetry().lastSequencedDeltaAt).toBeNull();
  });

  it('tracks sequence continuity per subscription, not per ticker', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    verifyTickers(stream, ['KXA', 'KXB']);
    stream.ingest(JSON.stringify({ type: 'orderbook_snapshot', sid: 7, seq: 1, msg: {
      market_ticker: 'KXA', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [],
    } }));
    stream.ingest(JSON.stringify({ type: 'orderbook_snapshot', sid: 7, seq: 2, msg: {
      market_ticker: 'KXB', yes_dollars_fp: [['0.4500', '10.00']], no_dollars_fp: [],
    } }));
    stream.ingest(JSON.stringify({ type: 'orderbook_delta', sid: 7, seq: 3, msg: {
      market_ticker: 'KXA', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: 1_669_149_842_000,
    } }));
    expect(stream.telemetry().sequenceGaps).toBe(0);
    expect(stream.getBook('KXA')).toMatchObject({ sequence: 3 });
  });

  it('stops qualification when exchange time exceeds the liveness window even while pongs remain live', () => {
    vi.useFakeTimers();
    const deltaAt = 1_700_000_000_000;
    vi.setSystemTime(deltaAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    const tracked = ['KXTEST', ...Array.from({ length: 24 }, (_, index) => `KX-LIVE-${index}`)];
    verifyTickers(stream, tracked, deltaAt);
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket: { readyState: WebSocket.OPEN },
      authenticated: true,
      tickers: new Set(tracked),
      subscribed: new Set(tracked),
      trackingRevision: 1,
      acknowledgedTrackingRevision: 1,
      lastPongAt: deltaAt,
      generation: 1,
    });
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', seq: 1,
      msg: { market_ticker: 'KXTEST', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    }), 1);
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', seq: 2,
      msg: { market_ticker: 'KXTEST', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: deltaAt },
    }), 1);

    // A quiet-but-live book stays qualified inside the 25s liveness window.
    expect(stream.telemetry(deltaAt + 1_001).qualificationReady).toBe(true);
    expect(stream.telemetry(deltaAt + 25_000).qualificationReady).toBe(true);
    Object.assign(stream as unknown as Record<string, unknown>, {
      lastPongAt: deltaAt + 25_001,
      lastMessageAt: deltaAt + 25_001,
    });
    expect(stream.telemetry(deltaAt + 25_001)).toMatchObject({
      connected: true,
      qualificationReady: false,
      lastPongAt: deltaAt + 25_001,
      lastSequencedDeltaAt: deltaAt,
      lastExchangeTimestamp: deltaAt,
    });
  });

  it('forces reconnect when ping-pong traffic expires (does not rely on close alone)', async () => {
    vi.useFakeTimers();
    const startedAt = 1_700_000_100_000;
    vi.setSystemTime(startedAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    Object.assign(stream as unknown as Record<string, unknown>, { started: true });
    const socket = {
      readyState: WebSocket.OPEN,
      ping: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket,
      authenticated: true,
      generation: 4,
      lastMessageAt: startedAt,
      lastApplicationMessageAt: startedAt,
      lastPongAt: startedAt,
      lastSequencedDeltaAt: startedAt,
      connectedAt: startedAt,
    });
    (stream as unknown as { startHeartbeat(socket: WebSocket, generation: number): void })
      .startHeartbeat(socket, 4);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.close).not.toHaveBeenCalled();
    Object.assign(stream as unknown as Record<string, unknown>, {
      lastMessageAt: startedAt + 20_000,
      lastApplicationMessageAt: startedAt + 20_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(stream.telemetry(startedAt + 30_000)).toMatchObject({
      reconnects: 1,
      lastCloseTrigger: 'local_pong_expired',
      connected: false,
    });
    stream.stop();
  });

  it('forces reconnect when pongs stay fresh but orderbook application traffic freezes', async () => {
    vi.useFakeTimers();
    const startedAt = 1_700_000_200_000;
    vi.setSystemTime(startedAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    Object.assign(stream as unknown as Record<string, unknown>, { started: true });
    const socket = {
      readyState: WebSocket.OPEN,
      ping: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const tickers = new Set(['KXINXHUD-TEST']);
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket,
      authenticated: true,
      generation: 7,
      tickers,
      lastMessageAt: startedAt,
      lastApplicationMessageAt: startedAt,
      lastPongAt: startedAt,
      connectedAt: startedAt,
    });
    (stream as unknown as { startHeartbeat(socket: WebSocket, generation: number): void })
      .startHeartbeat(socket, 7);

    // Keep pongs fresh (zombie control plane) while application clock stays frozen.
    // Silence uses strict > DATA_PLANE_SILENCE_MS (90s), so the 10th 10s heartbeat (100s) recovers.
    for (let step = 0; step < 10; step += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      if (step < 9) {
        expect(socket.close).not.toHaveBeenCalled();
      }
      Object.assign(stream as unknown as Record<string, unknown>, {
        lastPongAt: startedAt + ((step + 1) * 10_000),
        // Protocol ping must not reset the application silence clock.
        lastMessageAt: startedAt + ((step + 1) * 10_000),
      });
    }
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(stream.telemetry(startedAt + 100_000)).toMatchObject({
      reconnects: 1,
      lastCloseTrigger: 'local_data_plane_silence',
    });
    stream.stop();
  });

  it('desktop recoverIfDataPlaneSilent forces reconnect without waiting for heartbeat', () => {
    const startedAt = 1_700_000_300_000;
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const socket = {
      readyState: WebSocket.OPEN,
      ping: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    Object.assign(stream as unknown as Record<string, unknown>, {
      started: true,
      socket,
      authenticated: true,
      generation: 3,
      tickers: new Set(['KXBTCD-TEST']),
      lastApplicationMessageAt: startedAt - 120_000,
      connectedAt: startedAt - 120_000,
      lastPongAt: startedAt,
    });
    expect(stream.recoverIfDataPlaneSilent(startedAt)).toBe(true);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(stream.telemetry(startedAt).lastCloseTrigger).toBe('local_data_plane_silence');
    stream.stop();
  });
  it('bounds live orderbooks to one 25-ticker subscription and updates that subscription in place', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    Object.assign(stream as unknown as Record<string, unknown>, { socket, authenticated: true, generation: 1, started: true });
    const tickers = Array.from({ length: 120 }, (_, index) => `KX-${index}`);
    verifyTickers(stream, tickers);

    stream.track(tickers);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(socket.send.mock.calls[0]![0])).params.market_tickers).toHaveLength(25);
    expect(JSON.parse(String(socket.send.mock.calls[0]![0])).params.use_yes_price).toBe(true);
    expect(stream.telemetry().trackedTickers).toBe(25);
    stream.ingest(JSON.stringify({ type: 'subscribed', msg: { channel: 'orderbook_delta', sid: 7 } }), 1);
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(socket.send.mock.calls[1]![0]))).toMatchObject({
      cmd: 'update_subscription',
      params: { sids: [7], action: 'get_snapshot' },
    });
    stream.ingest(JSON.stringify({ id: 2, type: 'ok', sid: 7, seq: 1, msg: {} }), 1);

    stream.replaceTracked(tickers.slice(20, 45));
    expect(socket.send).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(socket.send.mock.calls[2]![0]))).toMatchObject({
      cmd: 'update_subscription',
      params: { sids: [7], action: 'delete_markets' },
    });
    expect(JSON.parse(String(socket.send.mock.calls[2]![0])).params.market_tickers).toHaveLength(20);
    expect(stream.telemetry()).toMatchObject({
      trackedTickers: 25,
      subscriptionUpdates: 2,
      subscriptionUpdateQueueDepth: 1,
      subscriptionUpdateInFlight: true,
      membershipAcknowledged: false,
    });
    stream.ingest(JSON.stringify({
      id: 3,
      type: 'ok',
      sid: 7,
      seq: 2,
      msg: { market_tickers: tickers.slice(0, 20) },
    }), 1);
    expect(socket.send).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(socket.send.mock.calls[3]![0]))).toMatchObject({
      cmd: 'update_subscription',
      params: { sids: [7], action: 'add_markets' },
    });
    expect(JSON.parse(String(socket.send.mock.calls[3]![0])).params.market_tickers).toHaveLength(20);
    expect(stream.telemetry()).toMatchObject({
      trackedTickers: 25,
      subscriptionUpdates: 3,
      subscriptionUpdateQueueDepth: 0,
      subscriptionUpdateInFlight: true,
    });
    stream.ingest(JSON.stringify({
      id: 4,
      type: 'ok',
      sid: 7,
      seq: 3,
      msg: { market_tickers: tickers.slice(25, 45) },
    }), 1);
    expect(socket.send).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(socket.send.mock.calls[4]![0]))).toMatchObject({
      cmd: 'update_subscription',
      params: { sids: [7], action: 'get_snapshot' },
    });
    // get_snapshot is fire-and-forget (Kalshi answers with snapshots, not an
    // `ok`), so membership is acknowledged as soon as the add/delete acks land.
    expect(stream.telemetry()).toMatchObject({
      subscriptionUpdateInFlight: false,
      serverTrackedTickers: 25,
      acknowledgedTrackingRevision: 2,
      membershipAcknowledged: true,
    });
    stream.stop();
  });

  it('does not qualify a short tracking set and becomes ready at exactly 25 unique tickers', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket,
      authenticated: true,
      generation: 1,
      started: true,
    });
    const firstTwentyFour = Array.from({ length: 24 }, (_, index) => `KX-LIVE-${index}`);
    verifyTickers(stream, firstTwentyFour);
    stream.track([...firstTwentyFour, 'KX-LIVE-24']);
    expect(stream.telemetry()).toMatchObject({
      trackedTickers: 24,
      trackingReady: false,
      qualificationReady: false,
    });

    verifyTickers(stream, ['KX-LIVE-24']);
    stream.track([...firstTwentyFour, 'KX-LIVE-24', 'KX-LIVE-24']);
    expect(stream.telemetry()).toMatchObject({
      trackedTickers: 25,
      verifiedTrackedTickers: 25,
      trackingReady: false,
      qualificationReady: false,
    });
    stream.stop();
  });

  it('qualifies only after exact membership acknowledgement, snapshot, later delta, and fresh pong', () => {
    vi.useFakeTimers();
    const now = 1_700_000_500_000;
    vi.setSystemTime(now);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket,
      authenticated: true,
      generation: 1,
      started: true,
      lastPongAt: now,
    });
    const tickers = ['KX-READY', ...Array.from({ length: 24 }, (_, index) => `KX-READY-${index}`)];
    verifyTickers(stream, tickers, now);
    stream.replaceTracked(tickers, now);
    expect(stream.telemetry(now)).toMatchObject({
      trackedTickers: 25,
      verifiedTrackedTickers: 25,
      membershipAcknowledged: false,
      qualificationReady: false,
    });

    stream.ingest(JSON.stringify({ id: 1, type: 'subscribed', msg: { sid: 7 } }), 1);
    expect(stream.telemetry(now).qualificationReady).toBe(false);
    stream.ingest(JSON.stringify({ id: 2, type: 'ok', sid: 7, seq: 1, msg: {} }), 1);
    expect(stream.telemetry(now)).toMatchObject({
      membershipAcknowledged: true,
      trackingReady: true,
      qualificationReady: false,
    });
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', sid: 7, seq: 2,
      msg: { market_ticker: 'KX-READY', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [['0.6000', '8.00']] },
    }), 1);
    expect(stream.telemetry(now).qualificationReady).toBe(false);
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', sid: 7, seq: 3,
      msg: { market_ticker: 'KX-READY', price_dollars: '0.5900', delta_fp: '1.00', side: 'no', ts_ms: now },
    }), 1);
    expect(stream.telemetry(now)).toMatchObject({ qualifiedTickers: 1, qualificationReady: true });
    expect(stream.getBook('KX-READY')?.no).toContainEqual({ price: 0.41, quantity: 1 });

    expect(stream.telemetry(now + DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS + 1)).toMatchObject({
      verifiedTrackedTickers: 0,
      trackingReady: false,
      qualificationReady: false,
    });
    stream.stop();
  });

  it('reports the failed and next approved production aliases after a typed transport failure', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const policy = getKalshiEndpointPolicy('production').websocketUrls;
    const controller = (stream as unknown as { transportController: KalshiProductionConnectionController }).transportController;
    expect(stream.telemetry().endpointUrl).toBe(policy[0]);
    const attempt = controller.beginAttempt()!;
    controller.recordFailure(attempt.generation, createKalshiTransportFailure('tls', 'TLS reset'));
    expect(stream.telemetry()).toMatchObject({ failedEndpoint: policy[0], nextEndpoint: policy[1] });
    expect(stream.telemetry().endpointUrl).toBe(policy[1]);
  });

  it('allows only the current authenticated generation to repair qualification', () => {
    vi.useFakeTimers();
    const recoveredAt = 1_700_000_200_000;
    vi.setSystemTime(recoveredAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const tracked = ['KXRECOVER', ...Array.from({ length: 24 }, (_, index) => `KX-LIVE-${index}`)];
    verifyTickers(stream, tracked, recoveredAt);
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket: { readyState: WebSocket.OPEN },
      authenticated: true,
      tickers: new Set(tracked),
      subscribed: new Set(tracked),
      trackingRevision: 1,
      acknowledgedTrackingRevision: 1,
      lastPongAt: recoveredAt,
      generation: 2,
    });
    const snapshot = JSON.stringify({
      type: 'orderbook_snapshot', seq: 1,
      msg: { market_ticker: 'KXRECOVER', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    });
    const delta = JSON.stringify({
      type: 'orderbook_delta', seq: 2,
      msg: { market_ticker: 'KXRECOVER', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: recoveredAt },
    });

    stream.ingest(snapshot, 1);
    stream.ingest(delta, 1);
    expect(stream.getBook('KXRECOVER')).toBeNull();
    expect(stream.telemetry(recoveredAt).qualificationReady).toBe(false);

    stream.ingest(snapshot, 2);
    stream.ingest(delta, 2);
    expect(stream.getBook('KXRECOVER')).toMatchObject({ sequence: 2, sourceTimestamp: recoveredAt });
    expect(stream.telemetry(recoveredAt)).toMatchObject({
      authenticated: true,
      generation: 2,
      qualificationReady: true,
    });
  });

  it('repairs only the gapped subscription but fails feed qualification while repair is pending', () => {
    vi.useFakeTimers();
    const recoveredAt = 1_700_000_300_000;
    vi.setSystemTime(recoveredAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    const tracked = ['KXA', 'KXB', 'KXHEALTHY', ...Array.from({ length: 22 }, (_, index) => `KX-LIVE-${index}`)];
    verifyTickers(stream, tracked, recoveredAt);
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket,
      authenticated: true,
      tickers: new Set(tracked),
      subscribed: new Set(tracked),
      trackingRevision: 1,
      acknowledgedTrackingRevision: 1,
      lastPongAt: recoveredAt,
      generation: 1,
    });

    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', sid: 8, seq: 1,
      msg: { market_ticker: 'KXA', yes_dollars_fp: [['0.3000', '5.00']], no_dollars_fp: [] },
    }), 1);
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', sid: 8, seq: 2,
      msg: { market_ticker: 'KXA', price_dollars: '0.3100', delta_fp: '1.00', side: 'yes', ts_ms: recoveredAt },
    }), 1);
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', sid: 8, seq: 3,
      msg: { market_ticker: 'KXB', yes_dollars_fp: [['0.3500', '8.00']], no_dollars_fp: [] },
    }), 1);
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', sid: 8, seq: 4,
      msg: { market_ticker: 'KXB', price_dollars: '0.3600', delta_fp: '1.00', side: 'yes', ts_ms: recoveredAt },
    }), 1);
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', sid: 9, seq: 1,
      msg: { market_ticker: 'KXHEALTHY', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    }), 1);
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', sid: 9, seq: 2,
      msg: { market_ticker: 'KXHEALTHY', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: recoveredAt },
    }), 1);

    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', sid: 8, seq: 6,
      msg: { market_ticker: 'KXA', price_dollars: '0.3200', delta_fp: '1.00', side: 'yes', ts_ms: recoveredAt },
    }), 1);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(socket.send.mock.calls[0]![0]))).toEqual({
      id: 1,
      cmd: 'update_subscription',
      params: {
        sids: [8],
        market_tickers: ['KXA', 'KXB'],
        action: 'get_snapshot',
      },
    });
    expect(socket.close).not.toHaveBeenCalled();
    expect(stream.getBook('KXA')).toBeNull();
    expect(stream.getBook('KXB')).toBeNull();
    expect(stream.getBook('KXHEALTHY')).toMatchObject({ sequence: 2, sourceTimestamp: recoveredAt });
    expect(stream.telemetry(recoveredAt)).toMatchObject({
      connected: true,
      authenticated: true,
      quarantinedTickers: 2,
      qualifiedTickers: 1,
      // Quarantined books are excluded from qualification while their repair
      // snapshots are outstanding; the healthy proven book keeps the feed
      // qualified, and the recorded sequence gap still fails any zero-fault
      // readiness hold.
      qualificationReady: true,
    });

    // The official sequenced OK response advances continuity without mutating
    // books or causing a false second repair request.
    stream.ingest(JSON.stringify({
      id: 1, type: 'ok', sid: 8, seq: 7,
      msg: { market_tickers: ['KXA', 'KXB'] },
    }), 1);
    expect(stream.getBook('KXA')).toBeNull();
    expect(stream.getBook('KXB')).toBeNull();
    expect(socket.send).toHaveBeenCalledTimes(1);

    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', sid: 8, seq: 8,
      msg: { market_ticker: 'KXA', yes_dollars_fp: [['0.3000', '5.00']], no_dollars_fp: [] },
    }), 1);
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', sid: 8, seq: 9,
      msg: { market_ticker: 'KXB', yes_dollars_fp: [['0.3500', '8.00']], no_dollars_fp: [] },
    }), 1);
    expect(stream.getBook('KXA')).toBeNull();
    expect(stream.getBook('KXB')).toBeNull();

    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', sid: 8, seq: 10,
      msg: { market_ticker: 'KXA', price_dollars: '0.3100', delta_fp: '1.00', side: 'yes', ts_ms: recoveredAt },
    }), 1);
    expect(stream.getBook('KXA')).toMatchObject({ sequence: 10 });
    expect(stream.getBook('KXB')).toBeNull();
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', sid: 8, seq: 11,
      msg: { market_ticker: 'KXB', price_dollars: '0.3600', delta_fp: '1.00', side: 'yes', ts_ms: recoveredAt },
    }), 1);
    expect(stream.getBook('KXB')).toMatchObject({ sequence: 11 });
  });

  it('uses known sid tickers when a sequenced control packet reveals the gap', () => {
    vi.useFakeTimers();
    const at = 1_700_000_400_000;
    vi.setSystemTime(at);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    verifyTickers(stream, ['KXCONTROL'], at);
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket,
      authenticated: true,
      generation: 1,
    });
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot', sid: 12, seq: 1,
      msg: { market_ticker: 'KXCONTROL', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
    }), 1);
    stream.ingest(JSON.stringify({
      type: 'orderbook_delta', sid: 12, seq: 2,
      msg: { market_ticker: 'KXCONTROL', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: at },
    }), 1);
    expect(stream.getBook('KXCONTROL')).not.toBeNull();

    stream.ingest(JSON.stringify({
      type: 'ok', sid: 12, seq: 4,
      msg: { market_tickers: ['KXCONTROL'] },
    }), 1);

    expect(stream.getBook('KXCONTROL')).toBeNull();
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(socket.send.mock.calls[0]![0]))).toMatchObject({
      cmd: 'update_subscription',
      params: { sids: [12], market_tickers: ['KXCONTROL'], action: 'get_snapshot' },
    });
  });

  // Regression suite for the 2026-07-26 outage: the orderbook socket died at
  // T+13m40s and never re-opened for 7.9h because every teardown path could end
  // without arming a reconnect. Recovery is now owned from outside the socket.
  describe('data-plane supervision', () => {
    it('A: recovers a socket that a non-retryable (sticky) close left with nothing armed', () => {
      vi.useFakeTimers();
      const closedAt = 1_700_010_000_000;
      vi.setSystemTime(closedAt);
      const registry = new ConnectorRegistry();
      const warn = vi.spyOn(registry, 'recordWarn');
      const stream = new KalshiOrderbookStream(registry, () => ({ authorization: 'test' }));
      const attempt = controllerOf(stream).beginAttempt()!;
      const socket = fakeSocket(WebSocket.OPEN);
      verifyTickers(stream, ['KXBTCD-TEST'], closedAt);
      Object.assign(stream as unknown as Record<string, unknown>, {
        started: true,
        socket,
        authenticated: true,
        generation: attempt.generation,
        tickers: new Set(['KXBTCD-TEST']),
        connectedAt: closedAt,
        lastApplicationMessageAt: closedAt,
      });
      const { spy } = stubConnect(stream);

      // 1008 + "invalid credentials" classifies as sticky `authentication`, so
      // recordFailure returns noRetry() — the exact absorbing dead end.
      (stream as unknown as { handleSocketClose(s: WebSocket, g: number, c: number, r: Buffer): void })
        .handleSocketClose(socket as unknown as WebSocket, attempt.generation, 1008, Buffer.from('invalid credentials'));

      expect(stream.socketState()).toBe('none');
      expect(stream.telemetry(closedAt)).toMatchObject({
        reconnectScheduled: false,
        connectInFlight: false,
        socketState: 'none',
      });
      expect(spy).not.toHaveBeenCalled();
      expect(stream.isTracked('KXBTCD-TEST')).toBe(true);

      const recovered = stream.superviseDataPlane(closedAt + 1);
      expect(recovered.action).toBe('reconnect-dead-socket');
      // Sticky classes go straight to the cap and keep retrying, never latch off.
      expect(recovered.nextAttemptInMs).toBe(ORDERBOOK_SUPERVISOR_MAX_BACKOFF_MS);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(stream.socketState()).toBe('connecting');
      expect(stream.telemetry(closedAt + 1)).toMatchObject({
        connectInFlight: true,
        supervisorEscalations: 1,
        lastSupervisionAction: 'reconnect-dead-socket',
        lastSupervisionAt: closedAt + 1,
      });
      expect(warn.mock.calls.some(([id, detail]) => id === 'kalshi-orderbook-ws' && /sticky authentication/.test(detail)))
        .toBe(true);

      // Backoff is respected between attempts; the connect stays in flight.
      expect(stream.superviseDataPlane(closedAt + 2)).toMatchObject({ action: 'none', reason: 'connect in flight' });
      expect(spy).toHaveBeenCalledTimes(1);
      stream.stop();
    });

    it('B: recovers after restartAfterFailure leaves a non-retryable handshake dead end', () => {
      vi.useFakeTimers();
      const at = 1_700_011_000_000;
      vi.setSystemTime(at);
      const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
      const attempt = controllerOf(stream).beginAttempt()!;
      const socket = fakeSocket(WebSocket.CONNECTING);
      Object.assign(stream as unknown as Record<string, unknown>, {
        started: true,
        socket,
        generation: attempt.generation,
        connectAttemptStartedAt: at,
      });
      const { spy } = stubConnect(stream);

      // HTTP 404 maps to the unmapped `unknown` class: retryable === false.
      const failure = classifyKalshiWebSocketError({ statusCode: 404, message: 'unexpected server response: 404' });
      expect(failure).toMatchObject({ classification: 'unknown', retryable: false });
      (stream as unknown as { restartAfterFailure(g: number, f: KalshiTransportFailure): void })
        .restartAfterFailure(attempt.generation, failure);

      expect(stream.socketState()).toBe('none');
      expect(stream.telemetry(at).reconnectScheduled).toBe(false);
      expect(spy).not.toHaveBeenCalled();

      expect(stream.superviseDataPlane(at + 1)).toMatchObject({
        action: 'reconnect-dead-socket',
        nextAttemptInMs: ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(stream.socketState()).toBe('connecting');
      stream.stop();
    });

    it('C: keeps the 3158ef9 guard — an OPEN but application-silent socket still reconnects and resubscribes', async () => {
      vi.useFakeTimers();
      const startedAt = 1_700_012_000_000;
      vi.setSystemTime(startedAt);
      const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
      const socket = fakeSocket(WebSocket.OPEN);
      const tracked = ['KXBTCD-A', 'KXBTCD-B'];
      verifyTickers(stream, tracked, startedAt);
      Object.assign(stream as unknown as Record<string, unknown>, {
        started: true,
        socket,
        authenticated: true,
        generation: 3,
        tickers: new Set(tracked),
        subscribed: new Set(tracked),
        connectedAt: startedAt - ORDERBOOK_DATA_PLANE_SILENCE_MS - 1_000,
        lastApplicationMessageAt: startedAt - ORDERBOOK_DATA_PLANE_SILENCE_MS - 1_000,
        lastPongAt: startedAt,
      });
      const { spy } = stubConnect(stream);

      const result = stream.superviseDataPlane(startedAt);
      expect(result.action).toBe('reconnect-silent');
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(stream.telemetry(startedAt)).toMatchObject({
        lastCloseTrigger: 'local_data_plane_silence',
        reconnectScheduled: true,
        // Membership was torn down, so the reconnect must resubscribe it.
        serverTrackedTickers: 0,
      });
      await vi.advanceTimersByTimeAsync(Math.max(result.nextAttemptInMs ?? 0, 1));
      expect(spy).toHaveBeenCalledTimes(1);
      stream.stop();
    });

    it('D: does not thrash a live socket that is still receiving application frames', () => {
      vi.useFakeTimers();
      const at = 1_700_013_000_000;
      vi.setSystemTime(at);
      const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
      const socket = fakeSocket(WebSocket.OPEN);
      const tracked = ['KXBTCD-LOUD', 'KXBTCD-QUIET'];
      verifyTickers(stream, tracked, at);
      Object.assign(stream as unknown as Record<string, unknown>, {
        started: true,
        socket,
        authenticated: true,
        generation: 5,
        tickers: new Set(tracked),
        subscribed: new Set(tracked),
        connectedAt: at - 60_000,
        lastApplicationMessageAt: at - 1_000,
        lastPongAt: at,
      });
      (stream as unknown as { startHeartbeat(socket: WebSocket, generation: number): void })
        .startHeartbeat(socket as unknown as WebSocket, 5);
      const { spy } = stubConnect(stream);

      expect(stream.superviseDataPlane(at)).toEqual({ action: 'none', reason: null, nextAttemptInMs: null });
      // One tracked book is quiet — that is a market property, not a feed fault.
      expect(stream.bookState('KXBTCD-QUIET', at).state).toBe('subscribed-awaiting-snapshot');
      expect(spy).not.toHaveBeenCalled();
      expect(socket.close).not.toHaveBeenCalled();
      expect(stream.telemetry(at)).toMatchObject({ supervisorEscalations: 0, lastSupervisionAction: null });
      stream.stop();
    });

    it('E: reports every per-ticker book lifecycle state, including a superseded-revision delta', () => {
      vi.useFakeTimers();
      const at = 1_700_014_000_000;
      vi.setSystemTime(at);
      const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
      const snapshot = (seq: number) => JSON.stringify({
        type: 'orderbook_snapshot', seq,
        msg: { market_ticker: 'KXSTATE', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
      });
      const delta = (seq: number) => JSON.stringify({
        type: 'orderbook_delta', seq,
        msg: { market_ticker: 'KXSTATE', price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: at },
      });

      expect(stream.bookState('KXSTATE', at)).toEqual({ state: 'untracked', sequencedAgeMs: null, snapshotAgeMs: null });

      // Membership without a live provenance proof is exactly what a 90s TTL
      // lapse looks like from getBook's side.
      Object.assign(stream as unknown as Record<string, unknown>, { tickers: new Set(['KXSTATE']) });
      expect(stream.bookState('KXSTATE', at).state).toBe('tracked-no-provenance');

      verifyTickers(stream, ['KXSTATE'], at);
      expect(stream.bookState('KXSTATE', at)).toEqual({
        state: 'subscribed-awaiting-snapshot',
        sequencedAgeMs: null,
        snapshotAgeMs: null,
      });

      stream.ingest(snapshot(1));
      expect(stream.bookState('KXSTATE', at)).toEqual({
        state: 'snapshot-quarantined',
        sequencedAgeMs: null,
        snapshotAgeMs: 0,
      });

      stream.ingest(delta(2));
      expect(stream.bookState('KXSTATE', at)).toEqual({
        state: 'sequenced',
        sequencedAgeMs: 0,
        snapshotAgeMs: 0,
      });

      // A delta whose snapshot belongs to a superseded tracking revision must
      // NOT un-quarantine: recovery restores delivery, never lowers evidence.
      Object.assign(stream as unknown as Record<string, unknown>, {
        started: true,
        generation: 1,
        trackingRevision: 4,
        acknowledgedTrackingRevision: 4,
        subscribed: new Set(['KXSTATE']),
      });
      stream.ingest(snapshot(3), 1);
      expect(stream.bookState('KXSTATE', at).state).toBe('snapshot-quarantined');
      Object.assign(stream as unknown as Record<string, unknown>, { trackingRevision: 5 });
      stream.ingest(delta(4), 1);
      expect(stream.bookState('KXSTATE', at).state).toBe('snapshot-quarantined');
      expect(stream.getBook('KXSTATE', at)).toBeNull();
    });

    it('F: reaps a socket stuck in CONNECTING past the connect deadline', () => {
      vi.useFakeTimers();
      const at = 1_700_015_000_000;
      vi.setSystemTime(at);
      const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
      const socket = fakeSocket(WebSocket.CONNECTING);
      Object.assign(stream as unknown as Record<string, unknown>, {
        started: true,
        socket,
        generation: 2,
        connectAttemptStartedAt: at - ORDERBOOK_CONNECT_DEADLINE_MS,
      });
      const { spy, sockets } = stubConnect(stream);

      expect(stream.superviseDataPlane(at)).toMatchObject({ action: 'none', reason: 'connect in flight' });
      expect(spy).not.toHaveBeenCalled();

      const reaped = stream.superviseDataPlane(at + 1);
      expect(reaped).toMatchObject({
        action: 'reconnect-connect-timeout',
        nextAttemptInMs: ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS,
      });
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(sockets).toHaveLength(1);
      expect(stream.socketState()).toBe('connecting');
      stream.stop();
    });

    it('escalates to a bounded full stream restart after three failed supervised attempts', () => {
      vi.useFakeTimers();
      const at = 1_700_016_000_000;
      vi.setSystemTime(at);
      const registry = new ConnectorRegistry();
      const warn = vi.spyOn(registry, 'recordWarn');
      const stream = new KalshiOrderbookStream(registry, () => ({ authorization: 'test' }));
      Object.assign(stream as unknown as Record<string, unknown>, { started: true, socket: null });
      const { spy } = stubConnect(stream);

      const actions: string[] = [];
      let now = at;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = stream.superviseDataPlane(now);
        actions.push(result.action);
        now += result.nextAttemptInMs ?? 0;
        killSocket(stream);
      }
      expect(actions).toEqual([
        'reconnect-dead-socket',
        'reconnect-dead-socket',
        'reconnect-dead-socket',
        'stream-restarted',
      ]);
      expect(spy).toHaveBeenCalledTimes(4);
      expect(warn.mock.calls.some(([id, detail]) => id === 'kalshi-orderbook-ws' && /full stream restart/.test(detail)))
        .toBe(true);
      expect(stream.telemetry(now)).toMatchObject({
        supervisorEscalations: 4,
        lastSupervisionAction: 'stream-restarted',
      });

      // A real application frame proves the data plane came back: the ladder and
      // the backoff both reset to base.
      verifyTickers(stream, ['KXSTATE'], now);
      Object.assign(stream as unknown as Record<string, unknown>, { socket: fakeSocket(WebSocket.OPEN), generation: 9 });
      stream.ingest(JSON.stringify({
        type: 'orderbook_snapshot', seq: 1,
        msg: { market_ticker: 'KXSTATE', yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [] },
      }), 9);
      killSocket(stream);
      expect(stream.superviseDataPlane(now)).toMatchObject({
        action: 'reconnect-dead-socket',
        nextAttemptInMs: ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS,
      });
      stream.stop();
    });

    it('leaves an intentionally stopped stream stopped', () => {
      const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
      const { spy } = stubConnect(stream);
      expect(stream.superviseDataPlane(1_700_017_000_000)).toEqual({ action: 'none', reason: null, nextAttemptInMs: null });
      expect(spy).not.toHaveBeenCalled();
      expect(stream.socketState()).toBe('none');
    });

    it('restarts a missing heartbeat interval on an otherwise healthy open socket', () => {
      vi.useFakeTimers();
      const at = 1_700_018_000_000;
      vi.setSystemTime(at);
      const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
      const socket = fakeSocket(WebSocket.OPEN);
      Object.assign(stream as unknown as Record<string, unknown>, {
        started: true,
        socket,
        authenticated: true,
        generation: 6,
        connectedAt: at,
        lastApplicationMessageAt: at,
        lastPongAt: at,
      });
      expect(stream.superviseDataPlane(at)).toMatchObject({ action: 'heartbeat-restarted' });
      expect(stream.superviseDataPlane(at)).toMatchObject({ action: 'none' });
      vi.advanceTimersByTime(10_000);
      expect(socket.ping).toHaveBeenCalledTimes(1);
      stream.stop();
    });

    it('warns on the tripwire when a supervised attempt cannot even open a socket', () => {
      vi.useFakeTimers();
      const at = 1_700_019_000_000;
      vi.setSystemTime(at);
      const registry = new ConnectorRegistry();
      const warn = vi.spyOn(registry, 'recordWarn');
      // No credentials: connect() bails before constructing a socket, so after
      // supervision nothing is open, connecting, or scheduled.
      const stream = new KalshiOrderbookStream(registry, () => null);
      Object.assign(stream as unknown as Record<string, unknown>, { started: true });

      expect(stream.superviseDataPlane(at)).toMatchObject({ action: 'reconnect-dead-socket' });
      expect(stream.socketState()).toBe('none');
      expect(warn.mock.calls.some(([id, detail]) => id === 'kalshi-orderbook-ws' && /invariant violated/.test(detail)))
        .toBe(true);
      // Reported once per supervised attempt, so it can never spam the ledger.
      const warnsAfterFirst = warn.mock.calls.length;
      expect(stream.superviseDataPlane(at + 1)).toMatchObject({ action: 'none', reason: 'supervisor backoff pending' });
      expect(warn.mock.calls).toHaveLength(warnsAfterFirst);
      // The supervisor still keeps retrying rather than latching off.
      expect(stream.superviseDataPlane(at + ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS))
        .toMatchObject({ action: 'reconnect-dead-socket' });
      stream.stop();
    });

    it('returns invariant-violation when a socket vanishes with nothing armed to bring it back', () => {
      vi.useFakeTimers();
      const at = 1_700_020_000_000;
      vi.setSystemTime(at);
      const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
      Object.assign(stream as unknown as Record<string, unknown>, { started: true, socket: null });
      stubConnect(stream);

      expect(stream.superviseDataPlane(at)).toMatchObject({ action: 'reconnect-dead-socket' });
      // The attempt is in flight, so the invariant holds.
      expect(stream.superviseDataPlane(at + 1)).toMatchObject({ action: 'none', reason: 'connect in flight' });

      // Socket disappears mid-backoff with no timer armed: the tripwire state.
      killSocket(stream);
      const violation = stream.superviseDataPlane(at + 2);
      expect(violation.action).toBe('invariant-violation');
      expect(violation.reason).toContain('no reconnect scheduled');
      expect(violation.nextAttemptInMs).toBe(ORDERBOOK_SUPERVISOR_BASE_BACKOFF_MS - 2);
      expect(stream.superviseDataPlane(at + 3)).toMatchObject({ action: 'none' });
      stream.stop();
    });
  });

  // Task 2.3 Step 2. Measured on the 2026-07-27 paper run: `trackingRevision`
  // churned 3.0/min and the whole-universe invalidation left a median 25 of 25
  // tickers quarantined while a membership change was unacknowledged, so every
  // admission starved the next candidate. Invalidation is now scoped to the
  // tickers a change actually disturbed, and a fully proven book is carried
  // across the acknowledgement instead of needing a snapshot round-trip.
  describe('membership-change invalidation scope', () => {
    const SID = 7;

    type FakeOpenSocket = {
      readyState: number;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      ping: ReturnType<typeof vi.fn>;
    };

    interface SentCommand {
      id: number;
      cmd: string;
      params?: { sids?: number[]; market_tickers?: string[]; action?: string; channels?: string[] };
    }

    function lastCommand(socket: FakeOpenSocket, action: string): SentCommand {
      const matches = socket.send.mock.calls
        .map((call) => JSON.parse(String(call[0])) as SentCommand)
        .filter((command) => command.params?.action === action);
      const last = matches[matches.length - 1];
      if (!last) throw new Error(`no ${action} command was sent`);
      return last;
    }

    function snapshotFrame(ticker: string, seq: number): string {
      return JSON.stringify({
        type: 'orderbook_snapshot', sid: SID, seq,
        msg: { market_ticker: ticker, yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [['0.6000', '8.00']] },
      });
    }

    function deltaFrame(ticker: string, seq: number, tsMs: number): string {
      return JSON.stringify({
        type: 'orderbook_delta', sid: SID, seq,
        msg: { market_ticker: ticker, price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: tsMs },
      });
    }

    function okFrame(id: number, seq: number, marketTickers: string[]): string {
      return JSON.stringify({ id, type: 'ok', sid: SID, seq, msg: { market_tickers: marketTickers } });
    }

    /**
     * Opens a stream on the file's existing fake-socket seam, tracks `tickers`,
     * and drives the real subscribe → `subscribed` → acknowledge handshake, so
     * every test below starts from a genuinely acknowledged membership.
     */
    function openTrackedStream(tickers: string[], at: number) {
      const registry = new ConnectorRegistry();
      const stream = new KalshiOrderbookStream(registry, () => ({ authorization: 'test' }));
      const socket: FakeOpenSocket = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
        ping: vi.fn(),
      };
      Object.assign(stream as unknown as Record<string, unknown>, {
        socket,
        authenticated: true,
        generation: 1,
        started: true,
        lastPongAt: at,
      });
      verifyTickers(stream, tickers, at);
      stream.track(tickers, at);
      const subscribe = JSON.parse(String(socket.send.mock.calls[0]![0])) as SentCommand;
      stream.ingest(JSON.stringify({ id: subscribe.id, type: 'subscribed', msg: { sid: SID } }), 1);
      let seq = 0;
      return { registry, stream, socket, nextSeq: () => (seq += 1) };
    }

    /** Proves a book end to end: snapshot, then a sequenced exchange delta. */
    function proveBook(
      stream: KalshiOrderbookStream,
      ticker: string,
      at: number,
      nextSeq: () => number,
    ): void {
      stream.ingest(snapshotFrame(ticker, nextSeq()), 1);
      stream.ingest(deltaFrame(ticker, nextSeq(), at), 1);
    }

    it('1: carries a proven retained book across an unrelated add with no new snapshot', () => {
      vi.useFakeTimers();
      const at = 1_700_030_000_000;
      vi.setSystemTime(at);
      const { stream, socket, nextSeq } = openTrackedStream(['KX-KEEP'], at);
      proveBook(stream, 'KX-KEEP', at, nextSeq);
      expect(stream.telemetry(at)).toMatchObject({ qualifiedTickers: 1, trackingRevision: 1 });
      const snapshotsBefore = socket.send.mock.calls.length;

      verifyTickers(stream, ['KX-NEW'], at);
      stream.track(['KX-NEW'], at);

      // In flight: fail-closed by design — a stale revision is not qualified —
      // but the book itself survives the window.
      expect(stream.telemetry(at)).toMatchObject({ qualifiedTickers: 0, membershipAcknowledged: false });
      expect(stream.getBook('KX-KEEP', at)).toMatchObject({ sequence: 2, sourceTimestamp: at });
      expect(stream.bookState('KX-KEEP', at).state).toBe('sequenced');

      const add = lastCommand(socket, 'add_markets');
      expect(add.params?.market_tickers).toEqual(['KX-NEW']);
      stream.ingest(okFrame(add.id, nextSeq(), ['KX-NEW']), 1);

      // Re-qualified at the acknowledgement itself, with no orderbook_snapshot
      // delivered in between.
      expect(stream.telemetry(at)).toMatchObject({
        membershipAcknowledged: true,
        trackingRevision: 2,
        acknowledgedTrackingRevision: 2,
        qualifiedTickers: 1,
      });
      expect(stream.getBook('KX-KEEP', at)).toMatchObject({ sequence: 2, sourceTimestamp: at });
      expect(lastCommand(socket, 'get_snapshot').params?.market_tickers).toEqual(['KX-NEW']);
      expect(socket.send.mock.calls.length).toBe(snapshotsBefore + 2);
      stream.stop();
    });

    it('2: carries a proven retained book across a replaceTracked that removes a different ticker', () => {
      vi.useFakeTimers();
      const at = 1_700_031_000_000;
      vi.setSystemTime(at);
      const { stream, socket, nextSeq } = openTrackedStream(['KX-KEEP', 'KX-GONE'], at);
      proveBook(stream, 'KX-KEEP', at, nextSeq);
      proveBook(stream, 'KX-GONE', at, nextSeq);
      expect(stream.telemetry(at).qualifiedTickers).toBe(2);

      verifyTickers(stream, ['KX-NEW'], at);
      stream.replaceTracked(['KX-KEEP', 'KX-NEW'], at);
      expect(stream.getBook('KX-GONE', at)).toBeNull();
      expect(stream.getBook('KX-KEEP', at)).toMatchObject({ sequence: 2 });

      const remove = lastCommand(socket, 'delete_markets');
      expect(remove.params?.market_tickers).toEqual(['KX-GONE']);
      stream.ingest(okFrame(remove.id, nextSeq(), ['KX-GONE']), 1);
      const add = lastCommand(socket, 'add_markets');
      expect(add.params?.market_tickers).toEqual(['KX-NEW']);
      stream.ingest(okFrame(add.id, nextSeq(), ['KX-NEW']), 1);

      expect(stream.telemetry(at)).toMatchObject({ membershipAcknowledged: true, qualifiedTickers: 1 });
      expect(stream.getBook('KX-KEEP', at)).toMatchObject({ sequence: 2, sourceTimestamp: at });
      expect(lastCommand(socket, 'get_snapshot').params?.market_tickers).toEqual(['KX-NEW']);
      stream.stop();
    });

    it('3: a newly added ticker stays unqualified until its own snapshot and sequenced delta', () => {
      vi.useFakeTimers();
      const at = 1_700_032_000_000;
      vi.setSystemTime(at);
      const { stream, socket, nextSeq } = openTrackedStream(['KX-KEEP'], at);
      proveBook(stream, 'KX-KEEP', at, nextSeq);

      verifyTickers(stream, ['KX-NEW'], at);
      stream.track(['KX-NEW'], at);
      stream.ingest(okFrame(lastCommand(socket, 'add_markets').id, nextSeq(), ['KX-NEW']), 1);

      expect(stream.bookState('KX-NEW', at).state).toBe('subscribed-awaiting-snapshot');
      expect(stream.getBook('KX-NEW', at)).toBeNull();
      expect(stream.telemetry(at).qualifiedTickers).toBe(1);

      stream.ingest(snapshotFrame('KX-NEW', nextSeq()), 1);
      expect(stream.bookState('KX-NEW', at).state).toBe('snapshot-quarantined');
      expect(stream.getBook('KX-NEW', at)).toBeNull();
      expect(stream.telemetry(at).qualifiedTickers).toBe(1);

      stream.ingest(deltaFrame('KX-NEW', nextSeq(), at), 1);
      expect(stream.bookState('KX-NEW', at).state).toBe('sequenced');
      expect(stream.telemetry(at).qualifiedTickers).toBe(2);
      stream.stop();
    });

    it('4: a retained ticker that was already quarantined stays quarantined and is repaired', () => {
      vi.useFakeTimers();
      const at = 1_700_033_000_000;
      vi.setSystemTime(at);
      const { stream, socket, nextSeq } = openTrackedStream(['KX-KEEP'], at);
      proveBook(stream, 'KX-KEEP', at, nextSeq);

      // A delta carrying a second-based (invalid) exchange timestamp quarantines
      // the ticker without deleting its book — a genuine pre-change quarantine.
      stream.ingest(deltaFrame('KX-KEEP', nextSeq(), 1_700_033_000), 1);
      expect(stream.getBook('KX-KEEP', at)).toBeNull();
      expect(stream.telemetry(at)).toMatchObject({ quarantinedTickers: 1, qualifiedTickers: 0 });

      verifyTickers(stream, ['KX-NEW'], at);
      stream.track(['KX-NEW'], at);
      stream.ingest(okFrame(lastCommand(socket, 'add_markets').id, nextSeq(), ['KX-NEW']), 1);

      expect(lastCommand(socket, 'get_snapshot').params?.market_tickers).toEqual(['KX-KEEP', 'KX-NEW']);
      expect(stream.getBook('KX-KEEP', at)).toBeNull();
      expect(stream.bookState('KX-KEEP', at).state).toBe('subscribed-awaiting-snapshot');
      expect(stream.telemetry(at)).toMatchObject({ quarantinedTickers: 2, qualifiedTickers: 0 });
      stream.stop();
    });

    it('5: a snapshot-only book never carries forward, even if it is not quarantined', () => {
      vi.useFakeTimers();
      const at = 1_700_034_000_000;
      vi.setSystemTime(at);
      const { stream, socket, nextSeq } = openTrackedStream(['KX-SNAPONLY'], at);
      stream.ingest(snapshotFrame('KX-SNAPONLY', nextSeq()), 1);

      // Strip the quarantine flag so the ONLY remaining disqualifier is the
      // missing delta proof (deltaTrackingRevision is undefined).
      const quarantined = (stream as unknown as { quarantined: Set<string> }).quarantined;
      quarantined.delete('KX-SNAPONLY');
      expect(stream.telemetry(at).quarantinedTickers).toBe(0);

      verifyTickers(stream, ['KX-NEW'], at);
      stream.track(['KX-NEW'], at);
      stream.ingest(okFrame(lastCommand(socket, 'add_markets').id, nextSeq(), ['KX-NEW']), 1);

      expect(lastCommand(socket, 'get_snapshot').params?.market_tickers).toEqual(['KX-NEW', 'KX-SNAPONLY']);
      expect(stream.getBook('KX-SNAPONLY', at)).toBeNull();
      expect(stream.bookState('KX-SNAPONLY', at).state).toBe('subscribed-awaiting-snapshot');
      expect(stream.telemetry(at).qualifiedTickers).toBe(0);
      stream.stop();
    });

    it('6: a sequence break at the update acknowledgement still fails closed', () => {
      vi.useFakeTimers();
      const at = 1_700_035_000_000;
      vi.setSystemTime(at);
      const { registry, stream, socket, nextSeq } = openTrackedStream(['KX-KEEP'], at);
      const warn = vi.spyOn(registry, 'recordWarn');
      proveBook(stream, 'KX-KEEP', at, nextSeq);

      verifyTickers(stream, ['KX-NEW'], at);
      stream.track(['KX-NEW'], at);
      const snapshotRequestsBefore = socket.send.mock.calls.length;

      // Skip a sequence number on the acknowledgement itself.
      const gapped = nextSeq() + 1;
      stream.ingest(okFrame(lastCommand(socket, 'add_markets').id, gapped, ['KX-NEW']), 1);

      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.some(([id, detail]) =>
        id === 'kalshi-orderbook-ws' && /broke sequence continuity/.test(detail))).toBe(true);
      expect(stream.telemetry(at)).toMatchObject({
        acknowledgedTrackingRevision: null,
        membershipAcknowledged: false,
        qualifiedTickers: 0,
      });
      // Nothing was carried forward and no repair was enqueued on a broken stream.
      expect(socket.send.mock.calls.length).toBe(snapshotRequestsBefore);
      stream.stop();
    });

    it('7: a reconnect re-quarantines everything, carried-forward books included', () => {
      vi.useFakeTimers();
      const at = 1_700_036_000_000;
      vi.setSystemTime(at);
      const { stream, socket, nextSeq } = openTrackedStream(['KX-KEEP'], at);
      proveBook(stream, 'KX-KEEP', at, nextSeq);
      verifyTickers(stream, ['KX-NEW'], at);
      stream.track(['KX-NEW'], at);
      stream.ingest(okFrame(lastCommand(socket, 'add_markets').id, nextSeq(), ['KX-NEW']), 1);
      expect(stream.telemetry(at).qualifiedTickers).toBe(1);

      const reconnected: FakeOpenSocket = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
        ping: vi.fn(),
      };
      Object.assign(stream as unknown as Record<string, unknown>, { socket: reconnected, generation: 2 });
      (stream as unknown as { handleSocketOpen(s: WebSocket, g: number): void })
        .handleSocketOpen(reconnected as unknown as WebSocket, 2);

      expect(stream.getBook('KX-KEEP', at)).toBeNull();
      expect(stream.telemetry(at)).toMatchObject({
        qualifiedTickers: 0,
        quarantinedTickers: 2,
        acknowledgedTrackingRevision: null,
        membershipAcknowledged: false,
        serverTrackedTickers: 0,
      });
      // The reconnect resubscribes from scratch, so nothing can be carried
      // across a generation boundary.
      expect(JSON.parse(String(reconnected.send.mock.calls[0]![0]))).toMatchObject({ cmd: 'subscribe' });
      stream.stop();
      expect(socket.close).not.toHaveBeenCalled();
    });

    it('8: the repair set is exactly the disturbed and unproven tickers, not the universe', () => {
      vi.useFakeTimers();
      const at = 1_700_037_000_000;
      vi.setSystemTime(at);
      const tracked = ['KX-P1', 'KX-P2', 'KX-P3', 'KX-UNPROVEN'];
      const { stream, socket, nextSeq } = openTrackedStream(tracked, at);
      for (const ticker of ['KX-P1', 'KX-P2', 'KX-P3']) proveBook(stream, ticker, at, nextSeq);
      stream.ingest(snapshotFrame('KX-UNPROVEN', nextSeq()), 1);
      expect(stream.telemetry(at).qualifiedTickers).toBe(3);

      verifyTickers(stream, ['KX-NEW'], at);
      stream.track(['KX-NEW'], at);
      stream.ingest(okFrame(lastCommand(socket, 'add_markets').id, nextSeq(), ['KX-NEW']), 1);

      expect(lastCommand(socket, 'get_snapshot').params?.market_tickers).toEqual(['KX-NEW', 'KX-UNPROVEN']);
      expect(stream.telemetry(at)).toMatchObject({ qualifiedTickers: 3, quarantinedTickers: 2 });
      for (const ticker of ['KX-P1', 'KX-P2', 'KX-P3']) {
        expect(stream.getBook(ticker, at)).toMatchObject({ sequence: expect.any(Number) });
      }
      stream.stop();
    });

    it('9: five sequential membership changes leave a continuously retained book qualified', () => {
      vi.useFakeTimers();
      const at = 1_700_038_000_000;
      vi.setSystemTime(at);
      const { stream, socket, nextSeq } = openTrackedStream(['KX-KEEP'], at);
      proveBook(stream, 'KX-KEEP', at, nextSeq);
      const provenSequence = stream.getBook('KX-KEEP', at)!.sequence;

      for (let change = 0; change < 5; change += 1) {
        const ticker = `KX-CHURN-${change}`;
        verifyTickers(stream, [ticker], at);
        stream.track([ticker], at);

        // Mid-update the book is intentionally not qualified, but under the old
        // whole-universe wipe it would have been deleted outright and gone dark
        // for a full snapshot round-trip after every single change.
        expect(stream.telemetry(at).qualifiedTickers).toBe(0);
        expect(stream.getBook('KX-KEEP', at)).toMatchObject({ sequence: provenSequence });

        stream.ingest(okFrame(lastCommand(socket, 'add_markets').id, nextSeq(), [ticker]), 1);

        expect(stream.telemetry(at)).toMatchObject({
          membershipAcknowledged: true,
          qualifiedTickers: 1,
          trackingRevision: change + 2,
          acknowledgedTrackingRevision: change + 2,
        });
        expect(stream.getBook('KX-KEEP', at)).toMatchObject({ sequence: provenSequence, sourceTimestamp: at });
        // The churn tickers are never proven, so they stay in the repair set;
        // the proven retained ticker is never in it. Under the whole-universe
        // wipe every repair set was all 25 tickers, every 20 seconds.
        expect(lastCommand(socket, 'get_snapshot').params?.market_tickers)
          .toEqual(Array.from({ length: change + 1 }, (_, index) => `KX-CHURN-${index}`));
      }

      expect(stream.telemetry(at)).toMatchObject({ trackedTickers: 6, trackingRevision: 6 });
      stream.stop();
    });
  });

  // 2026-07-27 paper run, final hour: 44 Kalshi-side reconnects/hour, each of
  // which legitimately drops every book and re-quarantines every tracked ticker.
  // Recovery asked for one bulk get_snapshot over all 25 with no notion of which
  // handful had a candidate mid-confirmation; candidate book health fell to
  // 0.220. These tests pin the repair ORDER only — no evidence rule moves.
  describe('repair priority ordering', () => {
    const SID = 7;

    type FakeOpenSocket = {
      readyState: number;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      ping: ReturnType<typeof vi.fn>;
    };

    interface SentCommand {
      id: number;
      cmd: string;
      params?: { sids?: number[]; market_tickers?: string[]; action?: string; channels?: string[] };
    }

    function commands(socket: FakeOpenSocket, action: string): SentCommand[] {
      return socket.send.mock.calls
        .map((call) => JSON.parse(String(call[0])) as SentCommand)
        .filter((command) => command.params?.action === action);
    }

    function subscribeCommand(socket: FakeOpenSocket): SentCommand {
      const match = socket.send.mock.calls
        .map((call) => JSON.parse(String(call[0])) as SentCommand)
        .find((command) => command.cmd === 'subscribe');
      if (!match) throw new Error('no subscribe command was sent');
      return match;
    }

    function snapshotFrame(ticker: string, seq: number): string {
      return JSON.stringify({
        type: 'orderbook_snapshot', sid: SID, seq,
        msg: { market_ticker: ticker, yes_dollars_fp: [['0.4000', '10.00']], no_dollars_fp: [['0.6000', '8.00']] },
      });
    }

    function deltaFrame(ticker: string, seq: number, tsMs: number): string {
      return JSON.stringify({
        type: 'orderbook_delta', sid: SID, seq,
        msg: { market_ticker: ticker, price_dollars: '0.4100', delta_fp: '1.00', side: 'yes', ts_ms: tsMs },
      });
    }

    function pendingRepair(stream: KalshiOrderbookStream): Map<string, Set<string>> {
      return (stream as unknown as { pendingSnapshotRepair: Map<string, Set<string>> }).pendingSnapshotRepair;
    }

    /**
     * Opens a stream and drives the real subscribe → `subscribed` handshake. The
     * acknowledgement path then repairs every tracked ticker (none has a book
     * yet), which is exactly the post-reconnect repair set this change targets.
     */
    function openStream(tickers: string[], at: number, priority?: string[]) {
      const registry = new ConnectorRegistry();
      const stream = new KalshiOrderbookStream(registry, () => ({ authorization: 'test' }));
      const socket: FakeOpenSocket = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
        ping: vi.fn(),
      };
      Object.assign(stream as unknown as Record<string, unknown>, {
        socket,
        authenticated: true,
        generation: 1,
        started: true,
        lastPongAt: at,
      });
      verifyTickers(stream, tickers, at);
      if (priority) stream.setRepairPriority(priority);
      stream.track(tickers, at);
      let seq = 0;
      const handshake = () => {
        stream.ingest(JSON.stringify({
          id: subscribeCommand(socket).id,
          type: 'subscribed',
          msg: { sid: SID },
        }), 1);
      };
      return { registry, stream, socket, handshake, nextSeq: () => (seq += 1) };
    }

    const eight = ['KX-A', 'KX-B', 'KX-C', 'KX-D', 'KX-E', 'KX-F', 'KX-G', 'KX-H'];

    it('1: with no repair priority the repair is one command in today\'s sorted order', () => {
      vi.useFakeTimers();
      const at = 1_700_040_000_000;
      vi.setSystemTime(at);
      const { stream, socket, handshake } = openStream(eight, at);
      handshake();

      const snapshots = commands(socket, 'get_snapshot');
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.params?.market_tickers).toEqual([...eight].sort());
      // The subscribe command is untouched too.
      expect(subscribeCommand(socket).params?.market_tickers).toEqual(eight);
      stream.stop();
    });

    it('2: 2 of 8 prioritized produces exactly two commands, priority first', () => {
      vi.useFakeTimers();
      const at = 1_700_041_000_000;
      vi.setSystemTime(at);
      // Priority order (F before C) is deliberately not sorted order.
      const { stream, socket, handshake } = openStream(eight, at, ['KX-F', 'KX-C']);
      handshake();

      const snapshots = commands(socket, 'get_snapshot');
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]!.params?.market_tickers).toEqual(['KX-F', 'KX-C']);
      expect(snapshots[1]!.params?.market_tickers)
        .toEqual(['KX-A', 'KX-B', 'KX-D', 'KX-E', 'KX-G', 'KX-H']);
      // Same tickers, same count — only the order and the command split changed.
      expect([...snapshots.flatMap((c) => c.params?.market_tickers ?? [])].sort())
        .toEqual([...eight].sort());
      // Both frames are on the wire before any snapshot comes back, and the
      // priority frame was written first.
      const snapshotSendIndexes = socket.send.mock.calls
        .map((call, index) => ({ index, command: JSON.parse(String(call[0])) as SentCommand }))
        .filter(({ command }) => command.params?.action === 'get_snapshot');
      expect(snapshotSendIndexes).toHaveLength(2);
      expect(snapshotSendIndexes[0]!.command.params?.market_tickers).toEqual(['KX-F', 'KX-C']);
      expect(snapshotSendIndexes[0]!.index).toBeLessThan(snapshotSendIndexes[1]!.index);
      stream.stop();
    });

    it('3: every repair ticker prioritized collapses back to one command, in priority order', () => {
      vi.useFakeTimers();
      const at = 1_700_042_000_000;
      vi.setSystemTime(at);
      const scrambled = ['KX-H', 'KX-C', 'KX-A', 'KX-G', 'KX-B', 'KX-F', 'KX-E', 'KX-D'];
      const { stream, socket, handshake } = openStream(eight, at, scrambled);
      handshake();

      const snapshots = commands(socket, 'get_snapshot');
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.params?.market_tickers).toEqual(scrambled);
      stream.stop();
    });

    it('4: a priority set that intersects nothing leaves today\'s single command untouched', () => {
      vi.useFakeTimers();
      const at = 1_700_043_000_000;
      vi.setSystemTime(at);
      const { stream, socket, handshake } = openStream(eight, at, ['KX-NOT-TRACKED', 'KX-ALSO-NOT']);
      handshake();

      const snapshots = commands(socket, 'get_snapshot');
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.params?.market_tickers).toEqual([...eight].sort());
      expect(subscribeCommand(socket).params?.market_tickers).toEqual(eight);
      stream.stop();
    });

    it('5: pendingSnapshotRepair tracks the union and clears when both commands are answered', () => {
      vi.useFakeTimers();
      const at = 1_700_044_000_000;
      vi.setSystemTime(at);
      const { stream, socket, handshake, nextSeq } = openStream(eight, at, ['KX-F', 'KX-C']);
      handshake();

      expect(commands(socket, 'get_snapshot')).toHaveLength(2);
      expect([...pendingRepair(stream).get(String(SID)) ?? []].sort()).toEqual([...eight].sort());

      // Priority snapshots land first; the repair is still outstanding for the rest.
      for (const ticker of ['KX-F', 'KX-C']) stream.ingest(snapshotFrame(ticker, nextSeq()), 1);
      expect([...pendingRepair(stream).get(String(SID)) ?? []].sort())
        .toEqual(['KX-A', 'KX-B', 'KX-D', 'KX-E', 'KX-G', 'KX-H']);

      for (const ticker of ['KX-A', 'KX-B', 'KX-D', 'KX-E', 'KX-G', 'KX-H']) {
        stream.ingest(snapshotFrame(ticker, nextSeq()), 1);
      }
      expect(pendingRepair(stream).has(String(SID))).toBe(false);

      // Snapshot alone never qualifies anything — the evidence rule is unchanged.
      expect(stream.telemetry(at).qualifiedTickers).toBe(0);
      expect(stream.bookState('KX-F', at).state).toBe('snapshot-quarantined');
      stream.ingest(deltaFrame('KX-F', nextSeq(), at), 1);
      expect(stream.bookState('KX-F', at).state).toBe('sequenced');
      stream.stop();
    });

    it('6: a prioritized ticker with no provenance is still never admitted', () => {
      vi.useFakeTimers();
      const at = 1_700_045_000_000;
      vi.setSystemTime(at);
      const registry = new ConnectorRegistry();
      const stream = new KalshiOrderbookStream(registry, () => ({ authorization: 'test' }));
      const socket: FakeOpenSocket = {
        readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn(), ping: vi.fn(),
      };
      Object.assign(stream as unknown as Record<string, unknown>, {
        socket, authenticated: true, generation: 1, started: true, lastPongAt: at,
      });
      // Provenance is recorded for the tracked pair only; KX-NOPROV is prioritized
      // but has no production REST proof.
      verifyTickers(stream, ['KX-A', 'KX-B'], at);
      stream.setRepairPriority(['KX-NOPROV', 'KX-B']);
      stream.track(['KX-A', 'KX-B', 'KX-NOPROV'], at);

      expect(stream.isTracked('KX-NOPROV')).toBe(false);
      expect(stream.bookState('KX-NOPROV', at).state).toBe('untracked');
      expect(stream.getBook('KX-NOPROV', at)).toBeNull();
      expect(subscribeCommand(socket).params?.market_tickers).toEqual(['KX-B', 'KX-A']);

      stream.ingest(JSON.stringify({ id: subscribeCommand(socket).id, type: 'subscribed', msg: { sid: SID } }), 1);
      const snapshots = commands(socket, 'get_snapshot');
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]!.params?.market_tickers).toEqual(['KX-B']);
      expect(snapshots[1]!.params?.market_tickers).toEqual(['KX-A']);
      expect(snapshots.flatMap((c) => c.params?.market_tickers ?? [])).not.toContain('KX-NOPROV');

      // Even an unsolicited snapshot+delta for it cannot manufacture a book.
      stream.ingest(snapshotFrame('KX-NOPROV', 1), 1);
      stream.ingest(deltaFrame('KX-NOPROV', 2, at), 1);
      expect(stream.getBook('KX-NOPROV', at)).toBeNull();
      expect(stream.telemetry(at).trackedTickers).toBe(2);
      stream.stop();
    });

    it('7: setRepairPriority dedupes, is idempotent, and an empty array clears it', () => {
      vi.useFakeTimers();
      const at = 1_700_046_000_000;
      vi.setSystemTime(at);
      const { stream, socket, handshake, nextSeq } = openStream(eight, at);
      // Safe on every health tick: repeated calls send nothing and never touch
      // membership or the tracking revision.
      const sendsBefore = socket.send.mock.calls.length;
      const revisionBefore = stream.telemetry(at).trackingRevision;
      for (let i = 0; i < 5; i += 1) stream.setRepairPriority(['KX-F', 'KX-C', 'KX-F']);
      stream.setRepairPriority(['KX-F', 'KX-C']);
      expect(socket.send.mock.calls.length).toBe(sendsBefore);
      expect(stream.telemetry(at)).toMatchObject({
        trackingRevision: revisionBefore,
        trackedTickers: 8,
      });

      handshake();
      const withPriority = commands(socket, 'get_snapshot');
      expect(withPriority).toHaveLength(2);
      // Deduped: KX-F appears once, and the split is unaffected by the repeats.
      expect(withPriority[0]!.params?.market_tickers).toEqual(['KX-F', 'KX-C']);

      // Settle the outstanding repair so the next gap is free to enqueue.
      for (const ticker of eight) stream.ingest(snapshotFrame(ticker, nextSeq()), 1);
      expect(pendingRepair(stream).has(String(SID))).toBe(false);

      // Clearing restores today's exact single-command behavior on the next repair.
      stream.setRepairPriority([]);
      (stream as unknown as { quarantineSubscriptionAndRequestSnapshot(
        s: string, t: string | null, e: number, r: number): void })
        .quarantineSubscriptionAndRequestSnapshot(String(SID), 'KX-A', 5, 9);
      const afterClear = commands(socket, 'get_snapshot');
      expect(afterClear).toHaveLength(3);
      expect(afterClear[2]!.params?.market_tickers).toEqual([...eight].sort());
      stream.stop();
    });

    it('8: after a reconnect the priority tickers are subscribed and repaired ahead of the rest', () => {
      vi.useFakeTimers();
      const at = 1_700_047_000_000;
      vi.setSystemTime(at);
      const { stream, socket, handshake, nextSeq } = openStream(eight, at);
      handshake();
      for (const ticker of eight) stream.ingest(snapshotFrame(ticker, nextSeq()), 1);
      stream.ingest(deltaFrame('KX-A', nextSeq(), at), 1);
      expect(stream.telemetry(at).qualifiedTickers).toBe(1);
      // No priority set yet, so the pre-reconnect repair was one bulk command.
      expect(commands(socket, 'get_snapshot')).toHaveLength(1);

      // Entry confirmation goes in flight for two tickers, then Kalshi drops the
      // socket — the 44/hour case. handleSocketOpen drops every book and
      // re-quarantines every ticker; that fail-closed behavior is unchanged.
      stream.setRepairPriority(['KX-G', 'KX-D']);
      const reconnected: FakeOpenSocket = {
        readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn(), ping: vi.fn(),
      };
      Object.assign(stream as unknown as Record<string, unknown>, { socket: reconnected, generation: 2 });
      (stream as unknown as { handleSocketOpen(s: WebSocket, g: number): void })
        .handleSocketOpen(reconnected as unknown as WebSocket, 2);

      expect(stream.telemetry(at)).toMatchObject({ qualifiedTickers: 0, quarantinedTickers: 8 });
      const resubscribe = subscribeCommand(reconnected);
      expect(resubscribe.params?.market_tickers?.slice(0, 2)).toEqual(['KX-G', 'KX-D']);
      expect([...resubscribe.params?.market_tickers ?? []].sort()).toEqual([...eight].sort());

      stream.ingest(JSON.stringify({ id: resubscribe.id, type: 'subscribed', msg: { sid: SID } }), 2);
      const snapshots = commands(reconnected, 'get_snapshot');
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]!.params?.market_tickers).toEqual(['KX-G', 'KX-D']);
      expect(snapshots[1]!.params?.market_tickers)
        .toEqual(['KX-A', 'KX-B', 'KX-C', 'KX-E', 'KX-F', 'KX-H']);
      expect([...pendingRepair(stream).get(String(SID)) ?? []].sort()).toEqual([...eight].sort());
      stream.stop();
    });
  });
});
