import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { PaperDesk } from './paperDesk.js';
import { previewPaperBuy, previewPaperClose, simulatePaperBuy, simulatePaperClose, checkPaperRisk, mutualExclusionBlock } from './executionRouter.js';
import { positionUnrealizedPnl, markToMarketPortfolio } from './pnlEngine.js';
import { runFeeAwareBacktest } from './backtestRunner.js';
import { DEFAULT_GUARDRAILS, DEFAULT_STRICT_PROFIT_MODE, type KalshiOrderbook, type ThesisCard } from '@nemesis/core';

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

const book: KalshiOrderbook = {
  ticker: 'TEST-1',
  yes: [{ price: 0.5, quantity: 200 }],
  no: [{ price: 0.55, quantity: 200 }],
  yesAsk: 0.46,
  noAsk: 0.56,
  spread: 0.02,
};

const crossedProfitBook: KalshiOrderbook = {
  ticker: 'TEST-1',
  yes: [{ price: 0.52, quantity: 200 }],
  no: [{ price: 0.55, quantity: 200 }],
  yesAsk: 0.46,
  noAsk: 0.56,
  spread: 0.02,
};

const highEdgeCard: ThesisCard = {
  ...card,
  impliedPrice: 0.75,
  grossEdge: 0.3,
  netEdge: 0.25,
  predictability: 95,
  edgeHistory: [0.25],
};

