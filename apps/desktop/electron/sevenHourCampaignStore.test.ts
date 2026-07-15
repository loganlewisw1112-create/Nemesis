import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_QUALIFICATION, type ThesisCard } from '@nemesis/core';
import { calculateEntryEconomics, type DryRunOrder } from '@nemesis/execution';
import { SevenHourCampaignStore } from './sevenHourCampaignStore.js';

const roots: string[] = [];
const settings = { ...DEFAULT_ENTRY_QUALIFICATION, minSamples: 3, minWindowMs: 20 };

function fixture() {
  const card: ThesisCard = {
    id: 'card-1', ticker: 'KXTEST', title: 'Test', category: 'test', playbook: 'flow-hunter',
    status: 'tradeable', side: 'yes', marketPrice: 0.4, impliedPrice: 0.6, grossEdge: 0.2,
    netEdge: 0.15, spread: 0.02, depthUsd: 500, predictability: 0.9, feeEstimate: 0.02,
    signalReason: 'persistent flow', externalSummary: '', createdAt: 1_000, updatedAt: 1_000,
    freshnessMs: 0, edgeHistory: [0.15], drivers: [], invalidations: [], sourceMove: 'flow-driven',
  };
  const fill: DryRunOrder = {
    ticker: card.ticker, side: 'yes', contracts: 10, expectedPrice: 0.4, fillPrice: 0.4,
    filled: 10, fillLevels: [{ price: 0.4, quantity: 10, cost: 4 }], slippage: 0,
    fees: 0.17, feePolicyKnown: true, netEdge: 0.183, aborted: false,
  };
  const economics = calculateEntryEconomics({
    entryPrice: fill.fillPrice, entryFeesUsd: fill.fees, contracts: fill.filled,
    sideFairPrice: card.impliedPrice, marketPrice: card.marketPrice, grossEdge: card.grossEdge,
    screeningNetEdge: card.netEdge, executableEntryNetEdge: fill.netEdge,
    spread: card.spread, fillSlippage: fill.slippage,
  });
  return { card, fill, economics };
}

function open(filePath: string) {
  return SevenHourCampaignStore.open(filePath, {
    runId: 'run-1', evidenceNamespace: 'run-1', configurationHash: 'cfg-1', gitCommit: 'abc',
    stage: 'seven-hour', startedAt: 1_000, settings,
  }, settings);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SevenHourCampaignStore', () => {
  it('restores pending samples and appends one terminal transition after restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-campaign-'));
    roots.push(root);
    const filePath = path.join(root, 'campaign.jsonl');
    const first = open(filePath);
    const { card, fill, economics } = fixture();
    first.record((tracker) => tracker.enroll({ card, initialFill: fill, economics, enrolledAt: 1_000 }));
    const candidateId = first.snapshot().candidates[0]!.candidateId;
    for (let index = 0; index < 3; index += 1) {
      first.record((tracker) => tracker.recordSample(candidateId, {
        at: 1_000 + index * 10, observedAt: 1_000 + index * 10, netEdge: 0.18, spread: 0.02,
        bookTimestamp: 1_000 + index * 10, bookSequence: index + 1,
        exchangeTimestamp: 1_000 + index * 10, exchangeSequence: index + 1,
        fillPrice: 0.4, filled: 10, fees: 0.17, feePolicyKnown: true,
      }));
    }

    const restarted = open(filePath);
    expect(restarted.snapshot().candidates[0]!.samples).toHaveLength(3);
    restarted.record((tracker) => tracker.terminalize(candidateId, 'ready', 'confirmed', 1_040));
    restarted.record((tracker) => tracker.terminalize(candidateId, 'rejected', 'duplicate', 1_041));
    const reread = open(filePath).snapshot();
    expect(reread.integrityError).toBeUndefined();
    expect(reread.candidates[0]!.terminalState).toBe('ready');
  });

  it('fails closed when the hash-chained JSONL ledger is corrupt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-campaign-'));
    roots.push(root);
    const filePath = path.join(root, 'campaign.jsonl');
    fs.writeFileSync(filePath, '{"broken":true}\n', 'utf8');
    expect(open(filePath).snapshot().integrityError).toMatch(/integrity failure/i);
  });
});
