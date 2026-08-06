import { describe, expect, it } from 'vitest';
import type { KalshiFeePolicy } from '@nemesis/core';
import { DEFAULT_MAKER_SIM_CONFIG, MakerSimulator } from './makerSim.js';
import type { BookTop } from './makerQueue.js';

const TAKER: KalshiFeePolicy = {
  known: true,
  role: 'taker',
  multiplier: 1,
  accountPrecision: 'non_direct',
  scheduleVersion: '2026-07-07',
  source: 'test',
  feeType: 'quadratic',
};

const cfg = (over: Partial<Parameters<typeof MakerSimulator.prototype.constructor>[0]> = {}) =>
  ({ ...DEFAULT_MAKER_SIM_CONFIG, feePolicy: TAKER, ...over } as any);

const book = (bid: number, ask: number, bidSize = 0, askSize = 0): BookTop =>
  ({ bid, ask, bidSize, askSize });

describe('MakerSimulator round trips', () => {
  it('captures the full spread with zero fees when both sides fill passively', () => {
    // 40/44 with nothing ahead of us: both quotes are alone at the touch.
    const sim = new MakerSimulator(cfg({ quoteSize: 10, inventoryMaxAgeMs: null }));
    const b = book(0.40, 0.44);
    sim.onBook('T', b, 0);
    sim.onPrint('T', { price: 0.40, qty: 10, takerSide: 'bid' }, 100);  // we buy at 0.40
    sim.onBook('T', b, 200);
    sim.onPrint('T', { price: 0.44, qty: 10, takerSide: 'ask' }, 300);  // we sell at 0.44
    const r = sim.finish(400);
    expect(r.makerContracts).toBe(20);
    expect(r.residualInventory).toBe(0);
    expect(r.feesUsd).toBe(0);                       // maker fills are free on `quadratic`
    expect(r.netPnlUsd).toBeCloseTo(10 * 0.04, 6);   // 4c spread x 10 contracts
  });

  it('loses money when forced to cross out of inventory', () => {
    // Buy at the bid, then the aged-inventory rule crosses back into the bid: we give up
    // the spread we were trying to earn AND pay the taker fee.
    const sim = new MakerSimulator(cfg({ quoteSize: 10, inventoryMaxAgeMs: 1_000 }));
    const b = book(0.40, 0.44);
    sim.onBook('T', b, 0);
    sim.onPrint('T', { price: 0.40, qty: 10, takerSide: 'bid' }, 100);
    sim.onBook('T', b, 5_000);                       // inventory is now aged -> flatten
    const r = sim.finish(6_000);
    expect(r.crossedContracts).toBe(10);
    expect(r.feesUsd).toBeGreaterThan(0);
    expect(r.netPnlUsd).toBeLessThan(0);
  });

  it('marks residual inventory at the exitable price, never better than the mid', () => {
    const sim = new MakerSimulator(cfg({ quoteSize: 10, inventoryMaxAgeMs: null }));
    sim.onBook('T', book(0.40, 0.44), 0);
    sim.onPrint('T', { price: 0.40, qty: 10, takerSide: 'bid' }, 100);
    // finish() without force-flatten still marks honestly (bid for a long).
    const r = sim.finish(200, false);
    expect(r.residualInventory).toBe(10);
    expect(r.netPnlUsd).toBeLessThanOrEqual(r.netPnlAtMidUsd);
  });

  it('force-flattens residual inventory so the exit cost is not deferred', () => {
    const sim = new MakerSimulator(cfg({ quoteSize: 10, inventoryMaxAgeMs: null }));
    sim.onBook('T', book(0.40, 0.44), 0);
    sim.onPrint('T', { price: 0.40, qty: 10, takerSide: 'bid' }, 100);
    const r = sim.finish(200, true);
    expect(r.residualInventory).toBe(0);
    expect(r.crossedContracts).toBe(10);
    expect(r.feesUsd).toBeGreaterThan(0);
  });
});

describe('MakerSimulator risk limits', () => {
  it('stops bidding once long inventory hits the cap', () => {
    const sim = new MakerSimulator(cfg({ quoteSize: 10, maxInventoryPerTicker: 10, inventoryMaxAgeMs: null }));
    const b = book(0.40, 0.44);
    sim.onBook('T', b, 0);
    sim.onPrint('T', { price: 0.40, qty: 10, takerSide: 'bid' }, 100);   // inventory 10 = cap
    sim.onBook('T', b, 200);                                             // must not re-bid
    sim.onPrint('T', { price: 0.40, qty: 10, takerSide: 'bid' }, 300);
    const r = sim.finish(400, false);
    expect(r.perTicker.get('T')!.inventory).toBe(10);                    // no further buying
  });

  it('respects the capital ceiling across many tickers', () => {
    // $10 of capital cannot support 25-contract quotes at 40c on ten tickers.
    const sim = new MakerSimulator(cfg({ quoteSize: 25, capitalUsd: 10, inventoryMaxAgeMs: null }));
    for (let i = 0; i < 10; i += 1) sim.onBook(`T${i}`, book(0.40, 0.44), 0);
    for (let i = 0; i < 10; i += 1) sim.onPrint(`T${i}`, { price: 0.40, qty: 25, takerSide: 'bid' }, 100);
    const r = sim.finish(200, false);
    expect(r.makerContracts).toBeLessThan(250);
  });

  it('does not quote a crossed or degenerate book', () => {
    const sim = new MakerSimulator(cfg());
    sim.onBook('T', book(0.44, 0.40), 0);        // crossed
    sim.onBook('U', book(0, 0.5), 0);            // no bid
    sim.onPrint('T', { price: 0.44, qty: 10, takerSide: 'bid' }, 10);
    const r = sim.finish(20, false);
    expect(r.makerContracts).toBe(0);
  });
});

describe('MakerSimulator queue realism', () => {
  it('does not fill behind a deep queue', () => {
    // 5,000 resting ahead of us and only 100 trades: a real back-of-queue order gets nothing.
    const sim = new MakerSimulator(cfg({ quoteSize: 25, inventoryMaxAgeMs: null }));
    sim.onBook('T', book(0.40, 0.44, 5_000, 5_000), 0);
    sim.onPrint('T', { price: 0.40, qty: 100, takerSide: 'bid' }, 100);
    const r = sim.finish(200, false);
    expect(r.makerContracts).toBe(0);
  });

  it('counts a reprice when the market moves through our quote', () => {
    const sim = new MakerSimulator(cfg({ quoteSize: 10, repriceOnStale: true, inventoryMaxAgeMs: null }));
    sim.onBook('T', book(0.40, 0.44), 0);
    sim.onBook('T', book(0.46, 0.50), 100);      // both quotes now stale
    const r = sim.finish(200, false);
    expect(r.repriced).toBeGreaterThan(0);
  });
});