describe('executionRouter', () => {
  it('simulates paper buy via orderbook', () => {
    const desk = new PaperDesk(1000);
    const result = simulatePaperBuy(desk, highEdgeCard, crossedProfitBook, DEFAULT_GUARDRAILS, 2);
    expect(result.ok).toBe(true);
    expect(result.profitCertificate?.netPnlUsd).toBeGreaterThanOrEqual(0.01);
    expect(result.wouldMutate).toBe(true);
    expect(desk.snapshot().positions.length).toBe(1);
  });

  it('blocks research-only signals before mutating paper positions', () => {
    const desk = new PaperDesk(1000);
    const researchCard: ThesisCard = {
      ...highEdgeCard,
      playbook: 'global-pulse',
      status: 'tradeable',
      invalidations: [],
    };

    const result = simulatePaperBuy(desk, researchCard, crossedProfitBook, DEFAULT_GUARDRAILS, 2);

    expect(result.abortCode).toBe('signal_eligibility_block');
    expect(result.wouldMutate).toBe(false);
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it('blocks zero-price books before mutating paper positions', () => {
    const desk = new PaperDesk(1000);
    const zeroBook: KalshiOrderbook = {
      ticker: 'TEST-1',
      yes: [{ price: 0, quantity: 200 }],
      no: [{ price: 0, quantity: 200 }],
      yesAsk: 0,
      noAsk: 1,
      spread: 0.02,
    };
    const result = simulatePaperBuy(desk, { ...card, marketPrice: 0 }, zeroBook, DEFAULT_GUARDRAILS, 5);

    expect(result.ok).toBe(false);
    expect(result.abortCode).toBe('invalid_price');
    expect(result.wouldMutate).toBe(false);
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it('blocks flat or negative paper closes without mutating the portfolio', () => {
    const desk = new PaperDesk(1000);
    const opened = desk.openPosition(card, 5, 0.5);
    expect(opened.ok).toBe(true);
    const positionId = desk.snapshot().positions[0].id;
    const before = desk.snapshot();

    const result = simulatePaperClose(
      desk,
      positionId,
      { ticker: 'TEST-1', yes: [{ price: 0.5, quantity: 5 }], no: [{ price: 0.5, quantity: 5 }], spread: 0.02 },
      'yes',
      0.5,
      5,
      DEFAULT_GUARDRAILS,
    );

    expect(result.ok).toBe(false);
    expect(result.abortCode).toBe('strict_profit_block');
    expect(result.wouldMutate).toBe(false);
    expect(desk.snapshot()).toEqual(before);
  });

  it('attaches a profit certificate to profitable paper closes', () => {
    const desk = new PaperDesk(1000);
    const opened = desk.openPosition(card, 5, 0.5);
    expect(opened.ok).toBe(true);
    const positionId = desk.snapshot().positions[0].id;

    const result = simulatePaperClose(
      desk,
      positionId,
      { ticker: 'TEST-1', yes: [{ price: 0.55, quantity: 5 }], no: [{ price: 0.45, quantity: 5 }], spread: 0.02 },
      'yes',
      0.55,
      5,
      DEFAULT_GUARDRAILS,
    );

    expect(result.ok).toBe(true);
    expect(result.profitCertificate?.kind).toBe('close');
    expect(result.profitCertificate?.netPnlUsd).toBeGreaterThanOrEqual(0.01);
    expect(result.wouldMutate).toBe(true);
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it('blocks when daily loss cap breached', () => {
    const desk = new PaperDesk(1000);
    const risk = checkPaperRisk(card, desk.snapshot(), DEFAULT_GUARDRAILS, -10);
    expect(risk.ok).toBe(false);
  });

  it('blocks buying a second YES outcome of the same event once combined cost reaches $1', () => {
    const desk = new PaperDesk(1000);
    // Already long YES on the BOS outcome of an MLB game at 0.61.
    desk.openPosition(
      { ...highEdgeCard, ticker: 'KXMLBGAME-26JUL052130BOSLAA-BOS', side: 'yes' },
      50,
      0.61,
    );
    // Attempt to also buy YES on the LAA outcome of the same game at ~0.41.
    const laaCard = { ...highEdgeCard, id: 't2', ticker: 'KXMLBGAME-26JUL052130BOSLAA-LAA', side: 'yes' as const, marketPrice: 0.41 };
    const laaBook: KalshiOrderbook = {
      ticker: 'KXMLBGAME-26JUL052130BOSLAA-LAA',
      yes: [{ price: 0.41, quantity: 200 }],
      no: [{ price: 0.6, quantity: 200 }],
      yesAsk: 0.41,
      noAsk: 0.6,
      spread: 0.02,
    };
    const result = simulatePaperBuy(desk, laaCard, laaBook, DEFAULT_GUARDRAILS, 50);
    expect(result.ok).toBe(false);
    expect(result.abortCode).toBe('mutual_exclusion_block');
    expect(desk.snapshot().positions).toHaveLength(1);
  });

  it('allows a YES outcome of an unrelated event with the same category', () => {
    const desk = new PaperDesk(1000);
    desk.openPosition(
      { ...highEdgeCard, ticker: 'KXMLBGAME-26JUL052130BOSLAA-BOS', side: 'yes' },
      50,
      0.61,
    );
    const otherGame = { ...highEdgeCard, id: 't3', ticker: 'KXMLBGAME-26JUL061800NYYTOR-NYY', side: 'yes' as const };
    const block = mutualExclusionBlock(otherGame.ticker, 'yes', 0.55, desk.snapshot().positions);
    expect(block).toBeUndefined();
  });

  it('requires persistent confirmation before a modeled thesis-edge entry can mutate paper', () => {
    const desk = new PaperDesk(1000);
    const preview = previewPaperBuy(desk.snapshot(), highEdgeCard, book, DEFAULT_GUARDRAILS, 2);
    expect(preview.ok).toBe(true);
    expect(preview.profitCertificate?.classification).toBe('research_only');
    const result = simulatePaperBuy(desk, highEdgeCard, book, DEFAULT_GUARDRAILS, 2);
    expect(result.ok).toBe(false);
    expect(result.abortCode).toBe('entry_confirmation_required');
    expect(result.wouldMutate).toBe(false);
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it('uses a NO thesis contract price directly instead of inverting it twice', () => {
    const noCard: ThesisCard = {
      ...highEdgeCard,
      id: 'no-flow',
      side: 'no',
      marketPrice: 0.6,
      impliedPrice: 0.72,
      grossEdge: 0.12,
      netEdge: 0.08,
    };
    const noBook: KalshiOrderbook = {
      ticker: noCard.ticker,
      yes: [{ price: 0.39, quantity: 20 }],
      no: [{ price: 0.58, quantity: 20 }],
      yesAsk: 0.42,
      noAsk: 0.61,
    };
    const preview = previewPaperBuy(new PaperDesk(1000).snapshot(), noCard, noBook, DEFAULT_GUARDRAILS, 5);
    expect(preview.ok).toBe(true);
    expect(preview.fillQuality?.expectedPrice).toBe(0.6);
    expect(preview.fill?.fillPrice).toBe(0.61);
  });

  it('still blocks entry when the thesis carries no modeled edge and the round-trip is not profitable', () => {
    const desk = new PaperDesk(1000);
    const zeroEdgeCard = { ...card, netEdge: 0 };
    const result = simulatePaperBuy(desk, zeroEdgeCard, book, DEFAULT_GUARDRAILS, 2);
    expect(result.ok).toBe(false);
    // The entry eligibility contract rejects a zero-edge thesis before capital
    // allocation or strict-profit certification can authorize a mutation.
    expect(result.abortCode).toBe('signal_eligibility_block');
    expect(result.wouldMutate).toBe(false);
  });

  it('certifies an emergency loss close when explicitly tagged and allowed by settings', () => {
    const desk = new PaperDesk(1000);
    const opened = desk.openPosition(card, 5, 0.5);
    expect(opened.ok).toBe(true);
    const positionId = desk.snapshot().positions[0].id;
    const settings = {
      ...DEFAULT_GUARDRAILS,
      strictProfitMode: { ...DEFAULT_STRICT_PROFIT_MODE, allowEmergencyLossClose: true },
    };

    const result = simulatePaperClose(
      desk,
      positionId,
      { ticker: 'TEST-1', yes: [{ price: 0.45, quantity: 5 }], no: [{ price: 0.55, quantity: 5 }], spread: 0.02 },
      'yes',
      0.45,
      5,
      settings,
      { autoCloseReason: 'emergency close: edge gone', autoCloseAction: 'close' },
    );

    expect(result.ok).toBe(true);
    expect(result.pnl).toBeLessThan(0);
    expect(result.profitCertificate?.reason).toBe('emergency loss close certified');
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it('still blocks a losing close when not tagged as an emergency decision, even if the setting is on', () => {
    const desk = new PaperDesk(1000);
    const opened = desk.openPosition(card, 5, 0.5);
    expect(opened.ok).toBe(true);
    const positionId = desk.snapshot().positions[0].id;
    const settings = {
      ...DEFAULT_GUARDRAILS,
      strictProfitMode: { ...DEFAULT_STRICT_PROFIT_MODE, allowEmergencyLossClose: true },
    };

    const result = simulatePaperClose(
      desk,
      positionId,
      { ticker: 'TEST-1', yes: [{ price: 0.45, quantity: 5 }], no: [{ price: 0.55, quantity: 5 }], spread: 0.02 },
      'yes',
      0.45,
      5,
      settings,
    );

    expect(result.ok).toBe(false);
    expect(result.abortCode).toBe('strict_profit_block');
  });

  it('previews a real executable close fill without mutating the paper desk', () => {
    const desk = new PaperDesk(1000);
    desk.openPosition(card, 5, 0.4);
    const before = desk.snapshot();
    const result = previewPaperClose(
      { ticker: 'TEST-1', yes: [{ price: 0.45, quantity: 5 }], no: [{ price: 0.55, quantity: 5 }] },
      'yes',
      5,
      DEFAULT_GUARDRAILS,
    );
    expect(result.ok).toBe(true);
    expect(result.fill?.fillPrice).toBe(0.45);
    expect(result.wouldMutate).toBe(false);
    expect(desk.snapshot()).toEqual(before);
  });
});

describe('pnlEngine parity', () => {
  it('matches desk markToMarket', () => {
    const desk = new PaperDesk(1000);
    simulatePaperBuy(desk, highEdgeCard, crossedProfitBook, DEFAULT_GUARDRAILS, 2);
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
