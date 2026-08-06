/**
 * Queue-aware fill model for passive (maker) quoting.
 *
 * WHY THIS EXISTS: the measured edge for esports market making is +2.7c/contract at the
 * back of the queue, but "back of the queue" was a statistical proxy (prints large enough
 * to sweep the whole visible level). To size the opportunity we need to know how OFTEN a
 * resting quote actually fills, and that depends on queue position — which public L1 data
 * cannot observe directly. This module reconstructs queue position from the one thing we
 * can observe: the sequence of prints that consume our price level.
 *
 * EVERY UNOBSERVABLE IS RESOLVED PESSIMISTICALLY. The point of this simulator is to find
 * out whether the strategy survives honest assumptions, so wherever the data is silent we
 * choose the assumption that hurts us:
 *
 *  1. `aheadQty` never decreases except by an observed trade. Real queues also shrink when
 *     orders ahead of us CANCEL, which would advance us for free — but cancels are invisible
 *     in public data, so we never credit them. This under-estimates fill rate.
 *  2. Joining an existing price level puts us behind its ENTIRE visible size. We cannot know
 *     if some of that size is stale.
 *  3. A print only consumes our level if it prints AT our price. A print that sweeps through
 *     several levels is credited to us only for the portion at our price.
 *  4. Partial fills are tracked, and a partially-filled quote keeps its (now zero) queue
 *     position — it does not go back to the end of the line.
 *
 * The result is a LOWER BOUND on fill rate. If the strategy is profitable under this model
 * it is more profitable in reality; if it is not profitable here, it is not worth building.
 */

/** Which side of the book a resting order sits on. */
export type BookSide = 'bid' | 'ask';

/** Top-of-book snapshot. Sizes are aggregate resting quantity at that price. */
export interface BookTop {
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
}

/**
 * A single trade print.
 *
 * `takerSide` is the side of the BOOK the taker consumed, not the taker's direction:
 * `'bid'` means the taker sold into resting bids, so resting BIDS were filled.
 * This matches Kalshi's `taker_book_side` field directly, which is why we do not have
 * to infer trade direction with a tick rule (a real source of error in equity studies).
 */
export interface TradePrint {
  readonly price: number;
  readonly qty: number;
  readonly takerSide: BookSide;
}

/** A resting quote we have posted. Mutable: queue position and fills evolve. */
export interface RestingQuote {
  readonly side: BookSide;
  readonly price: number;
  readonly size: number;
  /** Contracts of ours filled so far. */
  filled: number;
  /** Contracts ahead of us at our price level. Never increases; only trades reduce it. */
  aheadQty: number;
  readonly postedAt: number;
}

export interface Fill {
  readonly side: BookSide;
  readonly price: number;
  readonly qty: number;
  readonly at: number;
}

/** Prices live on a 1-cent grid; compare with a tolerance well inside half a cent. */
const PRICE_EPS = 1e-6;
const samePrice = (a: number, b: number): boolean => Math.abs(a - b) < PRICE_EPS;

/**
 * Resting size at `price` on `side`, as far as a top-of-book snapshot can tell.
 * Returns 0 for a price strictly better than the touch (we would be alone at a new
 * level, hence no queue), and `null` when the price is worse than the touch — the
 * snapshot simply does not say what rests deeper in the book.
 */
export function visibleQueueAt(book: BookTop, side: BookSide, price: number): number | null {
  if (side === 'bid') {
    if (samePrice(price, book.bid)) return book.bidSize;
    if (price > book.bid) return 0;          // improves the bid: new level, no one ahead
    return null;                              // deeper in the book: unobservable
  }
  if (samePrice(price, book.ask)) return book.askSize;
  if (price < book.ask) return 0;            // improves the ask
  return null;
}

/**
 * Create a resting quote. Returns `null` when the requested price sits deeper than the
 * touch, because we cannot bound the queue there and guessing would defeat the purpose.
 */
export function postQuote(
  book: BookTop,
  side: BookSide,
  price: number,
  size: number,
  at: number,
): RestingQuote | null {
  if (!(size > 0) || !Number.isFinite(price)) return null;
  const ahead = visibleQueueAt(book, side, price);
  if (ahead == null) return null;
  return { side, price, size, filled: 0, aheadQty: ahead, postedAt: at };
}

/**
 * Apply one print to one resting quote, mutating its queue position and fill count.
 *
 * A print consumes our level only when it hits OUR side at OUR price. Its volume first
 * eats the queue ahead of us, and only the remainder fills us — which is precisely the
 * back-of-queue disadvantage the strategy has to survive.
 */
export function applyPrint(quote: RestingQuote, print: TradePrint, at: number): Fill | null {
  if (print.takerSide !== quote.side) return null;
  if (!samePrice(print.price, quote.price)) return null;
  const remaining = quote.size - quote.filled;
  if (remaining <= 0) return null;

  let volume = print.qty;
  if (quote.aheadQty > 0) {
    const eaten = Math.min(volume, quote.aheadQty);
    quote.aheadQty -= eaten;
    volume -= eaten;
  }
  if (volume <= 0) return null;

  const qty = Math.min(volume, remaining);
  quote.filled += qty;
  return { side: quote.side, price: quote.price, qty, at };
}

/** True once the quote has no remaining size. */
export function isFilled(quote: RestingQuote): boolean {
  return quote.filled >= quote.size;
}

/**
 * Whether a quote has drifted off the touch and should be repriced.
 *
 * Repricing is not free: cancelling and reposting sends us to the back of the NEW level's
 * queue, discarding whatever position we had earned. The simulator therefore has to pay
 * that cost explicitly rather than silently keeping a good queue position at a new price.
 */
export function isStale(quote: RestingQuote, book: BookTop): boolean {
  if (quote.side === 'bid') return quote.price < book.bid - PRICE_EPS;
  return quote.price > book.ask + PRICE_EPS;
}

/**
 * Whether our own quote is the only thing at the touch, meaning the "spread" we are
 * quoting against is partly our own order. Used to avoid counting a spread we created
 * ourselves as captured edge.
 */
export function isAloneAtTouch(quote: RestingQuote): boolean {
  return quote.aheadQty === 0 && quote.filled === 0;
}
