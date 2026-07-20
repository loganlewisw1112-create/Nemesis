import fs from 'node:fs';
import path from 'node:path';
import {
  SevenHourCampaignTracker,
  type CampaignEvent,
  type CampaignSnapshot,
  type StartCampaignOptions,
} from '@nemesis/execution';
import type { EntryQualificationSettings } from '@nemesis/core';

function readEvents(filePath: string): CampaignEvent[] {
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return [];
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as CampaignEvent);
}

function writeNewLedger(filePath: string, events: CampaignEvent[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  fs.renameSync(tempPath, filePath);
}

export class SevenHourCampaignStore {
  private persistenceError?: string;

  private constructor(readonly filePath: string, readonly tracker: SevenHourCampaignTracker) {}

  static open(
    filePath: string,
    options: StartCampaignOptions,
    settings: EntryQualificationSettings,
  ): SevenHourCampaignStore {
    if (!fs.existsSync(filePath)) {
      const tracker = SevenHourCampaignTracker.start(options);
      writeNewLedger(filePath, tracker.allEvents());
      return new SevenHourCampaignStore(filePath, tracker);
    }
    try {
      return new SevenHourCampaignStore(filePath, SevenHourCampaignTracker.replay(readEvents(filePath), settings));
    } catch (error) {
      const broken = new SevenHourCampaignStore(
        filePath,
        SevenHourCampaignTracker.replay([], settings),
      );
      broken.persistenceError = `campaign ledger unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return broken;
    }
  }

  record<T extends CampaignEvent[]>(mutation: (tracker: SevenHourCampaignTracker) => T): T {
    if (this.persistenceError) throw new Error(`refusing campaign append: ${this.persistenceError}`);
    // Every SevenHourCampaignTracker mutation returns exactly the events it appended
    // to the ledger (its append() results, in push order), or [] when it appended
    // nothing. That return value is identical to allEvents().slice(before). Using it
    // avoids structuredClone-ing the entire append-only ledger twice on every call —
    // O(ledger) work that ran on the per-orderbook-delta hot path and grew unbounded
    // with soak duration, starving the renderer heartbeat and invalidating soak/R10 runs.
    const result = mutation(this.tracker);
    const created: CampaignEvent[] = result;
    if (created.length > 0) {
      try {
        const fd = fs.openSync(this.filePath, 'a');
        try {
          fs.writeSync(fd, `${created.map((event) => JSON.stringify(event)).join('\n')}\n`, undefined, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        this.persistenceError = `campaign append failed: ${error instanceof Error ? error.message : String(error)}`;
        throw new Error(this.persistenceError);
      }
    }
    return result;
  }

  snapshot(): CampaignSnapshot {
    const snapshot = this.tracker.snapshot();
    if (!this.persistenceError) return snapshot;
    return { ...snapshot, integrityError: this.persistenceError, passed: false };
  }
}
