import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startupTrace } from './startupTrace.js';

describe('startupTrace', () => {
  const originalTrace = process.env.NEMESIS_STARTUP_TRACE;
  const originalFile = process.env.NEMESIS_STARTUP_TRACE_FILE;

  afterEach(() => {
    if (originalTrace === undefined) delete process.env.NEMESIS_STARTUP_TRACE;
    else process.env.NEMESIS_STARTUP_TRACE = originalTrace;
    if (originalFile === undefined) delete process.env.NEMESIS_STARTUP_TRACE_FILE;
    else process.env.NEMESIS_STARTUP_TRACE_FILE = originalFile;
    vi.restoreAllMocks();
  });

  it('writes startup labels to the configured trace file when enabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-startup-trace-'));
    const file = path.join(dir, 'startup.log');
    process.env.NEMESIS_STARTUP_TRACE = 'true';
    process.env.NEMESIS_STARTUP_TRACE_FILE = file;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    startupTrace('window-created');

    expect(fs.readFileSync(file, 'utf8')).toContain('window-created');
  });
});
