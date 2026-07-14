import { describe, expect, it } from 'vitest';
import type { KalshiTrade } from '@nemesis/core';
import { tradeToThesis } from './flow-hunter.js';

describe('flow-hunter trade routing', () => {
  it('scores no-side taker flow using the no-side notional and direction', () => {
    const trade: KalshiTrade = {
      trade_id: 'no-whale',
      ticker: 'KXNO-WHALE',
      yes_price: 20,
      no_price: 80,
      count: 1_000,
      taker_side: 'no',
      created_time: '2026-07-13T23:00:00Z',
    };

    const card = tradeToThesis(trade, undefined, Date.parse('2026-07-13T23:00:30Z'));

    expect(card).toMatchObject({
      ticker: 'KXNO-WHALE',
      playbook: 'flow-hunter',
      side: 'no',
      marketPrice: 0.8,
      status: 'tradeable',
    });
    expect(card?.impliedPrice).toBeGreaterThan(card?.marketPrice ?? 1);
    expect(card?.externalSummary).toBe('Large taker flow $800');
  });

  it('fails the freshness gate for an old cached trade print', () => {
    const card = tradeToThesis({
      trade_id: 'stale-whale',
      ticker: 'KXSTALE-WHALE',
      yes_price: 70,
      no_price: 30,
      count: 1_000,
      taker_side: 'yes',
      created_time: '2026-07-13T22:00:00Z',
    }, undefined, Date.parse('2026-07-13T23:00:00Z'));

    expect(card).toMatchObject({
      ticker: 'KXSTALE-WHALE',
      status: 'stale',
      freshnessMs: 3_600_000,
    });
    expect(card?.invalidations).toContain('freshness');
  });
});
