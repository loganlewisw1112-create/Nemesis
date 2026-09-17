import { kalshiFeeForOrder, type KalshiFeePolicy } from '@nemesis/core';
import {
  applyPrint,
  isFilled,
  isStale,
  postQuote,
  type BookSide,
  type BookTop,
  type RestingQuote,
  type TradePrint,
} from './makerQueue.js';

/**
 * Two-sided market-making simulator with honest exit accounting.
 *
 * WHY THE EXIT MATTERS MORE THAN THE ENTRY: the measured esports edge (+2.7c/contract at
 * the back of the queue) comes from the realized-spread statistic, whose conventional
 * definition marks the fill against the future MID. That silently assumes we can unwind at
 * the mid, which is not a thing anyone can do — unwinding either waits passively for the
 * other side to fill, or crosses the spread and pays the taker fee. A simulator that
 * inherited the mid-exit assumption would report a profit the strategy cannot realise.
 *
 * So this module never marks a round trip at the mid. Inventory is carried at the price we
 * could actually get out at, and every crossing pays the real Kalshi taker fee. The two
 * exit regimes are modelled explicitly so the difference between them is measurable:
 *
 *   - PASSIVE: keep quoting the other side and wait. Captures the full spread when both
 *     sides fill, but carries inventory (and therefore directional risk) for as long as it
 *     takes — and may never fill.
 *   - AGGRESSIVE: after `inventoryMaxAgeMs`, cross to flatten. Pays half the spread plus
 *     the taker fee, which on a 4c spread consumes most of the edge. This is the cost of
 *     refusing to hold risk.
 *
 * Maker fills pay ZERO fee, which is real: Kalshi's `quadratic` fee type bills takers only,
 * and the esports series use it. That asymmetry is the entire economic case for quoting.
 */

export interface MakerSimConfig {
  /** Contracts posted per side per ticker. */
  readonly quoteSize: number;
  /** Absolute net inventory cap per ticker. Quoting stops on the side that would breach it. */
  readonly maxInventoryPerTicker: number;
  /** Cross to flatten once inventory has been held this long. `null` = never cross (pure passive). */
  readonly inventoryMaxAgeMs: number | null;
  /** Cancel/repost when our price falls off the touch. Repricing forfeits queue position. */
  readonly repriceOnStale: boolean;
  /** Capital ceiling in dollars; a ticker is only quoted if its worst-case cost fits. */
  readonly capitalUsd: number;
  /** Fee policy for the crossings we pay for. Maker side is always free on `quadratic`. */
  readonly feePolicy: KalshiFeePolicy;
  /**
   * Inventory management. The naive symmetric quoter warehouses inventory against one-sided
   * flow and loses on the drift; ticker selection cannot fix it because flow balance is not
   * predictable (measured corr between a ticker's first- and second-half balance: 0.17).
   * Skewing is the reactive alternative -- it responds to inventory we already hold rather
   * than trying to forecast who will trade next.
   *
   *  - 'none'              quote both sides at the touch regardless of inventory (baseline)
   *  - 'reduce-only'       once |inventory| >= skewThreshold, stop quoting the side that
   *                        would add to it. Keeps the full spread but fills more slowly.
   *  - 'aggressive-reduce' additionally improve the reducing side by one tick, paying a
   *                        cent of spread to shed inventory faster.
   */
  readonly skewMode: 'none' | 'reduce-only' | 'aggressive-reduce';
  /** Absolute inventory at which skewing engages. */
  readonly skewThreshold: number;
}

export const DEFAULT_MAKER_SIM_CONFIG: Omit<MakerSimConfig, 'feePolicy'> = {
  quoteSize: 25,
  maxInventoryPerTicker: 50,
  inventoryMaxAgeMs: 120_000,
  repriceOnStale: true,
  capitalUsd: 5_000,
  skewMode: 'none',
  skewThreshold: 25,
};

interface TickerState {
  bidQuote: RestingQuote | null;
  askQuote: RestingQuote | null;
  /** Net contracts held. Positive = long YES. */
  inventory: number;
  /** Cash paid out (negative) / received (positive) so far, excluding fees. */
  cash: number;
  /** Fees paid on crossings. */
  feesUsd: number;
  /** When the current non-zero inventory was first opened. */
  inventoryOpenedAt: number | null;
  lastBook: BookTop | null;
  makerFills: number;
  makerContracts: number;
  crossings: number;
  crossedContracts: number;
  repriced: number;
  /** Contracts bought passively (our bid was hit) vs sold passively (our ask was lifted). */
  bidContracts: number;
  askContracts: number;
  /** Largest absolute inventory reached, and inventory integrated over time (contract-ms). */
  peakInventory: number;
  inventoryTimeIntegral: number;
  lastInventoryAt: number | null;
}

