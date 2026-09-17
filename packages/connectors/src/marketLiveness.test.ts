import { describe, expect, it } from 'vitest';
import type { KalshiMarket } from '@nemesis/core';
import { isTradableMarketAt } from './marketLiveness.js';

const NOW = 1_785_000_000_000;

function market(overrides: Partial<KalshiMarket> = {}): KalshiMarket {
  return {
    ticker: 'KXBTCD-26JUL2807-T63499.99',
    title: 'BTC above 63499.99 at 07:00',
    status: 'active',
    yes_bid: 40,
    yes_ask: 44,
    no_bid: 56,
    no_ask: 60,
    volume: 120,
    volume_24h: 900,
    open_interest: 400,
    close_time: new Date(NOW + 30 * 60_000).toISOString(),
    ...overrides,
  } as KalshiMarket;
}

describe('isTradableMarketAt', () => {
  it('admits an active market whose close time is still ahead', () => {
    expect(isTradableMarketAt(market(), NOW)).toBe(true);
  });

  it('rejects a market Kalshi still calls active after its close time', () => {
    // The regression this exists for: discovery admitted these on status alone,
    // they generated cards, and provenance then refused them forever.
    const closed = market({ close_time: new Date(NOW - 60_000).toISOString() });
    expect(closed.status).toBe('active');
    expect(isTradableMarketAt(closed, NOW)).toBe(false);
  });

  it('treats the close instant itself as closed', () => {
    expect(isTradableMarketAt(market({ close_time: new Date(NOW).toISOString() }), NOW)).toBe(false);
  });

  it('admits an open market with no close time at all', () => {
    // Preserves the pre-existing provenance behavior: close_time is optional and
    // its absence must not silently empty a universe.
    expect(isTradableMarketAt(market({ status: 'open', close_time: undefined }), NOW)).toBe(true);
  });

  it('rejects a present-but-unparseable close time, matching the provenance gate', () => {
    expect(isTradableMarketAt(market({ close_time: 'not-a-date' }), NOW)).toBe(false);
  });

  it.each(['settled', 'determined', 'closed', 'finalized', 'initialized', ''])(
    'rejects status %s regardless of close time',
    (status) => {
      expect(isTradableMarketAt(market({ status }), NOW)).toBe(false);
    },
  );

  it('accepts both active and open, case-insensitively and with padding', () => {
    expect(isTradableMarketAt(market({ status: ' ACTIVE ' }), NOW)).toBe(true);
    expect(isTradableMarketAt(market({ status: 'Open' }), NOW)).toBe(true);
  });

  it('flips to false as time crosses the close, without the market changing', () => {
    const subject = market({ close_time: new Date(NOW + 60_000).toISOString() });
    expect(isTradableMarketAt(subject, NOW)).toBe(true);
    expect(isTradableMarketAt(subject, NOW + 59_999)).toBe(true);
    expect(isTradableMarketAt(subject, NOW + 60_001)).toBe(false);
  });
});
