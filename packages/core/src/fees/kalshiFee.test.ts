import { describe, expect, it } from 'vitest';
import { kalshiFeePerContract, computeNetEdge, walkBookFill } from './kalshiFee.js';
import {
  isExecutablePrice,
  normalizeExecutablePrice,
  parseOrderbook,
  normalizeMarketPrice,
  sanitizeExecutableBook,
} from '../kalshi/client.js';
import { qualifyThesis, detectSourceDisagreement } from '../thesis/qualification.js';
import type { KalshiMarket, KalshiOrderbook } from '../types.js';

describe('kalshiFee', () => {
  it('computes fee at 50c', () => {
    expect(kalshiFeePerContract(0.5)).toBe(0.02);
  });

  it('computes net edge with costs', () => {
    const r = computeNetEdge(0.4, 0.3, 0.04);
    expect(r.grossEdge).toBeCloseTo(0.1);
    expect(r.netEdge).toBeLessThan(r.grossEdge);
  });

  it('walks book for fill', () => {
    const r = walkBookFill(
      [
        { price: 0.3, quantity: 10 },
        { price: 0.32, quantity: 10 },
      ],
      15,
    );
    expect(r?.filled).toBe(15);
    expect(r!.slippage).toBeGreaterThan(0);
  });
});

describe('kalshi client', () => {
  it('parses bid-only orderbook with derived asks', () => {
    const ob = parseOrderbook('TEST', {
      orderbook: { yes: [[54, 100]], no: [[40, 50]] },
    });
    expect(ob.yesAsk).toBeCloseTo(0.6);
    expect(ob.spread).toBeDefined();
  });

  it('parses orderbook_fp dollar-string levels as executable depth', () => {
    const ob = parseOrderbook('TEST', {
      orderbook_fp: {
        no_dollars: [['0.9790', '5000.00'], ['0.9880', '92.00']],
        yes_dollars: [],
      },
    });

    expect(ob.no).toEqual([
      { price: 0.988, quantity: 92 },
      { price: 0.979, quantity: 5000 },
    ]);
    expect(ob.yesAsk).toBeCloseTo(0.012);
    expect(sanitizeExecutableBook(ob).no).toHaveLength(2);
  });

  it('normalizes cent market prices', () => {
    const m: KalshiMarket = { ticker: 'T', title: 'T', status: 'open', yes_ask: 34 };
    expect(normalizeMarketPrice(m)).toBeCloseTo(0.34);
  });

  it('rejects non-executable prices instead of treating zero as tradable', () => {
    expect(isExecutablePrice(0)).toBe(false);
    expect(isExecutablePrice(1)).toBe(false);
    expect(isExecutablePrice(Number.NaN)).toBe(false);
    expect(isExecutablePrice(0.34)).toBe(true);

    const zeroAsk: KalshiMarket = { ticker: 'T', title: 'T', status: 'open', yes_ask: 0 };
    expect(normalizeExecutablePrice(zeroAsk)).toBeNull();
  });

  it('sanitizes executable books and removes invalid synthetic levels', () => {
    const book: KalshiOrderbook = {
      ticker: 'T',
      yes: [
        { price: 0, quantity: 100 },
        { price: 0.42, quantity: 25 },
        { price: 1, quantity: 10 },
      ],
      no: [
        { price: 0.58, quantity: 0 },
        { price: 0.57, quantity: 30 },
      ],
      yesAsk: 0,
      noAsk: 0.57,
      spread: 0.02,
    };

    const sanitized = sanitizeExecutableBook(book);
    expect(sanitized.yes).toEqual([{ price: 0.42, quantity: 25 }]);
    expect(sanitized.no).toEqual([{ price: 0.57, quantity: 30 }]);
    expect(sanitized.yesAsk).toBeUndefined();
    expect(sanitized.noAsk).toBe(0.57);
  });
});

describe('qualification', () => {
  it('marks tradeable when all gates pass', () => {
    const r = qualifyThesis({
      impliedPrice: 0.45,
      marketPrice: 0.3,
      spread: 0.04,
      depthUsd: 500,
      predictability: 75,
      freshnessMs: 5000,
      sourceAgreement: 0.9,
      regimeBlocked: false,
      concentrationBlocked: false,
      executionHealthy: true,
    });
    expect(r.status).toBe('tradeable');
  });

  it('downgrades on disagreement', () => {
    const d = detectSourceDisagreement(
      [{ value: 91 }, { value: 95 }],
      2,
    );
    expect(d.disagree).toBe(true);
  });
});
