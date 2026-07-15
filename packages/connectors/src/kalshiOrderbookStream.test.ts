import { describe, expect, it } from 'vitest';
import { ConnectorRegistry } from './registry.js';
import { KalshiOrderbookStream } from './kalshiOrderbookStream.js';

describe('KalshiOrderbookStream', () => {
  it('uses exchange delta timestamp and sequence, never local snapshot time', () => {
    const stream = new KalshiOrderbookStream(new ConnectorRegistry(), () => null);
    stream.ingest(JSON.stringify({
      type: 'orderbook_snapshot',
      seq: 2,
      msg: {
        market_ticker: 'KXTEST',
        yes_dollars_fp: [['0.4000', '10.00']],
        no_dollars_fp: [['0.5800', '20.00']],
      },
    }));
    expect(stream.getBook('KXTEST')).toMatchObject({ sequence: 2, sourceTimestamp: undefined });

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
  });
});
