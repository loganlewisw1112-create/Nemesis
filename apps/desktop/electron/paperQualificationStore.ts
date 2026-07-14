import fs from 'node:fs';
import path from 'node:path';
import {
  PaperQualificationTracker,
  type PaperQualificationEvent,
  type PaperQualificationSnapshot,
} from '@nemesis/execution';

export interface QualificationRunOptions {
  startingCash: number;
  strategyConfigHash: string;
  now?: number;
  runId?: string;
}

function readEvents(filePath: string): PaperQualificationEvent[] {
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PaperQualificationEvent);
}

function writeNewLedger(filePath: string, events: PaperQualificationEvent[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  fs.renameSync(tempPath, filePath);
}

export class PaperQualificationStore {
  private persistenceError?: string;

  private constructor(
    readonly filePath: string,
    readonly tracker: PaperQualificationTracker,
  ) {}

  static open(filePath: string, options: QualificationRunOptions): PaperQualificationStore {
    if (!fs.existsSync(filePath)) {
      const tracker = PaperQualificationTracker.create(
        options.startingCash,
        options.strategyConfigHash,
        options.now,
        options.runId,
      );
      writeNewLedger(filePath, tracker.allEvents());
      return new PaperQualificationStore(filePath, tracker);
    }

    try {
      return new PaperQualificationStore(filePath, PaperQualificationTracker.replay(readEvents(filePath)));
    } catch (error) {
      const store = new PaperQualificationStore(filePath, PaperQualificationTracker.replay([]));
      store.persistenceError = `qualification ledger unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return store;
    }
  }

  record<T extends PaperQualificationEvent | PaperQualificationEvent[]>(
    mutation: (tracker: PaperQualificationTracker) => T,
  ): T {
    if (this.persistenceError) throw new Error(`refusing qualification append: ${this.persistenceError}`);
    const integrityError = this.tracker.integrityFailure();
    if (integrityError) throw new Error(`refusing qualification append: ${integrityError}`);
    const before = this.tracker.lastSequence();
    const result = mutation(this.tracker);
    const created = this.tracker.eventsAfter(before);
    try {
      if (created.length > 0) {
        fs.appendFileSync(this.filePath, `${created.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
      }
    } catch (error) {
      this.persistenceError = `qualification ledger append failed: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
    return result;
  }

  snapshot(now = Date.now()): PaperQualificationSnapshot {
    const snapshot = this.tracker.snapshot(now);
    if (!this.persistenceError) return snapshot;
    return {
      ...snapshot,
      integrityError: this.persistenceError,
      auditClean: false,
    };
  }
}
