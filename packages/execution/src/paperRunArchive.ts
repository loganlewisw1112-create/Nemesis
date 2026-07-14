import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DEFAULT_SHUTDOWN_COUNTERS, type PaperPortfolio } from '@nemesis/core';
import { PaperQualificationTracker } from './paperQualification.js';

export const ARCHIVE_RESET_CONFIRMATION = 'ARCHIVE_AND_RESET_PAPER';

const ARCHIVED_RUNTIME_FILES = [
  'paper-portfolio.json',
  'paper-orders.json',
  'equity-history.json',
  'session-stats.json',
  'auto-close-state.json',
  'audit-log.json',
  'paper-qualification-events.jsonl',
  path.join('reports', 'weekly-report.md'),
  path.join('reports', 'weekly-report-cursor.json'),
] as const;

const PROTECTED_FILES = [
  'settings.json',
  'discovery-settings.json',
  'journal.json',
  'kalshi-credentials.v1.json',
] as const;

export interface PaperArchiveManifest {
  schemaVersion: 1;
  archiveId: string;
  createdAt: string;
  gitCommit: string;
  appVersion: string;
  startingCash: number;
  cash: number;
  realizedPnl: number;
  openPositionCount: number;
  files: Array<{ relativePath: string; sha256: string; bytes: number }>;
  protectedFileHashes: Record<string, string | null>;
}

export interface ArchiveAndResetPaperInput {
  dataDir: string;
  confirmation: string;
  runningApplications: string[];
  gitCommit: string;
  appVersion: string;
  strategyConfigHash: string;
  now?: number;
}

