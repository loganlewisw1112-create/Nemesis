#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareLegacyEntryEconomics } from '../packages/execution/src/tradeEconomics.ts';
import { StrategyValidationTracker } from '../packages/execution/src/strategyValidation.ts';

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const defaultLedger = path.join(appData, '@nemesis', 'desktop', 'nemesis-data', 'paper-strategy-validation-events.jsonl');
const ledgerPath = path.resolve(process.argv[2] ?? defaultLedger);

if (!fs.existsSync(ledgerPath)) throw new Error(`strategy validation ledger not found: ${ledgerPath}`);

const events = fs.readFileSync(ledgerPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const replay = StrategyValidationTracker.replay(events);
if (replay.integrityFailure()) throw new Error(replay.integrityFailure());
const observations = events.filter((event) => event.type === 'entry_confirmation_observed');
const scorable = observations.filter((event) => event.economics);
const comparisons = scorable.map((event) => compareLegacyEntryEconomics(event.economics));
const corrections = comparisons.map((row) => row.correctionUsd);
const sum = (values) => values.reduce((total, value) => total + value, 0);

const summary = {
  ledgerPath,
  runId: events[0]?.runId ?? null,
  schemaVersion: events[0]?.schemaVersion ?? null,
  integrityVerified: true,
  observations: observations.length,
  scorableObservations: scorable.length,
  unscorableObservations: observations.length - scorable.length,
  legacyPassingOneDollar: comparisons.filter((row) => row.legacyTargetRewardUsd >= 1).length,
  correctedPassingOneDollar: comparisons.filter((row) => row.correctedTargetRewardUsd >= 1).length,
  totalCorrectionUsd: Number(sum(corrections).toFixed(6)),
  averageCorrectionUsd: corrections.length > 0 ? Number((sum(corrections) / corrections.length).toFixed(6)) : null,
  minimumCorrectionUsd: corrections.length > 0 ? Math.min(...corrections) : null,
  maximumCorrectionUsd: corrections.length > 0 ? Math.max(...corrections) : null,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
