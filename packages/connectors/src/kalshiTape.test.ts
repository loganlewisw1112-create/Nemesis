import { describe, expect, it } from 'vitest';
import type { KalshiMarket, KalshiOrderbook, KalshiTrade } from '@nemesis/core';
import {
  KalshiTapeEngine,
  marketToTapeSnapshot,
  orderbookToTapeSnapshot,
  tradeToTapePrint,
  type KalshiTapeSink,
} from './kalshiTape.js';

function captureSink() {
  const snapshots: unknown[] = [];
  const trades: unknown[] = [];
  const books: unknown[] = [];
  const sink: KalshiTapeSink = {
    insertMarketSnapshot: (snapshot) => { snapshots.push(snapshot); },
    insertTradePrint: (trade) => { trades.push(trade); },
    insertOrderbookSnapshot: (book) => { books.push(book); },
  };
  return { sink, snapshots, trades, books };
}

describe('Kalshi tape normalization', () => {
  it('normalizes market prices into a storable snapshot', () => {
    const market: KalshiMarket = {
      ticker: 'KXPHASE4-26',
      title: 'Phase 4 demo market',
      status: 'open',
      yes_bid: 41,
      yes_ask_dollars: '0.44',
      no_bid: 55,
      no_ask: 59,
      volume_24h: 1234,
    };

    const snapshot = marketToTapeSnapshot(market, 1_772_000_000_000);

    expect(snapshot).toMatchObject({
      ticker: 'KXPHASE4-26',
      yes_bid: 0.41,
      yes_ask: 0.44,
      yes_price: 0.44,
      no_bid: 0.55,
      no_ask: 0.59,
      volume: 1234,
      timestamp: 1_772_000_000_000,
      source: 'rest-market',
    });
  });

  it('converts trades and orderbooks into durable tape records', () => {
    const trade: KalshiTrade = {
      trade_id: 'tr-1',
      ticker: 'KXPHASE4-26',
      yes_price: 47,
      no_price: 53,
      count: 12,
      taker_side: 'yes',
      created_time: '2026-06-25T12:00:00Z',
    };
    const book: KalshiOrderbook = {
      ticker: 'KXPHASE4-26',
      yes: [{ price: 0.46, quantity: 20 }],
      no: [{ price: 0.52, quantity: 15 }],
      yesAsk: 0.48,
      noAsk: 0.54,
      spread: 0.02,
      sourceTimestamp: 1_772_000_000_900,
      sequence: 42,
    };

    expect(tradeToTapePrint(trade)).toMatchObject({
      id: 'tr-1',
      ticker: 'KXPHASE4-26',
      yes_price: 0.47,
      count: 12,
      taker_side: 'yes',
    });

    expect(orderbookToTapeSnapshot(book, 1_772_000_001_000)).toMatchObject({
      ticker: 'KXPHASE4-26',
      best_yes_bid: 0.46,
      yes_ask: 0.48,
      no_ask: 0.54,
      spread: 0.02,
      timestamp: 1_772_000_001_000,
      observed_at: 1_772_000_001_000,
      exchange_timestamp: 1_772_000_000_900,
      exchange_sequence: 42,
    });
  });
});

describe('KalshiTapeEngine', () => {
  it('writes market, trade, and orderbook records through the sink', () => {
    const { sink, snapshots, trades, books } = captureSink();
    const engine = new KalshiTapeEngine({ sink });

    engine.ingestMarket({
      ticker: 'KXPHASE4-26',
      title: 'Phase 4 demo market',
      status: 'open',
      yes_bid: 41,
      yes_ask: 44,
      volume: 100,
    });
    engine.ingestTrade({
      trade_id: 'tr-1',
      ticker: 'KXPHASE4-26',
      yes_price: 47,
      no_price: 53,
      count: 4,
      taker_side: 'no',
      created_time: '2026-06-25T12:00:00Z',
    });
    engine.ingestOrderbook({
      ticker: 'KXPHASE4-26',
      yes: [{ price: 0.41, quantity: 10 }],
      no: [{ price: 0.55, quantity: 10 }],
      yesAsk: 0.45,
      spread: 0.04,
    });

    expect(snapshots).toHaveLength(1);
    expect(trades).toHaveLength(1);
    expect(books).toHaveLength(1);
    expect(engine.getState()).toMatchObject({
      snapshotCount: 1,
      tradeCount: 1,
      orderbookCount: 1,
      trackedTickers: ['KXPHASE4-26'],
    });
  });
});
