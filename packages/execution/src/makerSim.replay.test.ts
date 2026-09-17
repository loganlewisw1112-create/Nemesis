/**
 * Replay harness: drives MakerSimulator over captured Kalshi book+trade data.
 *
 * This is the capacity test. The realized-spread study established a per-contract edge but
 * could not say how often a resting quote fills, because that depends on queue position.
 * The simulator reconstructs queue position pessimistically; this harness feeds it real
 * market data and reports what a $5,000 account would actually have made.
 *
 * Guarded by MAKER_REPLAY=1 because it needs multi-hundred-MB captures that are gitignored
 * (regenerable via research/2026-08-05/collector.cjs). The normal suite skips it.
 *
 *   MAKER_REPLAY=1 npx vitest run packages/execution/src/makerSim.replay.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KalshiFeePolicy } from '@nemesis/core';
import { MakerSimulator, type MakerSimConfig } from './makerSim.js';
import type { BookSide, BookTop, TradePrint } from './makerQueue.js';

const DATA_DIR = process.env.MAKER_REPLAY_DIR
  ?? 'D:\\CODING\\PROJECTS - CURRENTLY WORKING ON\\KRYPT\\nemesis\\research\\2026-08-05';
const ENABLED = process.env.MAKER_REPLAY === '1'
  && existsSync(join(DATA_DIR, 'books.jsonl'))
  && existsSync(join(DATA_DIR, 'trades.jsonl'));

const TAKER: KalshiFeePolicy = {
  known: true, role: 'taker', multiplier: 1, accountPrecision: 'non_direct',
  scheduleVersion: '2026-07-07', source: 'replay', feeType: 'quadratic',
};

interface BookRow { t: number; tk: string; bid: number; ask: number; bs: number; as: number }
interface TradeRow { t: number; tk: string; p: number; q: number; side: string; os: string }

/**
 * Map Kalshi's taker fields to the YES-book side that was CONSUMED.
 *
 * `taker_book_side` names the side the taker's OWN order sat on, not the side it consumed —
 * a buyer ('bid') lifts the ask, a seller ('ask') hits the bid. So the consumed side is
 * simply its opposite.
 *
 * Established empirically, not by convention-guessing: 53,949 prints that landed exactly on
 * a prevailing quote were cross-tabulated against the touch they matched
 * (research/2026-08-05/sidecheck.cjs). Only two combinations occur in the data, and both are
 * decisive — `side=bid,os=yes` consumed the ask 32,681 times vs the bid 4,913 (86.9%), and
 * `side=ask,os=no` consumed the bid 12,952 vs the ask 3,403 (79.2%). The residual is stale
 * quotes inside the 12s matching tolerance. `taker_outcome_side` carries no extra
 * information — it is perfectly correlated with `taker_book_side` in every observed row.
 *
 * An earlier version of this function inferred the convention from the sign of mean
 * effective spread instead, and got `side=ask` backwards, mis-assigning 30% of prints. That
 * error made a profitable-looking series simulate as a loss, so it is worth restating: a
 * self-consistency check (ES > 0) constrains the AGGREGATE orientation but cannot detect a
 * subset being flipped.
 */
export function takerBookSide(side: string, _outcome?: string): BookSide {
  return side === 'bid' ? 'ask' : 'bid';
}

const parse = <T,>(file: string): T[] => readFileSync(join(DATA_DIR, file), 'utf8')
  .split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) as T; } catch { return null; } })
  .filter((x): x is T => x !== null);

