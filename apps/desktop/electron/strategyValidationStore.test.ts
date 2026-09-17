import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENTRY_QUALIFICATION } from '@nemesis/core';
import { StrategyValidationStore } from './strategyValidationStore.js';

describe('StrategyValidationStore', () => {
  it('persists pending shadow evidence and resumes it after restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-strategy-validation-'));
    const filePath = path.join(dir, 'paper-strategy-validation-events.jsonl');
    try {
      const first = StrategyValidationStore.open(filePath, {
        stage: 'shadow', strategyConfigHash: 'config-a', strategyEngineVersion: 2, now: 1_000, runId: 'run-a',
      });
      first.record((tracker) => tracker.startShadowCandidate({
        id: 'candidate-1', sourceSignalId: 'source-1', ticker: 'KXTEST-26', side: 'yes', playbook: 'flow-hunter',
        startedAt: 2_000, dueAt: 902_000, contracts: 20, entryPrice: 0.4, entryFeesUsd: 0.1,
        initialNetEdge: 0.1, expectedRewardUsd: 2, plannedLossUsd: 1, rewardRiskRatio: 2, stressedExpectedNetPnlUsd: 1,
      }));
      const reopened = StrategyValidationStore.open(filePath, {
        stage: 'shadow', strategyConfigHash: 'ignored', strategyEngineVersion: 99,
      });
      expect(reopened.snapshot(DEFAULT_ENTRY_QUALIFICATION)).toMatchObject({
        runId: 'run-a', strategyConfigHash: 'config-a', strategyEngineVersion: 2, shadowPendingCount: 1,
      });
      reopened.record((tracker) => tracker.scoreShadowCandidate('candidate-1', 1.5, 0.8, 'target reached', 3_000));
      expect(StrategyValidationStore.open(filePath, {
        stage: 'shadow', strategyConfigHash: 'config-a', strategyEngineVersion: 2,
      }).snapshot(DEFAULT_ENTRY_QUALIFICATION).shadowCandidateCount).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends without deep-cloning the whole ledger, and replays identically [soak-stall regression]', () => {
    // record() recovers the 1-2 events it just appended via tracker.eventsAfter(), which used
    // to route through allEvents() — a JSON deep copy of the entire append-only ledger, on
    // every append, on the per-orderbook-delta hot path. Same shape as the clone that once
    // starved the renderer heartbeat (sevenHourCampaignStore.record). eventsAfter() must
    // instead walk back only over the new tail, so the cost is O(appended).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-strategy-noclone-'));
    const filePath = path.join(dir, 'paper-strategy-validation-events.jsonl');
    try {
      const store = StrategyValidationStore.open(filePath, {
        stage: 'shadow', strategyConfigHash: 'config-a', strategyEngineVersion: 2, now: 1_000, runId: 'run-a',
      });
      const cloneLedger = vi.spyOn(store.tracker, 'allEvents');
      for (let index = 0; index < 200; index += 1) {
        store.record((tracker) => tracker.startShadowCandidate({
          id: `candidate-${index}`, sourceSignalId: `source-${index}`, ticker: 'KXTEST-26', side: 'yes',
          playbook: 'flow-hunter', startedAt: 2_000 + index, dueAt: 902_000 + index, contracts: 20,
          entryPrice: 0.4, entryFeesUsd: 0.1, initialNetEdge: 0.1, expectedRewardUsd: 2,
          plannedLossUsd: 1, rewardRiskRatio: 2, stressedExpectedNetPnlUsd: 1,
        }));
      }
      expect(cloneLedger).not.toHaveBeenCalled();

      // The tail it returns is exactly what the old full-scan filter would have returned.
      const all = store.tracker.allEvents();
      for (const sequence of [0, 1, 100, all.length - 1, all.length, all.length + 5]) {
        expect(store.tracker.eventsAfter(sequence))
          .toEqual(all.filter((event) => event.sequence > sequence));
      }

      const reopened = StrategyValidationStore.open(filePath, {
        stage: 'shadow', strategyConfigHash: 'ignored', strategyEngineVersion: 99,
      });
      expect(reopened.snapshot(DEFAULT_ENTRY_QUALIFICATION).integrityError).toBeUndefined();
      expect(reopened.snapshot(DEFAULT_ENTRY_QUALIFICATION).shadowPendingCount).toBe(200);
      expect(reopened.tracker.allEvents()).toEqual(all);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on corrupt saved evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-strategy-corrupt-'));
    const filePath = path.join(dir, 'paper-strategy-validation-events.jsonl');
    try {
      fs.writeFileSync(filePath, '{not-json}\n', 'utf8');
      const store = StrategyValidationStore.open(filePath, {
        stage: 'shadow', strategyConfigHash: 'config-a', strategyEngineVersion: 2,
      });
      const snapshot = store.snapshot(DEFAULT_ENTRY_QUALIFICATION);
      expect(snapshot.integrityError).toMatch(/unreadable/i);
      expect(snapshot.shadowPassed).toBe(false);
      expect(() => store.record((tracker) => tracker.pause('test'))).toThrow(/refusing/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for the rest of the process after an append failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-strategy-append-'));
    const filePath = path.join(dir, 'paper-strategy-validation-events.jsonl');
    try {
      const store = StrategyValidationStore.open(filePath, {
        stage: 'shadow', strategyConfigHash: 'config-a', strategyEngineVersion: 2,
      });
      const append = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
        throw new Error('disk unavailable');
      });
      expect(() => store.record((tracker) => tracker.pause('test'))).toThrow(/append failed/i);
      append.mockRestore();
      expect(store.snapshot(DEFAULT_ENTRY_QUALIFICATION)).toMatchObject({
        shadowPassed: false,
        integrityError: expect.stringMatching(/append failed/i),
      });
      expect(() => store.record((tracker) => tracker.pause('retry'))).toThrow(/refusing/i);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
