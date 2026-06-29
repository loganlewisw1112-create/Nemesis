import fs from 'node:fs';
import path from 'node:path';

export function startupTrace(label: string) {
  if (process.env.NEMESIS_STARTUP_TRACE !== 'true') return;
  const line = `[nemesis:start] ${Date.now()} ${label}`;
  console.error(line);
  const traceFile = process.env.NEMESIS_STARTUP_TRACE_FILE;
  if (!traceFile) return;
  try {
    fs.mkdirSync(path.dirname(traceFile), { recursive: true });
    fs.appendFileSync(traceFile, `${line}\n`);
  } catch {
    /* tracing must never block startup */
  }
}
