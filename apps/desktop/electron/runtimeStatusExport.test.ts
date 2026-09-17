import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeStatusExporter,
  runtimeStatusPathFromEnvironment,
} from './runtimeStatusExport.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('RuntimeStatusExporter', () => {
  it('is disabled unless the opt-in environment path is present', () => {
    expect(runtimeStatusPathFromEnvironment({})).toBeNull();
    expect(new RuntimeStatusExporter(null).writeIfDue({ state: 'healthy' }, 1)).toBe(false);
  });

  it('atomically publishes at most once per 30-second interval', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-runtime-status-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'nested', 'runtime.json');
    const exporter = new RuntimeStatusExporter(filePath);

    expect(exporter.writeIfDue({ state: 'warming' }, 10_000)).toBe(true);
    expect(exporter.writeIfDue({ state: 'healthy' }, 39_999)).toBe(false);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ state: 'warming' });

    expect(exporter.writeIfDue({ state: 'healthy' }, 40_000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ state: 'healthy' });
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
