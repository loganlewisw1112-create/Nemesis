import { describe, expect, it } from 'vitest';
import { PaperDesk } from './paperDesk.js';
import type { ThesisCard } from '@nemesis/core';

const card: ThesisCard = {
  id: 't1',
  ticker: 'TEST-1',
  title: 'Test market',
  category: 'test',
  playbook: 'flow-hunter',
  status: 'tradeable',
  side: 'yes',
  marketPrice: 0.4,
  impliedPrice: 0.45,
  grossEdge: 0.05,
  netEdge: 0.03,
  spread: 0.04,
  depthUsd: 500,
  predictability: 0.7,
  freshnessMs: 1000,
  drivers: [],
  gates: { passed: [], failed: [] },
  edgeBreakdown: { grossEdge: 0.05, spreadCost: 0.01, feeCost: 0.005, slippageBuffer: 0.005, netEdge: 0.03 },
};

describe('PaperDesk', () => {
  it('opens and closes a position', () => {
    const desk = new PaperDesk(1000);
    const open = desk.openPosition(card, 10, 0.4);
    expect(open.ok).toBe(true);
    expect(desk.snapshot().positions).toHaveLength(1);

    const close = desk.closePosition(desk.snapshot().positions[0].id, 0.5);
    expect(close.ok).toBe(true);
    expect(desk.snapshot().positions).toHaveLength(0);
    expect(desk.snapshot().cash).toBeGreaterThan(900);
  });

  it('rejects when insufficient cash', () => {
    const desk = new PaperDesk(1);
    const open = desk.openPosition(card, 100, 0.4);
    expect(open.ok).toBe(false);
  });

  it('marks to market', () => {
    const desk = new PaperDesk(1000);
    desk.openPosition(card, 5, 0.4);
    const marks = new Map([['TEST-1', 0.5]]);
    const mtm = desk.markToMarket(marks);
    expect(mtm.equity).toBeGreaterThan(0);
    expect(mtm.unrealized).toBeGreaterThan(0);
  });
});
