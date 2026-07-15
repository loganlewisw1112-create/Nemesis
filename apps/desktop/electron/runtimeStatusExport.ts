import fs from 'node:fs';
import path from 'node:path';

export const UNSUPERVISED_RUNTIME_STATUS_INTERVAL_MS = 30_000;

export function runtimeStatusPathFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env.NEMESIS_RUNTIME_STATUS_PATH?.trim();
  return configured ? path.resolve(configured) : null;
}

/** Optional health-only export. It has no campaign, ledger, or pointer behavior. */
export class RuntimeStatusExporter {
  private lastWrittenAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly filePath: string | null,
    readonly intervalMs = UNSUPERVISED_RUNTIME_STATUS_INTERVAL_MS,
  ) {}

  writeIfDue(payload: Record<string, unknown>, now = Date.now()): boolean {
    if (!this.filePath || now - this.lastWrittenAt < this.intervalMs) return false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${now}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      this.lastWrittenAt = now;
      return true;
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }
}
