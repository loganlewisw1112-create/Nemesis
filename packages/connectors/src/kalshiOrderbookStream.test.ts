import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { getKalshiEndpointPolicy, resetKalshiProductionRetryCoordinatorForTests } from '@nemesis/core';
import { ConnectorRegistry } from './registry.js';
import { DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS } from './productionMarketProvenance.js';
import { KalshiOrderbookStream, type OrderbookTrackingStateV2 } from './kalshiOrderbookStream.js';
import {
  createKalshiTransportFailure,
  type KalshiProductionConnectionController,
  type KalshiSocketHealthV2,
} from './kalshiTransportController.js';

const productionRestBase = getKalshiEndpointPolicy('production').restBaseUrls[0]!;

function verifyTickers(stream: KalshiOrderbookStream, tickers: string[], verifiedAt = Date.now()): void {
  stream.recordProductionMarkets(tickers.map((ticker) => ({
    ticker,
    title: ticker,
    status: 'active',
  })), productionRestBase, verifiedAt);
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
});
