import { describe, expect, it } from 'vitest';
import { AuditLog, type AuditEntry } from './auditLog.js';

function appendMany(log: AuditLog, count: number, offset = 0) {
  for (let i = 0; i < count; i += 1) {
    log.append({ action: 'gate_block', detail: `entry-${offset + i}`, ok: false });
  }
}

function entriesFrom(count: number, offset = 0): AuditEntry[] {
  return Array.from({ length: count }, (_v, i) => ({
    t: offset + i,
    action: 'gate_block' as const,
    detail: `loaded-${offset + i}`,
    ok: false,
  }));
}

describe('AuditLog', () => {
  it('keeps the historical default cap of 5000 with no options', () => {
    const log = new AuditLog();
    appendMany(log, 5_002);

    const list = log.list();
    expect(list).toHaveLength(5_000);
    // Oldest-first eviction: entry-0 and entry-1 are gone, entry-2 is now first.
    expect(list[0].detail).toBe('entry-2');
    expect(list[list.length - 1].detail).toBe('entry-5001');
    expect(log.evictedCount()).toBe(2);
  });

  it('stamps t on append and exports one JSON object per line', () => {
    const log = new AuditLog();
    const before = Date.now();
    log.append({ action: 'paper_buy', ticker: 'KXBTCD-1', detail: 'filled', ok: true });
    const [entry] = log.list();

    expect(entry.t).toBeGreaterThanOrEqual(before);
    expect(entry.ticker).toBe('KXBTCD-1');

    log.append({ action: 'paper_close', detail: 'closed', ok: true });
    const lines = log.exportJsonl().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]) as AuditEntry).action).toBe('paper_close');
  });

  it('honours a custom cap', () => {
    const log = new AuditLog({ maxEntries: 3 });
    appendMany(log, 5);

    expect(log.list().map((e) => e.detail)).toEqual(['entry-2', 'entry-3', 'entry-4']);
    expect(log.evictedCount()).toBe(2);
  });

  it('falls back to the default cap for a non-positive or non-finite maxEntries', () => {
    for (const maxEntries of [0, -1, Number.NaN]) {
      const log = new AuditLog({ maxEntries });
      appendMany(log, 3);
      expect(log.list()).toHaveLength(3);
      expect(log.evictedCount()).toBe(0);
    }
  });

  it('passes evicted entries to onEvict in order, oldest first', () => {
    const evicted: AuditEntry[][] = [];
    const log = new AuditLog({ maxEntries: 2, onEvict: (batch) => { evicted.push(batch); } });
    appendMany(log, 4);

    // One batch per overflow, since append overflows one entry at a time.
    expect(evicted.map((batch) => batch.map((e) => e.detail))).toEqual([['entry-0'], ['entry-1']]);
    expect(log.list().map((e) => e.detail)).toEqual(['entry-2', 'entry-3']);
    expect(log.evictedCount()).toBe(2);
  });

  it('swallows a throwing onEvict but still evicts and counts', () => {
    const log = new AuditLog({
      maxEntries: 2,
      onEvict: () => { throw new Error('disk full'); },
    });

    expect(() => appendMany(log, 4)).not.toThrow();
    expect(log.list().map((e) => e.detail)).toEqual(['entry-2', 'entry-3']);
    expect(log.evictedCount()).toBe(2);

    // The log is still usable after a failed sink.
    log.append({ action: 'kill_switch', detail: 'armed', ok: true });
    expect(log.list()).toHaveLength(2);
    expect(log.list()[1].detail).toBe('armed');
  });

  it('evicts through onEvict when load() is over cap, as one batch', () => {
    const evicted: AuditEntry[][] = [];
    const log = new AuditLog({ maxEntries: 3, onEvict: (batch) => { evicted.push(batch); } });

    log.load(entriesFrom(6));

    expect(evicted).toHaveLength(1);
    expect(evicted[0].map((e) => e.detail)).toEqual(['loaded-0', 'loaded-1', 'loaded-2']);
    expect(log.list().map((e) => e.detail)).toEqual(['loaded-3', 'loaded-4', 'loaded-5']);
    expect(log.evictedCount()).toBe(3);
  });

  it('accumulates evictedCount across load and append', () => {
    const log = new AuditLog({ maxEntries: 2 });
    log.load(entriesFrom(5));
    expect(log.evictedCount()).toBe(3);

    appendMany(log, 2);
    expect(log.evictedCount()).toBe(5);
    expect(log.list()).toHaveLength(2);
  });

  it('does not alias the array handed to load()', () => {
    const log = new AuditLog();
    const source = entriesFrom(2);
    log.load(source);
    source.push(...entriesFrom(1, 99));

    expect(log.list()).toHaveLength(2);
  });

  it('leaves an under-cap load untouched and calls no sink', () => {
    let called = 0;
    const log = new AuditLog({ maxEntries: 10, onEvict: () => { called += 1; } });
    log.load(entriesFrom(4));

    expect(called).toBe(0);
    expect(log.list()).toHaveLength(4);
    expect(log.evictedCount()).toBe(0);
    // load() replaces, it does not merge.
    log.load(entriesFrom(1, 50));
    expect(log.list().map((e) => e.detail)).toEqual(['loaded-50']);
  });
});
