import fs from 'node:fs';
import path from 'node:path';
import {
  StrategyValidationTracker,
  type StrategyValidationEvent,
  type StrategyValidationSnapshot,
} from '@nemesis/execution';
import type { EntryQualificationSettings, StrategyValidationStage } from '@nemesis/core';

export interface StrategyValidationRunOptions {
  stage: StrategyValidationStage;
  strategyConfigHash: string;
  strategyEngineVersion: number;
  now?: number;
  runId?: string;
}

function readEvents(filePath: string): StrategyValidationEvent[] {
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return [];
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as StrategyValidationEvent);
}

function writeNewLedger(filePath: string, events: StrategyValidationEvent[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(tempPath, filePath);
}

export class StrategyValidationStore {
  private persistenceError?: string;

  private constructor(readonly filePath: string, readonly tracker: StrategyValidationTracker) {}

  static open(filePath: string, options: StrategyValidationRunOptions): StrategyValidationStore {
    if (!fs.existsSync(filePath)) {
      const tracker = StrategyValidationTracker.create(
        options.stage,
        options.strategyConfigHash,
        options.strategyEngineVersion,
        options.now,
        options.runId,
      );
      writeNewLedger(filePath, tracker.allEvents());
      return new StrategyValidationStore(filePath, tracker);
    }
    try {
      return new StrategyValidationStore(filePath, StrategyValidationTracker.replay(readEvents(filePath)));
    } catch (error) {
      const broken = new StrategyValidationStore(filePath, StrategyValidationTracker.replay([]));
      broken.persistenceError = `strategy validation ledger unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return broken;
    }
  }

  record<T extends StrategyValidationEvent | StrategyValidationEvent[]>(
    mutation: (tracker: StrategyValidationTracker) => T,
  ): T {
    if (this.persistenceError) throw new Error(`refusing strategy validation append: ${this.persistenceError}`);
    const integrityError = this.tracker.integrityFailure();
    if (integrityError) throw new Error(`refusing strategy validation append: ${integrityError}`);
    const before = this.tracker.lastSequence();
    const result = mutation(this.tracker);
    const created = this.tracker.eventsAfter(before);
    if (created.length > 0) {
      try {
        fs.appendFileSync(this.filePath, `${created.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
      } catch (error) {
        this.persistenceError = `strategy validation append failed: ${error instanceof Error ? error.message : String(error)}`;
        throw new Error(this.persistenceError);
      }
    }
    return result;
  }

  snapshot(settings: EntryQualificationSettings): StrategyValidationSnapshot {
    const snapshot = this.tracker.snapshot(settings);
    if (!this.persistenceError) return snapshot;
    return { ...snapshot, integrityError: this.persistenceError, shadowPassed: false };
  }
}
