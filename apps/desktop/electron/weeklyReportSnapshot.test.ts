import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { generateWeeklyReport } = require('../../../scripts/weekly-report-snapshot.cjs') as {
  generateWeeklyReport: (dataDir: string, now: Date) => {
    runId: string;
    newEventCount: number;
    lines: string[];
    cursorPath: string;
  };
};
const roots: string[] = [];

function fixture(runId = 'run-a'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-report-'));
  roots.push(root);
  const events: Array<Record<string, unknown>> = [];
  const add = (payload: Record<string, unknown>) => {
    const unsigned = {
      schemaVersion: 1,
      runId,
      sequence: events.length + 1,
      at: 1,
      previousHash: (events.at(-1)?.hash as string | undefined) ?? 'GENESIS',
      ...payload,
    };
    const stable = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
          .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
      }
      return JSON.stringify(value);
    };
    events.push({ ...unsigned, hash: createHash('sha256').update(stable(unsigned)).digest('hex') });
  };
  add({ type: 'run_started', startingCash: 5_000, strategyConfigHash: 'hash' });
  add({ type: 'equity_checkpoint', equity: 5_000 });
  fs.writeFileSync(path.join(root, 'paper-qualification-events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'paper-portfolio.json'), JSON.stringify({ cash: 5_000, positions: [] }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('weekly qualification report', () => {
  it('uses run ID and event number and never reports negative counts', () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, 'reports'));
    fs.writeFileSync(path.join(root, 'reports', 'weekly-report-cursor.json'), JSON.stringify({
      runId: 'run-a',
      lastEventNumber: 999,
      lastRunAt: 'old',
    }));
    const result = generateWeeklyReport(root, new Date('2026-07-13T20:00:00Z'));
    expect(result.newEventCount).toBe(0);
    expect(result.lines.join('\n')).not.toMatch(/: -\d/);
  });

  it('starts at event one when the run ID changes', () => {
    const root = fixture('run-b');
    fs.mkdirSync(path.join(root, 'reports'));
    fs.writeFileSync(path.join(root, 'reports', 'weekly-report-cursor.json'), JSON.stringify({
      runId: 'run-a',
      lastEventNumber: 50,
    }));
    const result = generateWeeklyReport(root, new Date('2026-07-13T20:00:00Z'));
    expect(result.runId).toBe('run-b');
    expect(result.newEventCount).toBe(2);
    expect(JSON.parse(fs.readFileSync(result.cursorPath, 'utf8')).lastEventNumber).toBe(2);
  });
});
