import { describe, expect, it } from 'vitest';
import {
  applyPrint,
  isAloneAtTouch,
  isFilled,
  isStale,
  postQuote,
  visibleQueueAt,
  type BookTop,
  type RestingQuote,
} from './makerQueue.js';

const book = (bid: number, ask: number, bidSize: number, askSize: number): BookTop =>
  ({ bid, ask, bidSize, askSize });

describe('visibleQueueAt', () => {
  it('reports the full resting size when joining the touch', () => {
    expect(visibleQueueAt(book(0.40, 0.44, 120, 80), 'bid', 0.40)).toBe(120);
    expect(visibleQueueAt(book(0.40, 0.44, 120, 80), 'ask', 0.44)).toBe(80);
  });

  it('reports an empty queue when improving the touch', () => {
    expect(visibleQueueAt(book(0.40, 0.44, 120, 80), 'bid', 0.41)).toBe(0);
    expect(visibleQueueAt(book(0.40, 0.44, 120, 80), 'ask', 0.43)).toBe(0);
  });

  it('refuses to guess the queue deeper than the touch', () => {
    // A top-of-book snapshot says nothing about size resting at 0.39. Returning 0 here
    // would invent a free queue position, which is exactly the optimism to avoid.
    expect(visibleQueueAt(book(0.40, 0.44, 120, 80), 'bid', 0.39)).toBeNull();
    expect(visibleQueueAt(book(0.40, 0.44, 120, 80), 'ask', 0.45)).toBeNull();
  });
});

describe('postQuote', () => {
  it('joins the back of the visible queue', () => {
    const q = postQuote(book(0.40, 0.44, 120, 80), 'bid', 0.40, 25, 1_000);
    expect(q).not.toBeNull();
    expect(q!.aheadQty).toBe(120);
    expect(q!.filled).toBe(0);
  });

  it('returns null below the touch rather than assuming a position', () => {
    expect(postQuote(book(0.40, 0.44, 120, 80), 'bid', 0.38, 25, 0)).toBeNull();
  });

  it('rejects non-positive size', () => {
    expect(postQuote(book(0.40, 0.44, 120, 80), 'bid', 0.40, 0, 0)).toBeNull();
  });
});

describe('applyPrint queue consumption', () => {
  const fresh = (): RestingQuote =>
    postQuote(book(0.40, 0.44, 100, 50), 'bid', 0.40, 25, 0)!;

  it('does not fill while the queue ahead is still being eaten', () => {
    const q = fresh();
    // 60 contracts trade at our price: all of it is consumed by the 100 ahead of us.
    expect(applyPrint(q, { price: 0.40, qty: 60, takerSide: 'bid' }, 1)).toBeNull();
    expect(q.aheadQty).toBe(40);
    expect(q.filled).toBe(0);
  });

  it('fills only the volume that survives the queue ahead', () => {
    const q = fresh();
    // 130 at our price: 100 clears the queue, 30 reaches us, we only want 25.
    const fill = applyPrint(q, { price: 0.40, qty: 130, takerSide: 'bid' }, 2);
    expect(fill).not.toBeNull();
    expect(fill!.qty).toBe(25);
    expect(q.aheadQty).toBe(0);
    expect(isFilled(q)).toBe(true);
  });

  it('accumulates partial fills across prints and keeps its earned position', () => {
    const q = fresh();
    applyPrint(q, { price: 0.40, qty: 100, takerSide: 'bid' }, 1); // clears the queue exactly
    expect(q.aheadQty).toBe(0);
    expect(q.filled).toBe(0);
    const a = applyPrint(q, { price: 0.40, qty: 10, takerSide: 'bid' }, 2);
    const b = applyPrint(q, { price: 0.40, qty: 10, takerSide: 'bid' }, 3);
    expect(a!.qty).toBe(10);
    expect(b!.qty).toBe(10);
    expect(q.filled).toBe(20);
    expect(isFilled(q)).toBe(false);
  });

  it('ignores prints that hit the other side of the book', () => {
    const q = fresh();
    // Taker lifted the ask; resting bids are untouched.
    expect(applyPrint(q, { price: 0.40, qty: 500, takerSide: 'ask' }, 1)).toBeNull();
    expect(q.aheadQty).toBe(100);
  });

  it('ignores prints at a different price', () => {
    const q = fresh();
    expect(applyPrint(q, { price: 0.39, qty: 500, takerSide: 'bid' }, 1)).toBeNull();
    expect(q.aheadQty).toBe(100);
  });

  it('never over-fills a quote', () => {
    const q = fresh();
    applyPrint(q, { price: 0.40, qty: 100, takerSide: 'bid' }, 1);
    applyPrint(q, { price: 0.40, qty: 1_000, takerSide: 'bid' }, 2);
    expect(q.filled).toBe(25);
    expect(applyPrint(q, { price: 0.40, qty: 1_000, takerSide: 'bid' }, 3)).toBeNull();
  });

  it('never advances the queue on cancels, because cancels are invisible', () => {
    // Two identical quotes; one sees a quiet market. Public data cannot distinguish
    // "nobody cancelled" from "everyone cancelled", so the queue must not move.
    const q = fresh();
    const before = q.aheadQty;
    // time passes, no prints
    expect(q.aheadQty).toBe(before);
    expect(q.filled).toBe(0);
  });

  it('fills a quote that improved the touch on the first print', () => {
    const q = postQuote(book(0.40, 0.44, 100, 50), 'bid', 0.41, 25, 0)!;
    expect(q.aheadQty).toBe(0);
    const fill = applyPrint(q, { price: 0.41, qty: 5, takerSide: 'bid' }, 1);
    expect(fill!.qty).toBe(5);
  });
});

describe('isStale', () => {
  it('is stale once the market bids through our price', () => {
    const q = postQuote(book(0.40, 0.44, 100, 50), 'bid', 0.40, 25, 0)!;
    expect(isStale(q, book(0.40, 0.44, 100, 50))).toBe(false);
    expect(isStale(q, book(0.42, 0.46, 100, 50))).toBe(true);
  });

  it('is stale for an ask once the market offers through it', () => {
    const q = postQuote(book(0.40, 0.44, 100, 50), 'ask', 0.44, 25, 0)!;
    expect(isStale(q, book(0.40, 0.44, 100, 50))).toBe(false);
    expect(isStale(q, book(0.36, 0.40, 100, 50))).toBe(true);
  });
});

describe('isAloneAtTouch', () => {
  it('flags a quote that created its own level', () => {
    const q = postQuote(book(0.40, 0.44, 100, 50), 'bid', 0.41, 25, 0)!;
    expect(isAloneAtTouch(q)).toBe(true);
  });

  it('does not flag a quote that joined a real queue', () => {
    const q = postQuote(book(0.40, 0.44, 100, 50), 'bid', 0.40, 25, 0)!;
    expect(isAloneAtTouch(q)).toBe(false);
  });
});
