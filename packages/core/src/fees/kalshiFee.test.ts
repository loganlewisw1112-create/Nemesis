import { describe, expect, it } from 'vitest';
import { kalshiFeePerContract, computeNetEdge, walkBookFill } from './kalshiFee.js';
import { parseOrderbook, normalizeMarketPrice } from '../kalshi/client.js';
import { qualifyThesis, detectSourceDisagreement } from '../thesis/qualification.js';
import type { KalshiMarket } from '../src/types.js';

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

  it('normalizes cent market prices', () => {
    const m: KalshiMarket = { ticker: 'T', title: 'T', status: 'open', yes_ask: 34 };
    expect(normalizeMarketPrice(m)).toBeCloseTo(0.34);
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