export interface MakerSimResult {
  readonly tickers: number;
  readonly makerFills: number;
  readonly makerContracts: number;
  /** Contracts flattened by crossing the spread (the expensive exit). */
  readonly crossedContracts: number;
  readonly crossings: number;
  readonly repriced: number;
  readonly feesUsd: number;
  /** Cash + inventory marked at the price we could actually exit into. */
  readonly netPnlUsd: number;
  /** P&L if inventory were (unrealistically) marked at the mid — the optimistic bound. */
  readonly netPnlAtMidUsd: number;
  readonly residualInventory: number;
  /** Passive buys vs passive sells. A large imbalance means the market ran through one side. */
  readonly bidContracts: number;
  readonly askContracts: number;
  readonly peakInventory: number;
  /** Mean |inventory| carried, in contracts, over the whole run. */
  readonly meanAbsInventory: number;
  readonly perTicker: ReadonlyMap<string, { pnl: number; contracts: number; inventory: number }>;
}

const nz = (v: number | undefined | null): number => (Number.isFinite(v as number) ? (v as number) : 0);

export class MakerSimulator {
  private readonly cfg: MakerSimConfig;
  private readonly state = new Map<string, TickerState>();

  constructor(cfg: MakerSimConfig) {
    this.cfg = cfg;
  }

  private ensure(ticker: string): TickerState {
    let s = this.state.get(ticker);
    if (!s) {
      s = {
        bidQuote: null, askQuote: null, inventory: 0, cash: 0, feesUsd: 0,
        inventoryOpenedAt: null, lastBook: null,
        makerFills: 0, makerContracts: 0, crossings: 0, crossedContracts: 0, repriced: 0,
        bidContracts: 0, askContracts: 0,
        peakInventory: 0, inventoryTimeIntegral: 0, lastInventoryAt: null,
      };
      this.state.set(ticker, s);
    }
    return s;
  }

  /**
   * Integrate |inventory| over wall time. Time-weighted inventory is the honest measure of
   * how much directional risk a quoting strategy actually carried -- a peak says how bad it
   * got once, this says how long it stayed bad.
   */
  private accrueInventory(s: TickerState, at: number): void {
    if (s.lastInventoryAt != null && s.inventory !== 0) {
      s.inventoryTimeIntegral += Math.abs(s.inventory) * Math.max(0, at - s.lastInventoryAt);
    }
    s.lastInventoryAt = at;
  }

  /** Capital committed if every current quote filled, at its own price. */
  private committedUsd(): number {
    let total = 0;
    for (const s of this.state.values()) {
      total += Math.abs(s.inventory) * 0.5;                       // held risk, mid-priced
      if (s.bidQuote) total += (s.bidQuote.size - s.bidQuote.filled) * s.bidQuote.price;
    }
    return total;
  }

  /**
   * Feed a book snapshot. Handles repricing and, if configured, the aged-inventory crossing.
   * Order matters: inventory is flattened BEFORE requoting so a forced exit is not masked
   * by a fresh quote on the same side.
   */
  onBook(ticker: string, book: BookTop, at: number): void {
    if (!(book.bid > 0) || !(book.ask < 1) || !(book.ask > book.bid)) return;
    const s = this.ensure(ticker);
    s.lastBook = book;
    this.accrueInventory(s, at);

    if (this.cfg.inventoryMaxAgeMs != null && s.inventory !== 0 && s.inventoryOpenedAt != null) {
      if (at - s.inventoryOpenedAt >= this.cfg.inventoryMaxAgeMs) this.flatten(ticker, book, at);
    }

    if (this.cfg.repriceOnStale) {
      if (s.bidQuote && isStale(s.bidQuote, book)) { s.bidQuote = null; s.repriced += 1; }
      if (s.askQuote && isStale(s.askQuote, book)) { s.askQuote = null; s.repriced += 1; }
    }
    if (s.bidQuote && isFilled(s.bidQuote)) s.bidQuote = null;
    if (s.askQuote && isFilled(s.askQuote)) s.askQuote = null;

    const room = this.cfg.capitalUsd - this.committedUsd();
    const cap = this.cfg.maxInventoryPerTicker;
    const tick = 0.01;
    const skewing = this.cfg.skewMode !== 'none' && Math.abs(s.inventory) >= this.cfg.skewThreshold;
    // When skewing, the side that would deepen our position is suppressed; the side that
    // sheds it may step inside the touch to fill sooner.
    const suppressBid = skewing && s.inventory > 0;
    const suppressAsk = skewing && s.inventory < 0;
    const aggressive = this.cfg.skewMode === 'aggressive-reduce' && skewing;

    if (!s.bidQuote && !suppressBid && s.inventory < cap && room > this.cfg.quoteSize * book.bid) {
      const improve = aggressive && s.inventory < 0 && book.ask - book.bid > tick * 1.5;
      const px = improve ? book.bid + tick : book.bid;
      s.bidQuote = postQuote(book, 'bid', px, this.cfg.quoteSize, at);
    }
    if (!s.askQuote && !suppressAsk && s.inventory > -cap) {
      const improve = aggressive && s.inventory > 0 && book.ask - book.bid > tick * 1.5;
      const px = improve ? book.ask - tick : book.ask;
      s.askQuote = postQuote(book, 'ask', px, this.cfg.quoteSize, at);
    }
  }

