import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_ENTRY_QUALIFICATION } from '@nemesis/core';
import { SevenHourCampaignTracker, type CampaignEvent } from '@nemesis/execution';

describe('evidence campaign invalidation script', () => {
  it('closes the active namespace with a valid hash-chained event', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-campaign-appdata-'));
    try {
      const campaignDir = path.join(appData, '@nemesis', 'desktop', 'nemesis-data', 'evidence-campaigns');
      fs.mkdirSync(campaignDir, { recursive: true });
      const namespace = 'instrumentation-test';
      const filePath = path.join(campaignDir, `${namespace}.jsonl`);
      const tracker = SevenHourCampaignTracker.start({
        runId: namespace,
        evidenceNamespace: namespace,
        configurationHash: 'cfg',
        gitCommit: 'commit',
        stage: 'instrumentation',
        startedAt: Date.now(),
        settings: DEFAULT_ENTRY_QUALIFICATION,
        productionArtifactHash: 'a'.repeat(64),
        soakVerificationReceiptHash: 'b'.repeat(64),
      });
      fs.writeFileSync(filePath, `${tracker.allEvents().map((event) => JSON.stringify(event)).join('\n')}\n`);
      fs.writeFileSync(path.join(campaignDir, 'active-campaign.json'), JSON.stringify({
        evidenceNamespace: namespace,
        stage: 'instrumentation',
        filePath,
      }));

      const result = spawnSync(process.execPath, [
        path.join(process.cwd(), 'scripts', 'invalidate-evidence-campaign.cjs'),
        'test restart',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, APPDATA: appData },
      });

      expect(result.status, result.stderr).toBe(0);
      const events = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as CampaignEvent);
      const replayed = SevenHourCampaignTracker.replay(events, DEFAULT_ENTRY_QUALIFICATION).snapshot();
      expect(replayed.integrityError).toBeUndefined();
      expect(replayed.manifest.status).toBe('invalidated');
      expect(events.at(-1)?.type).toBe('run_invalidated');
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });
});
