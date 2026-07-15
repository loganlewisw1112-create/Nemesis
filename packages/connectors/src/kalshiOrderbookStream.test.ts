import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ConnectorRegistry } from './registry.js';
import { KalshiOrderbookStream } from './kalshiOrderbookStream.js';

describe('KalshiOrderbookStream', () => {
  afterEach(() => vi.useRealTimers());

  it('uses exchange delta timestamp and sequence, never local snapshot time', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
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
    expect(book?.no).toContainEqual({ price: 0.59, quantity: 5 });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ sequence: 3, sourceTimestamp: 1_669_149_841_000 });
  });

  it('drops a book on sequence regression', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
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

  it('tracks sequence continuity per subscription, not per ticker', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
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

  it('stops qualification after 25 seconds without a sequenced exchange delta even while pongs remain live', () => {
    vi.useFakeTimers();
    const deltaAt = 1_700_000_000_000;
    vi.setSystemTime(deltaAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket: { readyState: WebSocket.OPEN },
      authenticated: true,
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

  it('terminates an authenticated half-open socket after ping-pong traffic expires', async () => {
    vi.useFakeTimers();
    const startedAt = 1_700_000_100_000;
    vi.setSystemTime(startedAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
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
      lastPongAt: startedAt,
      lastSequencedDeltaAt: startedAt,
    });
    (stream as unknown as { startHeartbeat(socket: WebSocket, generation: number): void })
      .startHeartbeat(socket, 4);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(stream.telemetry(startedAt + 30_000).qualificationReady).toBe(false);
    stream.stop();
  });

  it('allows only the current authenticated generation to repair qualification', () => {
    vi.useFakeTimers();
    const recoveredAt = 1_700_000_200_000;
    vi.setSystemTime(recoveredAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket: { readyState: WebSocket.OPEN },
      authenticated: true,
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

  it('repairs only the gapped subscription while another subscription remains qualified', () => {
    vi.useFakeTimers();
    const recoveredAt = 1_700_000_300_000;
    vi.setSystemTime(recoveredAt);
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    Object.assign(stream as unknown as Record<string, unknown>, {
      socket,
      authenticated: true,
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
      qualificationReady: true,
    });

    // The official sequenced OK response advances continuity without mutating
    // books or causing a false second repair request.
    stream.ingest(JSON.stringify({
      type: 'ok', sid: 8, seq: 7,
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