  /** Feed a trade print. Fills are maker fills and pay no fee. */
  onPrint(ticker: string, print: TradePrint, at: number): void {
    const s = this.state.get(ticker);
    if (!s) return;
    for (const side of ['bid', 'ask'] as const) {
      const q = side === 'bid' ? s.bidQuote : s.askQuote;
      if (!q) continue;
      const fill = applyPrint(q, print, at);
      if (!fill) continue;
      // Buying lifts inventory and spends cash; selling does the reverse.
      const signed = side === 'bid' ? fill.qty : -fill.qty;
      if (s.inventory === 0) s.inventoryOpenedAt = at;
      s.inventory += signed;
      s.cash += side === 'bid' ? -fill.qty * fill.price : fill.qty * fill.price;
      s.makerFills += 1;
      s.makerContracts += fill.qty;
      if (side === 'bid') s.bidContracts += fill.qty; else s.askContracts += fill.qty;
      this.accrueInventory(s, at);
      s.peakInventory = Math.max(s.peakInventory, Math.abs(s.inventory));
      if (s.inventory === 0) s.inventoryOpenedAt = null;
      if (isFilled(q)) { if (side === 'bid') s.bidQuote = null; else s.askQuote = null; }
    }
  }

  /**
   * Cross the spread to flatten. Long inventory sells into the bid, short buys the ask —
   * always the unfavourable side — and pays the taker fee on the way out.
   */
  private flatten(ticker: string, book: BookTop, at: number): void {
    const s = this.ensure(ticker);
    if (s.inventory === 0) return;
    const qty = Math.abs(s.inventory);
    const long = s.inventory > 0;
    const price = long ? book.bid : book.ask;
    s.cash += long ? qty * price : -qty * price;
    const fee = nz(kalshiFeeForOrder(price, qty, this.cfg.feePolicy));
    s.feesUsd += fee;
    s.inventory = 0;
    s.inventoryOpenedAt = null;
    s.crossings += 1;
    s.crossedContracts += qty;
  }

  /**
   * Close the run. Any residual inventory is force-flattened by crossing, because a
   * simulator that ends holding a position is just deferring the cost of its own exit.
   */
  finish(at: number, forceFlatten = true): MakerSimResult {
    let makerFills = 0, makerContracts = 0, crossed = 0, crossings = 0, repriced = 0;
    let fees = 0, pnl = 0, pnlMid = 0, residual = 0;
    let bidC = 0, askC = 0, peak = 0, invIntegral = 0, spanMs = 0;
    const perTicker = new Map<string, { pnl: number; contracts: number; inventory: number }>();

    for (const [ticker, s] of this.state) {
      if (forceFlatten && s.inventory !== 0 && s.lastBook) this.flatten(ticker, s.lastBook, at);
      const b = s.lastBook;
      // Exitable mark: what we would actually receive, not the mid.
      const exitMark = b ? (s.inventory > 0 ? b.bid : b.ask) : 0;
      const midMark = b ? (b.bid + b.ask) / 2 : 0;
      const tickerPnl = s.cash + s.inventory * exitMark - s.feesUsd;
      pnl += tickerPnl;
      pnlMid += s.cash + s.inventory * midMark - s.feesUsd;
      fees += s.feesUsd;
      makerFills += s.makerFills;
      makerContracts += s.makerContracts;
      crossed += s.crossedContracts;
      crossings += s.crossings;
      repriced += s.repriced;
      residual += Math.abs(s.inventory);
      bidC += s.bidContracts; askC += s.askContracts;
      peak = Math.max(peak, s.peakInventory);
      invIntegral += s.inventoryTimeIntegral;
      if (s.lastInventoryAt != null) spanMs = Math.max(spanMs, at - (s.lastInventoryAt - s.inventoryTimeIntegral));
      perTicker.set(ticker, { pnl: tickerPnl, contracts: s.makerContracts, inventory: s.inventory });
    }

    return {
      tickers: this.state.size,
      makerFills, makerContracts, crossedContracts: crossed, crossings, repriced,
      feesUsd: fees, netPnlUsd: pnl, netPnlAtMidUsd: pnlMid,
      residualInventory: residual,
      bidContracts: bidC, askContracts: askC, peakInventory: peak,
      meanAbsInventory: spanMs > 0 ? invIntegral / spanMs : 0,
      perTicker,
    };
  }
}
