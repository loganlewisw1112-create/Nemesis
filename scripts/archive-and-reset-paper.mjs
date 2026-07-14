#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AUTO_CLOSE_SETTINGS,
  DEFAULT_DISCOVERY_SETTINGS,
  DEFAULT_ENTRY_QUALIFICATION,
  DEFAULT_GUARDRAILS,
  DEFAULT_OPPORTUNITY_THROUGHPUT,
  DEFAULT_STRICT_PROFIT_MODE,
} from '../packages/core/src/index.ts';
import {
  archiveAndResetPaper,
  detectRunningNemesisApplications,
} from '../packages/execution/src/paperRunArchive.ts';
import { buildStrategyConfigHash, PAPER_STRATEGY_ENGINE_VERSION } from '../apps/desktop/electron/qualificationConfig.ts';

const repoRoot = process.env.NEMESIS_REPO_ROOT
  ? path.resolve(process.env.NEMESIS_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dataDir = path.join(appData, '@nemesis', 'desktop', 'nemesis-data');
const confirmation = process.argv[2] ?? '';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const rawSettings = readJson(path.join(dataDir, 'settings.json'), {});
const settings = {
  ...DEFAULT_GUARDRAILS,
  ...rawSettings,
  autoClose: { ...DEFAULT_AUTO_CLOSE_SETTINGS, ...(rawSettings.autoClose ?? {}) },
  strictProfitMode: { ...DEFAULT_STRICT_PROFIT_MODE, ...(rawSettings.strictProfitMode ?? {}) },
  opportunityThroughput: { ...DEFAULT_OPPORTUNITY_THROUGHPUT, ...(rawSettings.opportunityThroughput ?? {}) },
  entryQualification: { ...DEFAULT_ENTRY_QUALIFICATION, ...(rawSettings.entryQualification ?? {}) },
};
const discovery = {
  ...DEFAULT_DISCOVERY_SETTINGS,
  ...readJson(path.join(dataDir, 'discovery-settings.json'), {}),
};
const desktopPackage = readJson(path.join(repoRoot, 'apps', 'desktop', 'package.json'), { version: 'unknown' });
const gitCommit = execFileSync(
  'git.exe',
  ['-c', `safe.directory=${repoRoot.replace(/\\/g, '/')}`, 'rev-parse', 'HEAD'],
  { cwd: repoRoot, encoding: 'utf8' },
).trim();

const result = archiveAndResetPaper({
  dataDir,
  confirmation,
  runningApplications: detectRunningNemesisApplications(),
  gitCommit,
  appVersion: desktopPackage.version,
  strategyConfigHash: buildStrategyConfigHash(settings, discovery),
  strategyEngineVersion: PAPER_STRATEGY_ENGINE_VERSION,
});

process.stdout.write(`${JSON.stringify({
  archivePath: result.archivePath,
  newRunId: result.newRunId,
  portfolio: result.portfolio,
  manifestFiles: result.manifest.files.length,
}, null, 2)}\n`);
