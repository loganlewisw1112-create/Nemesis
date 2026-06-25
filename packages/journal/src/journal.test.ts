import { describe, expect, it } from 'vitest';
import { JournalStore } from '../src/store.js';

describe('journal', () => {
  it('adds and exports', () => {
    const j = new JournalStore();
    j.addFromThesis({
      id: '1', ticker: 'T', title: 'Test', category: 'x', playbook: 'flow-hunter',
      status: 'tradeable', side: 'yes', marketPrice: 0.3, impliedPrice: 0.4,
      grossEdge: 0.1, netEdge: 0.05, spread: 0.04, depthUsd: 100, predictability: 70,
      feeEstimate: 0.02, signalReason: 'test', externalSummary: '', createdAt: 0,
      updatedAt: 0, freshnessMs: 0, edgeHistory: [], drivers: [], invalidations: [],
    });
    expect(j.count()).toBe(1);
    expect(j.exportCsv()).toContain('T');
  });
});
