import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PaperQualificationStore } from './paperQualificationStore.js';

const roots: string[] = [];

function ledgerPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-qualification-'));
  roots.push(root);
  return path.join(root, 'paper-qualification-events.jsonl');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PaperQualificationStore', () => {
  it('replays append-only events with the same totals after restart', () => {
    const filePath = ledgerPath();
    const first = PaperQualificationStore.open(filePath, {
      startingCash: 5_000,
      strategyConfigHash: 'hash-a',
      now: 10,
      runId: 'run-a',
    });
    first.record((tracker) => tracker.recordEquity(5_025, 20));
    first.record((tracker) => tracker.recordFunnel('raw_candidates', 7, undefined, 21));

    const before = first.snapshot(30);
    const restarted = PaperQualificationStore.open(filePath, {
      startingCash: 999,
      strategyConfigHash: 'ignored',
    });
    const after = restarted.snapshot(30);

    expect(after.runId).toBe('run-a');
    expect(after.lastSequence).toBe(before.lastSequence);
    expect(after.endingEquity).toBe(5_025);
    expect(after.funnel.raw_candidates).toBe(7);
    expect(fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/)).toHaveLength(4);
  });

  it('fails closed when the JSONL evidence is corrupt', () => {
    const filePath = ledgerPath();
    fs.writeFileSync(filePath, '{not-json}\n', 'utf8');
    const store = PaperQualificationStore.open(filePath, {
      startingCash: 5_000,
      strategyConfigHash: 'hash-a',
    });

    expect(store.snapshot().auditClean).toBe(false);
    expect(store.snapshot().integrityError).toContain('unreadable');
    expect(() => store.record((tracker) => tracker.recordEquity(5_001))).toThrow('refusing qualification append');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{not-json}\n');
  });
});
