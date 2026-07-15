import { describe, expect, it } from 'vitest';
import type { KalshiTapeState } from '@nemesis/connectors';
import { buildExitExecutionContext } from './exitExecutionContext.js';

function tape(): KalshiTapeState {
  return {
    snapshotCount: 1,
    tradeCount: 0,
    orderbookCount: 1,
    trackedTickers: ['KXTEST-26'],
    latestSnapshots: [{
      id: 'snapshot', ticker: 'KXTEST-26', yes_bid: 0.44, yes_ask: 0.46, yes_price: 0.45,
      no_bid: 0.54, no_ask: 0.56, volume: 12.5, spread: 0.02, timestamp: 900, source: 'rest-market',
    }],
    latestTrades: [],
    latestOrderbooks: [{
      id: 'book', ticker: 'KXTEST-26',
      yes_levels_json: JSON.stringify([{ price: 0.44, quantity: 1.25 }, { price: 0.43, quantity: 2.5 }]),
      no_levels_json: JSON.stringify([{ price: 0.54, quantity: 1.5 }, { price: 0.53, quantity: 0.75 }]),
      best_yes_bid: 0.44, yes_ask: 0.46, no_ask: 0.56, spread: 0.02, timestamp: 1_000,
      observed_at: 1_000, exchange_timestamp: 950, exchange_sequence: 12,
    }],
    freshness: {
      marketSnapshotAgeMs: 0,
      tradeTapeAgeMs: null,
      orderbookObservationAgeMs: 100,
      exchangeDeltaAgeMs: 150,
      kalshiTapeAgeMs: 0,
      stale: false,
    },
  };
}

describe('buildExitExecutionContext', () => {
  it('uses the matching YES and NO executable bids and preserves fractional depth', () => {
    expect(buildExitExecutionContext(tape(), 'KXTEST-26', 'yes', 1_100, 500)).toMatchObject({
      executable_close_price: 0.44,
      book_depth: 3.75,
      price_source: 'kalshi-orderbook',
      expires_at: 1_600,
    });
    expect(buildExitExecutionContext(tape(), 'KXTEST-26', 'no', 1_100, 500)).toMatchObject({
      executable_close_price: 0.54,
      book_depth: 2.25,
      price_source: 'kalshi-orderbook',
    });
  });

  it('falls back to the matching snapshot side and rejects depth below one', () => {
    const state = tape();
    state.latestOrderbooks = [];
    expect(buildExitExecutionContext(state, 'KXTEST-26', 'no', 1_100, 500)).toMatchObject({
      executable_close_price: 0.54,
      book_depth: 12.5,
      price_source: 'kalshi-snapshot',
    });
    state.latestSnapshots[0].volume = 0.5;
    expect(buildExitExecutionContext(state, 'KXTEST-26', 'yes', 1_100, 500)).toBeNull();
  });
});
