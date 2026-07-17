import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { resetKalshiProductionRetryCoordinatorForTests } from '@nemesis/core';
import { ConnectorRegistry } from './registry.js';
import { KalshiStream } from './kalshiStream.js';
import type { KalshiProductionConnectionController, KalshiSocketHealthV2 } from './kalshiTransportController.js';

interface StreamInternals {
  generation: number;
  authenticated: boolean;
  lastPongAt: number | null;
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

  it('detects sequence gaps before publishing a newer quote', () => {
    const registry = new ConnectorRegistry();
    const stream = new KalshiStream(registry, () => null);
    const seen: string[] = [];
    stream.onQuote((quote) => seen.push(quote.ticker));
    const { generation } = primeCurrentGeneration(stream, ['KXONE', 'KXTWO']);
    const now = Date.now();
    stream.ingest(JSON.stringify({ type: 'ticker', sid: 1, seq: 10, msg: { market_ticker: 'KXONE', yes_bid: 40, yes_ask: 42, ts_ms: now } }), generation);
    stream.ingest(JSON.stringify({ type: 'ticker', sid: 1, seq: 12, msg: { market_ticker: 'KXTWO', yes_bid: 45, yes_ask: 47, ts_ms: now } }), generation);
    expect(seen).toEqual(['KXONE']);
    expect(stream.telemetry().sequenceGaps).toBe(1);
    expect(registry.get('kalshi-ticker-ws')?.qualificationReady).toBe(false);
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

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe exchange sequence %s before caching or emitting', (sequence) => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => null);
    const seen: string[] = [];
    stream.onQuote((quote) => seen.push(quote.ticker));
    const { generation } = primeCurrentGeneration(stream, ['KXBADSEQ']);
    stream.ingest(JSON.stringify({
      type: 'ticker', sid: 1, seq: sequence,
      msg: { market_ticker: 'KXBADSEQ', yes_bid: 40, yes_ask: 42, ts_ms: Date.now() },
    }), generation);
    expect(stream.getQuote('KXBADSEQ')).toBeUndefined();
    expect(seen).toEqual([]);
    expect(stream.telemetry().failureClass).toBe('sequence');
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
