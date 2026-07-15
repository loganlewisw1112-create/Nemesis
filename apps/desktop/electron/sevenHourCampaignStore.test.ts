import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildKalshiFeePolicy, DEFAULT_ENTRY_QUALIFICATION, type ThesisCard } from '@nemesis/core';
import { qualifyCampaignEnrollment, type DryRunOrder } from '@nemesis/execution';
import { SevenHourCampaignStore } from './sevenHourCampaignStore.js';

const roots: string[] = [];
const settings = { ...DEFAULT_ENTRY_QUALIFICATION, minSamples: 6, minWindowMs: 50 };

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
  const feePolicy = buildKalshiFeePolicy({ multiplier: 1, accountPrecision: 'direct' });
  const decision = qualifyCampaignEnrollment({
    card,
    fill,
    bookTimestamp: 1_000,
    bookSequence: 1,
    feePolicy,
    observedAt: 1_000,
    maxSafeContracts: 10,
    entryRiskUsd: 4.17,
    settings,
  });
  if (decision.status !== 'eligible') throw new Error(decision.reason);
  return { card, fill, decision };
}

function open(filePath: string) {
  return SevenHourCampaignStore.open(filePath, {
    runId: 'run-1', evidenceNamespace: 'run-1', configurationHash: 'cfg-1', gitCommit: 'abc',
    stage: 'seven-hour', startedAt: 1_000, settings,
  }, settings);
}

function sample(sequence: number) {
  const observedAt = 1_000 + (sequence - 1) * 10;
  return {
    at: observedAt,
    observedAt,
    netEdge: 0.18,
    spread: 0.02,
    bookTimestamp: observedAt,
    bookSequence: sequence,
    exchangeTimestamp: observedAt,
    exchangeSequence: sequence,
    fillPrice: 0.4,
    filled: 10,
    fees: 0.17,
    feePolicyKnown: true,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SevenHourCampaignStore', () => {
  it('survives restart after enrollment and after three samples with exactly six samples, one diagnostic, and one terminal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-campaign-six-samples-'));
    roots.push(root);
    const filePath = path.join(root, 'campaign.jsonl');
    const { card, fill, decision } = fixture();

    const initial = open(filePath);
    initial.record((tracker) => tracker.enrollQualified({
      card,
      initialFill: fill,
      screening: decision,
      completedAt: 1_000,
    }));
    const candidateId = initial.snapshot().candidates[0]!.candidateId;

    const afterEnrollmentRestart = open(filePath);
    expect(afterEnrollmentRestart.snapshot()).toMatchObject({
      candidates: [{ candidateId, samples: [{ exchangeSequence: 1 }] }],
      diagnostics: [{ candidateId, attempts: 0, status: 'scheduled' }],
    });
    afterEnrollmentRestart.record((tracker) => tracker.recordSample(candidateId, sample(2)));
    afterEnrollmentRestart.record((tracker) => tracker.recordSample(candidateId, sample(3)));
    afterEnrollmentRestart.record((tracker) => tracker.recordSample(candidateId, sample(3)));

    const afterThreeSamplesRestart = open(filePath);
    expect(afterThreeSamplesRestart.snapshot().candidates[0]!.samples.map((item) => item.exchangeSequence))
      .toEqual([1, 2, 3]);
    expect(afterThreeSamplesRestart.snapshot().diagnostics).toHaveLength(1);
    for (const sequence of [4, 5, 6]) {
      afterThreeSamplesRestart.record((tracker) => tracker.recordSample(candidateId, sample(sequence)));
    }
    afterThreeSamplesRestart.record((tracker) => tracker.recordSample(candidateId, sample(6)));
    afterThreeSamplesRestart.record((tracker) => tracker.terminalize(candidateId, 'ready', 'six samples confirmed', 1_060));
    afterThreeSamplesRestart.record((tracker) => tracker.terminalize(candidateId, 'rejected', 'duplicate terminal ignored', 1_061));

    const finalStore = open(filePath);
    const finalSnapshot = finalStore.snapshot();
    expect(finalSnapshot.integrityError).toBeUndefined();
    expect(finalSnapshot.candidates).toMatchObject([{
      candidateId,
      terminalState: 'ready',
      terminalReason: 'six samples confirmed',
    }]);
    expect(finalSnapshot.candidates[0]!.samples.map((item) => item.exchangeSequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(finalSnapshot.diagnostics).toHaveLength(1);

    const events = fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === 'candidate_enrolled')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'candidate_sampled')).toHaveLength(5);
    expect(events.filter((event) => event.type === 'candidate_terminal')).toHaveLength(1);
  });

  it('restores pending samples and appends one terminal transition after restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-campaign-'));
    roots.push(root);
    const filePath = path.join(root, 'campaign.jsonl');
    const first = open(filePath);
    const { card, fill, decision } = fixture();
    first.record((tracker) => tracker.enrollQualified({ card, initialFill: fill, screening: decision, completedAt: 1_000 }));
    const candidateId = first.snapshot().candidates[0]!.candidateId;
    for (let index = 1; index < 3; index += 1) {
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