export interface ArchiveAndResetPaperResult {
  archivePath: string;
  newRunId: string;
  portfolio: PaperPortfolio;
  manifest: PaperArchiveManifest;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function protectedHashes(dataDir: string): Record<string, string | null> {
  return Object.fromEntries(PROTECTED_FILES.map((relativePath) => {
    const filePath = path.join(dataDir, relativePath);
    return [relativePath, fs.existsSync(filePath) ? sha256File(filePath) : null];
  }));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
}

function readPortfolio(dataDir: string): PaperPortfolio {
  const filePath = path.join(dataDir, 'paper-portfolio.json');
  if (!fs.existsSync(filePath)) {
    return { cash: 5_000, startingCash: 5_000, positions: [], trades: [], realizedPnl: 0 };
  }
  const portfolio = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PaperPortfolio;
  if (!Array.isArray(portfolio.positions) || !Array.isArray(portfolio.trades)) {
    throw new Error('paper portfolio is invalid');
  }
  return portfolio;
}

function assertLiveAlreadyLocked(dataDir: string): void {
  const settingsPath = path.join(dataDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    liveEnabled?: boolean;
    liveStage?: string;
    autoLiveEnabled?: boolean;
  };
  if (settings.liveEnabled || (settings.liveStage ?? 'paper') !== 'paper' || settings.autoLiveEnabled) {
    throw new Error('live settings must already be locked to paper before archive/reset');
  }
}

function safeArchiveName(now: number): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-pre-qualification-upgrade`;
}

export function detectRunningNemesisApplications(excludePid?: number): string[] {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('tasklist.exe', ['/fo', 'csv', '/nh'], { encoding: 'utf8' });
      const matches: string[] = [];
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (!match) continue;
        const name = match[1];
        const pid = Number(match[2]);
        if (pid === excludePid) continue;
        if (/^(NEMESIS|Global Event Alpha)\.exe$/i.test(name)) matches.push(`${name} (${pid})`);
      }
      return matches;
    }
    const output = execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8' });
    return output.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match || Number(match[1]) === excludePid) return [];
      return /(nemesis|global.event.alpha)/i.test(match[2]) ? [`${match[2]} (${match[1]})`] : [];
    });
  } catch (error) {
    return [`application detection failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

export function archiveAndResetPaper(input: ArchiveAndResetPaperInput): ArchiveAndResetPaperResult {
  if (input.confirmation !== ARCHIVE_RESET_CONFIRMATION) {
    throw new Error(`confirmation must equal ${ARCHIVE_RESET_CONFIRMATION}`);
  }
  if (input.runningApplications.length > 0) {
    throw new Error(`refusing archive/reset while applications are open: ${input.runningApplications.join(', ')}`);
  }
  assertLiveAlreadyLocked(input.dataDir);

  const now = input.now ?? Date.now();
  const archiveId = safeArchiveName(now);
  const archivesDir = path.join(input.dataDir, 'archives');
  const archivePath = path.join(archivesDir, archiveId);
  if (fs.existsSync(archivePath)) throw new Error(`archive already exists: ${archivePath}`);
  fs.mkdirSync(archivesDir, { recursive: true });
  fs.mkdirSync(archivePath, { recursive: false });

  const beforeProtected = protectedHashes(input.dataDir);
  const portfolioBefore = readPortfolio(input.dataDir);
  const archivedFiles: PaperArchiveManifest['files'] = [];
  for (const relativePath of ARCHIVED_RUNTIME_FILES) {
    const source = path.join(input.dataDir, relativePath);
    if (!fs.existsSync(source)) continue;
    const target = path.join(archivePath, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const sourceHash = sha256File(source);
    const targetHash = sha256File(target);
    if (sourceHash !== targetHash) throw new Error(`archive hash verification failed: ${relativePath}`);
    archivedFiles.push({ relativePath, sha256: targetHash, bytes: fs.statSync(target).size });
  }

  const manifest: PaperArchiveManifest = {
    schemaVersion: 1,
    archiveId,
    createdAt: new Date(now).toISOString(),
    gitCommit: input.gitCommit,
    appVersion: input.appVersion,
    startingCash: portfolioBefore.startingCash,
    cash: portfolioBefore.cash,
    realizedPnl: portfolioBefore.realizedPnl,
    openPositionCount: portfolioBefore.positions.length,
    files: archivedFiles,
    protectedFileHashes: beforeProtected,
  };
  writeJsonAtomic(path.join(archivePath, 'manifest.json'), manifest);
  const verifiedManifest = JSON.parse(fs.readFileSync(path.join(archivePath, 'manifest.json'), 'utf8')) as PaperArchiveManifest;
  for (const file of verifiedManifest.files) {
    const archivedFile = path.join(archivePath, file.relativePath);
    if (!fs.existsSync(archivedFile) || sha256File(archivedFile) !== file.sha256) {
      throw new Error(`manifest verification failed: ${file.relativePath}`);
    }
  }

  const startingCash = 5_000;
  const newRunId = `pqr-${now}-${randomUUID()}`;
  const portfolio: PaperPortfolio = {
    cash: startingCash,
    startingCash,
    positions: [],
    trades: [],
    realizedPnl: 0,
  };
  const tracker = PaperQualificationTracker.create(startingCash, input.strategyConfigHash, now, newRunId);
  const reportsDir = path.join(input.dataDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  writeJsonAtomic(path.join(input.dataDir, 'paper-portfolio.json'), portfolio);
  writeJsonAtomic(path.join(input.dataDir, 'paper-orders.json'), []);
  writeJsonAtomic(path.join(input.dataDir, 'equity-history.json'), [
    { t: now, equity: startingCash, deployed: 0, cash: startingCash },
  ]);
  writeJsonAtomic(path.join(input.dataDir, 'session-stats.json'), {
    dayStart: now,
    dailyPnl: 0,
    tradeCount: 0,
    abortCount: 0,
    startingEquity: startingCash,
    shutdown: { ...DEFAULT_SHUTDOWN_COUNTERS },
  });
  writeJsonAtomic(path.join(input.dataDir, 'auto-close-state.json'), { states: [], decisions: [] });
  writeJsonAtomic(path.join(input.dataDir, 'audit-log.json'), []);
  fs.writeFileSync(
    path.join(input.dataDir, 'paper-qualification-events.jsonl'),
    `${tracker.allEvents().map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(reportsDir, 'weekly-report.md'),
    `# NEMESIS Paper Qualification Reports\n\nRun ID: ${newRunId}\n`,
    'utf8',
  );
  writeJsonAtomic(path.join(reportsDir, 'weekly-report-cursor.json'), {
    runId: newRunId,
    lastEventNumber: tracker.snapshot(now).lastSequence,
    lastRunAt: null,
  });

  const afterProtected = protectedHashes(input.dataDir);
  if (JSON.stringify(afterProtected) !== JSON.stringify(beforeProtected)) {
    throw new Error('protected settings, credentials, discovery, or journal data changed during reset');
  }

  return { archivePath, newRunId, portfolio, manifest };
}
