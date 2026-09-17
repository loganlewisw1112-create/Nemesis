import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only JSONL with a hard ceiling on what it can occupy.
 *
 * The bridge telemetry ledger reached 406 MB with no rotation of any kind. It is
 * diagnostic, not evidence -- nothing replays it and no gate reads it -- so the
 * useful part is always the recent tail. Rotation keeps that tail while bounding
 * total footprint at `maxBytesPerFile * (maxFiles + 1)`.
 *
 * Writes stay synchronous on purpose. This file is read after a crash or a hang,
 * which is exactly when buffered records would be the ones missing.
 */
export interface RotatingJsonlOptions {
  maxBytesPerFile: number;
  /** Rotated generations kept alongside the live file. */
  maxFiles: number;
}

export class RotatingJsonlWriter {
  /** Tracked in memory so a size check does not cost a stat syscall per record. */
  private bytesWritten: number | null = null;
  private failed = false;

  constructor(
    readonly filePath: string,
    private readonly options: RotatingJsonlOptions,
  ) {}

  private currentSize(): number {
    if (this.bytesWritten != null) return this.bytesWritten;
    try {
      this.bytesWritten = fs.statSync(this.filePath).size;
    } catch {
      this.bytesWritten = 0;
    }
    return this.bytesWritten;
  }

  /**
   * Shifts generations down and drops the oldest: `.2` -> `.3`, `.1` -> `.2`,
   * live -> `.1`. Anything past `maxFiles` is removed.
   */
  private rotate(): void {
    const { maxFiles } = this.options;
    if (maxFiles <= 0) {
      fs.rmSync(this.filePath, { force: true });
      this.bytesWritten = 0;
      return;
    }
    fs.rmSync(`${this.filePath}.${maxFiles}`, { force: true });
    for (let generation = maxFiles - 1; generation >= 1; generation -= 1) {
      const from = `${this.filePath}.${generation}`;
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, `${this.filePath}.${generation + 1}`);
    }
    if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
    this.bytesWritten = 0;
  }

  /** Returns true when the record reached disk. Never throws. */
  append(record: unknown): boolean {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Rotate before the write that would breach the ceiling, so a single
      // oversized record cannot leave the live file permanently over it.
      if (this.currentSize() > 0 && this.currentSize() + line.length > this.options.maxBytesPerFile) {
        this.rotate();
      }
      fs.appendFileSync(this.filePath, line, 'utf8');
      this.bytesWritten = this.currentSize() + line.length;
      this.failed = false;
      return true;
    } catch (error) {
      // A telemetry write must never take the process with it. Report once per
      // failure streak rather than on every record.
      if (!this.failed) {
        this.failed = true;
        console.error(`[nemesis] telemetry append failed for ${this.filePath}`, error);
      }
      this.bytesWritten = null;
      return false;
    }
  }
}
