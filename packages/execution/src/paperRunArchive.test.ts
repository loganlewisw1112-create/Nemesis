import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveAndResetPaper, ARCHIVE_RESET_CONFIRMATION } from './paperRunArchive.js';

const roots: string[] = [];

function fixture(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-archive-'));
  roots.push(dataDir);
  fs.writeFileSync(path.join(dataDir, 'paper-portfolio.json'), JSON.stringify({
    cash: 4_950,
    startingCash: 5_000,
    positions: [{ id: 'p1' }],
    trades: [{ id: 't1' }],
    realizedPnl: -50,
  }));
  fs.writeFileSync(path.join(dataDir, 'paper-orders.json'), JSON.stringify([{ id: 'o1' }]));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ liveEnabled: false, liveStage: 'paper', autoLiveEnabled: false, maxPositionUsd: 10 }));
  fs.writeFileSync(path.join(dataDir, 'discovery-settings.json'), '{"preset":"balanced"}');
  fs.writeFileSync(path.join(dataDir, 'journal.json'), '[{"secret":"history"}]');
  fs.writeFileSync(path.join(dataDir, 'kalshi-credentials.v1.json'), '{"encrypted":"secret"}');
  return dataDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('archiveAndResetPaper', () => {
  it('refuses while an application is open and changes nothing', () => {
    const dataDir = fixture();
    expect(() => archiveAndResetPaper({
      dataDir,
      confirmation: ARCHIVE_RESET_CONFIRMATION,
      runningApplications: ['NEMESIS'],
      gitCommit: 'abc',
      appVersion: '0.1.0',
      strategyConfigHash: 'config',
      now: 100,
    })).toThrow('applications are open');
    expect(fs.existsSync(path.join(dataDir, 'archives'))).toBe(false);
  });

  it('archives verified runtime evidence, excludes secrets, and creates a clean $5,000 run', () => {
    const dataDir = fixture();
    const settingsBefore = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
    const credentialsBefore = fs.readFileSync(path.join(dataDir, 'kalshi-credentials.v1.json'), 'utf8');
    const result = archiveAndResetPaper({
      dataDir,
      confirmation: ARCHIVE_RESET_CONFIRMATION,
      runningApplications: [],
      gitCommit: 'abc',
      appVersion: '0.1.0',
      strategyConfigHash: 'config',
      now: Date.parse('2026-07-13T20:00:00Z'),
    });

    expect(result.portfolio).toEqual({ cash: 5_000, startingCash: 5_000, positions: [], trades: [], realizedPnl: 0 });
    expect(result.manifest.openPositionCount).toBe(1);
    expect(result.manifest.realizedPnl).toBe(-50);
    expect(fs.existsSync(path.join(result.archivePath, 'paper-portfolio.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.archivePath, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(result.archivePath, 'kalshi-credentials.v1.json'))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).toBe(settingsBefore);
    expect(fs.readFileSync(path.join(dataDir, 'kalshi-credentials.v1.json'), 'utf8')).toBe(credentialsBefore);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'session-stats.json'), 'utf8')).shutdown).toEqual({
      consecutiveInvalidations: 0,
      abnormalExecutions: 0,
      apiDegradedMinutes: 0,
      manualOverrides: 0,
    });
    expect(fs.readFileSync(path.join(dataDir, 'paper-qualification-events.jsonl'), 'utf8')).toContain(result.newRunId);
  });

  it('requires live to be locked without modifying settings', () => {
    const dataDir = fixture();
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ liveEnabled: true, liveStage: 'manual-live', autoLiveEnabled: false }));
    expect(() => archiveAndResetPaper({
      dataDir,
      confirmation: ARCHIVE_RESET_CONFIRMATION,
      runningApplications: [],
      gitCommit: 'abc',
      appVersion: '0.1.0',
      strategyConfigHash: 'config',
    })).toThrow('live settings must already be locked');
  });
});
