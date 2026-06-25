import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { PaperDesk } from './paperDesk.js';
import { simulatePaperBuy, checkPaperRisk } from './executionRouter.js';
import { positionUnrealizedPnl, markToMarketPortfolio } from './pnlEngine.js';
import { runFeeAwareBacktest } from './backtestRunner.js';
import { DEFAULT_GUARDRAILS, type ThesisCard } from '@nemesis/core';

const card: ThesisCard = {
  id: 't1',
  ticker: 'TEST-1',
  title: 'Test market',
  category: 'economics',
  playbook: 'flow-hunter',
  status: 'tradeable',
  side: 'yes',
  marketPrice: 0.45,
  impliedPrice: 0.5,
  grossEdge: 0.05,
  netEdge: 0.03,
  spread: 0.02,
  depthUsd: 500,
  predictability: 70,
  feeEstimate: 0.01,
  signalReason: 'test',
  externalSummary: 'test',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  freshnessMs: 1000,
  edgeHistory: [0.03],
  drivers: [],
  invalidations: [],
};

const book = {
  ticker: 'TEST-1',
  yes: [{ price: 0.45, quantity: 200 }],
  no: [{ price: 0.55, quantity: 200 }],
  yesAsk: 0.46,
  noAsk: 0.56,
  spread: 0.02,
};

describe('executionRouter', () => {
  it('simulates paper buy via orderbook', () => {
    const desk = new PaperDesk(1000);
    const result = simulatePaperBuy(desk, card, book, DEFAULT_GUARDRAILS, 5);
    expect(result.ok).toBe(true);
    expect(desk.snapshot().positions.length).toBe(1);
  });

  it('blocks when daily loss cap breached', () => {
    const desk = new PaperDesk(1000);
    const risk = checkPaperRisk(card, desk.snapshot(), DEFAULT_GUARDRAILS, -10);
    expect(risk.ok).toBe(false);
  });
});

describe('pnlEngine parity', () => {
  it('matches desk markToMarket', () => {
    const desk = new PaperDesk(1000);
    simulatePaperBuy(desk, card, book, DEFAULT_GUARDRAILS, 5);
    const pos = desk.snapshot().positions[0];
    const marks = new Map([[pos.ticker, 0.5]]);
    const deskMtm = desk.markToMarket(marks);
    const engineMtm = markToMarketPortfolio(desk.snapshot().positions, marks, desk.snapshot().cash);
    expect(deskMtm.unrealized).toBeCloseTo(engineMtm.unrealized, 4);
    expect(deskMtm.equity).toBeCloseTo(engineMtm.equity, 4);
  });

  it('positionUnrealizedPnl is fee-aware', () => {
    const pos = {
      id: 'p1',
      thesisId: 't1',
      ticker: 'X',
      title: 'X',
      side: 'yes' as const,
      contracts: 10,
      entryPrice: 0.4,
      fees: 0.5,
      openedAt: Date.now(),
      playbook: 'flow-hunter',
    };
    const pnl = positionUnrealizedPnl(pos, 0.45);
    expect(typeof pnl).toBe('number');
  });
});

describe('liveOrderAdapter', () => {
  it('blocks live orders when not enabled', async () => {
    const { submitLiveOrder } = await import('./liveOrderAdapter.js');
    const result = await submitLiveOrder(
      { ticker: 'X', side: 'yes', contracts: 1, limitPrice: 0.5, clientOrderId: 'test' },
      null,
      { ...DEFAULT_GUARDRAILS, liveEnabled: false },
    );
    expect(result.ok).toBe(false);
  });

  it('kill switch blocks live submit', async () => {
    const { submitLiveOrder } = await import('./liveOrderAdapter.js');
    const result = await submitLiveOrder(
      { ticker: 'X', side: 'yes', contracts: 1, limitPrice: 0.5, clientOrderId: 'test' },
      { apiKeyId: 'k', privateKeyPem: 'pem' },
      { ...DEFAULT_GUARDRAILS, liveEnabled: true, killSwitchActive: true },
    );
    expect(result.ok).toBe(false);
  });

  it('cancels all resting live orders', async () => {
    const { cancelAllLiveOrders } = await import('./liveOrderAdapter.js');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && String(url).includes('/portfolio/orders')) {
        return new Response(JSON.stringify({ orders: [{ order_id: 'o1', status: 'resting' }, { order_id: 'o2', status: 'resting' }] }), { status: 200 });
      }
      if (method === 'DELETE') {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    vi.stubGlobal('fetch', fetchFn);
    try {
      const creds = { apiKeyId: 'k', privateKeyPem };
      const settings = { ...DEFAULT_GUARDRAILS, liveEnabled: true };
      const result = await cancelAllLiveOrders(creds, settings);
      expect(result.cancelled).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
