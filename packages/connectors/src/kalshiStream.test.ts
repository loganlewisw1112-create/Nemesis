import { describe, expect, it } from 'vitest';
import { getKalshiEndpointPolicy } from '@nemesis/core';
import { ConnectorRegistry } from './registry.js';
import { KalshiStream } from './kalshiStream.js';

describe('KalshiStream replay safety', () => {
  it('ignores callbacks from stale socket generations', () => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => null);
    const seen: string[] = [];
    stream.onQuote((quote) => seen.push(quote.ticker));
    (stream as unknown as { generation: number }).generation = 2;
    stream.ingest(JSON.stringify({
      type: 'ticker',
      seq: 1,
      msg: { market_ticker: 'KXSTALE', yes_bid: 40, yes_ask: 42 },
    }), 1);
    expect(seen).toEqual([]);
  });

  it('detects sequence gaps before publishing a newer quote', () => {
    const registry = new ConnectorRegistry();
    const stream = new KalshiStream(registry, () => null);
    const seen: string[] = [];
    stream.onQuote((quote) => seen.push(quote.ticker));
    stream.ingest(JSON.stringify({ type: 'ticker', seq: 10, msg: { market_ticker: 'KXONE', yes_bid: 40, yes_ask: 42 } }));
    stream.ingest(JSON.stringify({ type: 'ticker', seq: 12, msg: { market_ticker: 'KXTWO', yes_bid: 45, yes_ask: 47 } }));
    expect(seen).toEqual(['KXONE']);
    expect(stream.telemetry().sequenceGaps).toBe(1);
    expect(registry.get('kalshi-ticker-ws')?.qualificationReady).toBe(false);
  });

  it('rotates only through production websocket policy aliases after a failure', () => {
    const stream = new KalshiStream(new ConnectorRegistry(), () => ({ authorization: 'test' }));
    const policy = getKalshiEndpointPolicy('production').websocketUrls;
    const internals = stream as unknown as { advanceEndpoint(): void };
    expect(stream.telemetry().endpointUrl).toBe(policy[0]);
    internals.advanceEndpoint();
    expect(stream.telemetry().endpointUrl).toBe(policy[1]);
    internals.advanceEndpoint();
    expect(stream.telemetry().endpointUrl).toBe(policy[0]);
  });
});
