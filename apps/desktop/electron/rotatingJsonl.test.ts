import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RotatingJsonlWriter } from './rotatingJsonl.js';

const roots: string[] = [];

function ledgerPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-rotating-'));
  roots.push(root);
  return path.join(root, 'bridge-telemetry.jsonl');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('RotatingJsonlWriter', () => {
  it('bounds total footprint at maxBytesPerFile * (maxFiles + 1)', () => {
    // The bridge telemetry ledger reached 406 MB unrotated. Whatever the write
    // volume, the ceiling must hold.
    const filePath = ledgerPath();
    const writer = new RotatingJsonlWriter(filePath, { maxBytesPerFile: 512, maxFiles: 2 });
    for (let index = 0; index < 2_000; index += 1) {
      expect(writer.append({ at: index, event: 'tick', pad: 'x'.repeat(40) })).toBe(true);
    }

    const dir = path.dirname(filePath);
    const written = fs.readdirSync(dir).map((name) => fs.statSync(path.join(dir, name)).size);
    expect(written.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(512 * 3);
    // Live file plus exactly maxFiles generations, never more.
    expect(fs.readdirSync(dir).sort()).toEqual([
      'bridge-telemetry.jsonl',
      'bridge-telemetry.jsonl.1',
      'bridge-telemetry.jsonl.2',
    ]);
  });

  it('keeps the most recent records, which are the ones worth keeping', () => {
    const filePath = ledgerPath();
    const writer = new RotatingJsonlWriter(filePath, { maxBytesPerFile: 256, maxFiles: 1 });
    for (let index = 0; index < 500; index += 1) writer.append({ at: index });

    const live = fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { at: number });
    expect(live.at(-1)!.at).toBe(499);
    // And the generation behind it is strictly older.
    const previous = fs.readFileSync(`${filePath}.1`, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { at: number });
    expect(previous.at(-1)!.at).toBeLessThan(live[0]!.at);
  });

  it('appends every record exactly once across a rotation', () => {
    const filePath = ledgerPath();
    const writer = new RotatingJsonlWriter(filePath, { maxBytesPerFile: 400, maxFiles: 5 });
    for (let index = 0; index < 300; index += 1) writer.append({ at: index });

    const dir = path.dirname(filePath);
    const seen = fs.readdirSync(dir)
      .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n'))
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { at: number }).at);
    expect(new Set(seen).size).toBe(seen.length);
    // Nothing kept is out of order, and the newest record survived.
    expect(Math.max(...seen)).toBe(299);
  });

  it('picks up the size of a file it did not create', () => {
    const filePath = ledgerPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${'x'.repeat(600)}\n`, 'utf8');
    const writer = new RotatingJsonlWriter(filePath, { maxBytesPerFile: 512, maxFiles: 1 });

    writer.append({ at: 1 });
    // The pre-existing oversized file was rotated out rather than appended to.
    expect(fs.existsSync(`${filePath}.1`)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"at":1}\n');
  });

  it('never throws, whatever the disk or the record does', () => {
    const filePath = ledgerPath();
    const writer = new RotatingJsonlWriter(filePath, { maxBytesPerFile: 1_024, maxFiles: 1 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A record that cannot be serialised.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(writer.append(cyclic)).toBe(false);

    // A disk that refuses the write.
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    expect(writer.append({ at: 1 })).toBe(false);
    expect(writer.append({ at: 2 })).toBe(false);
    // Reported once per failure streak, not once per record.
    expect(consoleError).toHaveBeenCalledTimes(1);

    append.mockRestore();
    expect(writer.append({ at: 3 })).toBe(true);
  });

  it('truncates rather than growing when no generations are kept', () => {
    const filePath = ledgerPath();
    const writer = new RotatingJsonlWriter(filePath, { maxBytesPerFile: 128, maxFiles: 0 });
    for (let index = 0; index < 200; index += 1) writer.append({ at: index });

    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['bridge-telemetry.jsonl']);
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(128);
  });
});
