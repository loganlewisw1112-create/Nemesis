#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ENTRY_QUALIFICATION } from '../packages/core/src/index.ts';
import { SevenHourCampaignTracker } from '../packages/execution/src/sevenHourCampaign.ts';

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const campaignDir = path.join(appData, '@nemesis', 'desktop', 'nemesis-data', 'evidence-campaigns');
const pointerPath = path.join(campaignDir, 'active-campaign.json');
const settingsPath = path.join(appData, '@nemesis', 'desktop', 'nemesis-data', 'settings.json');
const reason = process.argv.slice(2).join(' ').trim() || 'superseded by an explicitly restarted evidence campaign';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

if (!fs.existsSync(pointerPath)) {
  process.stdout.write(`${JSON.stringify({ invalidated: false, reason: 'no active campaign pointer' })}\n`);
  process.exit(0);
}

const pointer = readJson(pointerPath, null);
if (!pointer?.evidenceNamespace || !pointer?.filePath) throw new Error('active campaign pointer is invalid');
const expectedPath = path.resolve(campaignDir, `${pointer.evidenceNamespace}.jsonl`);
if (path.resolve(pointer.filePath) !== expectedPath) throw new Error('active campaign pointer escaped the campaign directory');
const lines = fs.readFileSync(expectedPath, 'utf8').split(/\r?\n/).filter(Boolean);
const events = lines.map((line) => JSON.parse(line));
const rawSettings = readJson(settingsPath, {});
const settings = { ...DEFAULT_ENTRY_QUALIFICATION, ...(rawSettings.entryQualification ?? {}) };
const tracker = SevenHourCampaignTracker.replay(events, settings);
const before = tracker.allEvents().length;
const current = tracker.snapshot();

if (current.integrityError) throw new Error(current.integrityError);
if (current.manifest.status !== 'active') {
  process.stdout.write(`${JSON.stringify({
    invalidated: false,
    namespace: pointer.evidenceNamespace,
    status: current.manifest.status,
  }, null, 2)}\n`);
  process.exit(0);
}

tracker.invalidate(reason, Date.now());
const created = tracker.allEvents().slice(before);
fs.appendFileSync(expectedPath, `${created.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
const final = tracker.snapshot();
process.stdout.write(`${JSON.stringify({
  invalidated: true,
  namespace: pointer.evidenceNamespace,
  status: final.manifest.status,
  appendedEvents: created.length,
  lastSequence: final.lastSequence,
  lastHash: final.lastHash,
}, null, 2)}\n`);
