import { describe, expect, it } from 'vitest';
import { resolveSettlement, settlePaperPosition } from './settlement.js';
import { PaperDesk } from './paperDesk.js';
import { kalshiFeeForOrder, type ThesisCard } from '@nemesis/core';

const card: ThesisCard = {
  id: 't1',
  ticker: 'KXFIBAGAME-26JUL060200TPECHN-TPE',
  title: 'TPE beats CHN',
  category: 'sports',
  playbook: 'flow-hunter',
  status: 'tradeable',
  side: 'yes',
  marketPrice: 0.24,
  impliedPrice: 0.3,
  grossEdge: 0.06,
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

describe('resolveSettlement', () => {
  it('returns null while the market is open or merely closed', () => {
    expect(resolveSettlement('open', '', 'yes')).toBeNull();
    expect(resolveSettlement('closed', '', 'yes')).toBeNull();
    expect(resolveSettlement('closed', 'yes', 'yes')).toBeNull();
    expect(resolveSettlement(undefined, undefined, 'yes')).toBeNull();
  });

  it('returns null when settled but the result is missing or malformed', () => {
    expect(resolveSettlement('settled', '', 'yes')).toBeNull();
    expect(resolveSettlement('settled', 'void', 'yes')).toBeNull();
    expect(resolveSettlement('settled', undefined, 'yes')).toBeNull();
  });

  it('pays $1 when the result matches the held side and $0 when it does not', () => {
    expect(resolveSettlement('settled', 'yes', 'yes')).toEqual({ exitPrice: 1, result: 'yes' });
    expect(resolveSettlement('settled', 'no', 'yes')).toEqual({ exitPrice: 0, result: 'no' });
    expect(resolveSettlement('settled', 'no', 'no')).toEqual({ exitPrice: 1, result: 'no' });
    expect(resolveSettlement('settled', 'yes', 'no')).toEqual({ exitPrice: 0, result: 'yes' });
  });

  it('accepts determined and finalized statuses with case-insensitive fields', () => {
    expect(resolveSettlement('DETERMINED', 'YES', 'yes')).toEqual({ exitPrice: 1, result: 'yes' });
    expect(resolveSettlement('finalized', 'no', 'no')).toEqual({ exitPrice: 1, result: 'no' });
  });
});

describe('settlement close through the paper desk', () => {
  it('charges zero exit fees at binary settlement prices', () => {
    expect(kalshiFeeForOrder(1, 50)).toBe(0);
    expect(kalshiFeeForOrder(0, 50)).toBe(0);
  });

  it('pays full $1 per contract on a winning settlement', () => {
    const desk = new PaperDesk(1000);
    const opened = desk.openPosition(card, 50, 0.24);
    expect(opened.ok).toBe(true);
    const pos = desk.snapshot().positions[0];

    const result = desk.closePosition(pos.id, 1, pos.contracts, {
      mode: 'paper',
      expectedPrice: 1,
      autoCloseReason: 'settlement: market resolved YES',
    });

    expect(result.ok).toBe(true);
    // proceeds 50*1 - 0 fees; cost basis 0.24*50 + entry fees
    const expectedPnl = 50 - (0.24 * 50 + pos.fees);
    expect(result.pnl).toBeCloseTo(expectedPnl, 6);
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it('books the full loss on a losing settlement', () => {
    const desk = new PaperDesk(1000);
    desk.openPosition(card, 50, 0.24);
    const pos = desk.snapshot().positions[0];

    const result = desk.closePosition(pos.id, 0, pos.contracts, {
      mode: 'paper',
      expectedPrice: 0,
      autoCloseReason: 'settlement: market resolved NO',
    });

    expect(result.ok).toBe(true);
    expect(result.pnl).toBeCloseTo(-(0.24 * 50 + pos.fees), 6);
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it('settlePaperPosition helper agrees with the desk math (ignoring exit fees, which are zero)', () => {
    const desk = new PaperDesk(1000);
    desk.openPosition(card, 50, 0.24);
    const pos = desk.snapshot().positions[0];
    const helper = settlePaperPosition(pos, 1);
    expect(helper.exitPrice).toBe(1);
    expect(helper.pnl).toBeCloseTo(50 - (0.24 * 50 + pos.fees), 6);
  });
});