describe.skipIf(!ENABLED)('MakerSimulator replay on captured Kalshi data', () => {
  const books = parse<BookRow>('books.jsonl');
  const trades = parse<TradeRow>('trades.jsonl');

  const seriesOf = (tk: string): string => tk.split('-')[0] ?? '';
  const allSeries = [...new Set(trades.map((t) => seriesOf(t.tk)))];

  it('loaded a meaningful capture', () => {
    expect(books.length).toBeGreaterThan(10_000);
    expect(trades.length).toBeGreaterThan(10_000);
    // eslint-disable-next-line no-console
    console.log(`\ncapture: ${books.length} book rows, ${trades.length} prints, series: ${allSeries.join(' ')}`);
  });

  it('reports simulated maker P&L per series, split TRAIN/TEST to expose overfitting', () => {
    const regimes: Array<{ label: string; over: Partial<MakerSimConfig> }> = [
      { label: 'baseline symmetric', over: { inventoryMaxAgeMs: null, skewMode: 'none' } },
      { label: 'reduce-only skew', over: { inventoryMaxAgeMs: null, skewMode: 'reduce-only', skewThreshold: 25 } },
      { label: 'aggressive-reduce skew', over: { inventoryMaxAgeMs: null, skewMode: 'aggressive-reduce', skewThreshold: 25 } },
    ];

    type Ev = { t: number; kind: 0 | 1; i: number };
    const run = (bs: BookRow[], ts: TradeRow[], evs: Ev[], over: Partial<MakerSimConfig>) => {
      const cfg: MakerSimConfig = {
        quoteSize: 25, maxInventoryPerTicker: 50, inventoryMaxAgeMs: 120_000,
        repriceOnStale: true, capitalUsd: 5_000, feePolicy: TAKER,
        skewMode: 'none', skewThreshold: 25, ...over,
      };
      const sim = new MakerSimulator(cfg);
      for (const e of evs) {
        if (e.kind === 0) {
          const b = bs[e.i]!;
          sim.onBook(b.tk, { bid: b.bid, ask: b.ask, bidSize: b.bs, askSize: b.as }, b.t);
        } else {
          const t = ts[e.i]!;
          sim.onPrint(t.tk, { price: t.p, qty: t.q, takerSide: takerBookSide(t.side, t.os) }, t.t);
        }
      }
      return sim.finish(evs.length ? evs[evs.length - 1]!.t : 0, true);
    };

    for (const series of allSeries) {
      const bs = books.filter((b) => seriesOf(b.tk) === series);
      const ts = trades.filter((t) => seriesOf(t.tk) === series);
      if (ts.length < 500 || bs.length < 500) continue;

      const evs: Ev[] = [
        ...bs.map((_, i) => ({ t: bs[i]!.t, kind: 0 as const, i })),
        ...ts.map((_, i) => ({ t: ts[i]!.t, kind: 1 as const, i })),
      ].sort((a, b) => (a.t - b.t) || (a.kind - b.kind));
      const t0 = evs[0]!.t, t1 = evs[evs.length - 1]!.t;
      const split = t0 + (t1 - t0) / 2;
      const train = evs.filter((e) => e.t < split);
      const test = evs.filter((e) => e.t >= split);
      const hTrain = (split - t0) / 3_600_000, hTest = (t1 - split) / 3_600_000;

      // eslint-disable-next-line no-console
      console.log(`
===== ${series}  train ${hTrain.toFixed(2)}h / test ${hTest.toFixed(2)}h`);
      for (const { label, over } of regimes) {
        const a = run(bs, ts, train, over);
        const b = run(bs, ts, test, over);
        const pc = (r: typeof a) => (r.makerContracts > 0 ? (r.netPnlUsd / r.makerContracts) * 100 : 0);
        const agree = Math.sign(a.netPnlUsd) === Math.sign(b.netPnlUsd) && a.netPnlUsd !== 0;
        // eslint-disable-next-line no-console
        console.log(
          `  ${label.padEnd(24)}`
          + ` TRAIN c=${a.makerContracts.toFixed(0).padStart(5)} net=$${a.netPnlUsd.toFixed(2).padStart(8)} (${pc(a).toFixed(2)}c/ct)`
          + ` | TEST c=${b.makerContracts.toFixed(0).padStart(5)} net=$${b.netPnlUsd.toFixed(2).padStart(8)} (${pc(b).toFixed(2)}c/ct)`
          + `  ${agree ? 'AGREE' : 'FLIP'}`,
        );
      }
    }
    expect(true).toBe(true);
  }, 600_000);
});

describe('takerBookSide mapping', () => {
  it('returns the side the taker consumed, which is the opposite of its own order side', () => {
    // Verified against 53,949 prints matched to a prevailing quote; see the doc comment.
    expect(takerBookSide('bid', 'yes')).toBe('ask');   // buyer lifts the ask
    expect(takerBookSide('ask', 'no')).toBe('bid');    // seller hits the bid
  });

  it('ignores taker_outcome_side, which carries no independent information', () => {
    expect(takerBookSide('bid', 'no')).toBe(takerBookSide('bid', 'yes'));
    expect(takerBookSide('ask', 'yes')).toBe(takerBookSide('ask', 'no'));
  });
});
