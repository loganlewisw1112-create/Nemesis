import { afterEach, describe, expect, it } from 'vitest';
import { TraceWriter, createTraceWriter } from './orderbookTrace.js';

interface CapturedLine {
  path: string;
  line: string;
}

function capture(): { lines: CapturedLine[]; appendLine: (path: string, line: string) => void } {
  const lines: CapturedLine[] = [];
  return { lines, appendLine: (path, line) => { lines.push({ path, line }); } };
}

const baseRecord = {
  socketState: 'open',
  reconnectScheduled: false,
  trackedTickers: 25,
  sequenceGaps: 0,
};

describe('TraceWriter', () => {
  it('is disabled and records nothing when no path is configured', () => {
    const { lines, appendLine } = capture();
    for (const path of [undefined, null, '', '   ']) {
      const writer = new TraceWriter({ path, appendLine });
      expect(writer.enabled).toBe(false);
      expect(writer.record({ ...baseRecord }, 1_000)).toBe(false);
      // A disabled writer is a pure no-op: it must not even accrue skips.
      expect(writer.stats()).toEqual({ written: 0, skipped: 0, failed: 0, lastWriteAt: null });
    }
    expect(lines).toHaveLength(0);
  });

  it('always writes the first record', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine });

    expect(writer.enabled).toBe(true);
    expect(writer.record({ ...baseRecord }, 1_000)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0].path).toBe('trace.jsonl');
    expect(writer.stats()).toEqual({ written: 1, skipped: 0, failed: 0, lastWriteAt: 1_000 });
  });

  it('skips an identical record inside the dedupe window', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine, dedupeWindowMs: 30_000 });

    expect(writer.record({ ...baseRecord }, 1_000)).toBe(true);
    expect(writer.record({ ...baseRecord }, 6_000)).toBe(false);
    expect(writer.record({ ...baseRecord }, 30_999)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(writer.stats()).toMatchObject({ written: 1, skipped: 2, failed: 0 });
  });

  it('writes immediately when a non-volatile field changes', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine, dedupeWindowMs: 30_000 });

    expect(writer.record({ ...baseRecord }, 1_000)).toBe(true);
    // The exact transition the 8-hour run never recorded.
    expect(writer.record({ ...baseRecord, socketState: 'none', reconnectScheduled: false }, 1_500)).toBe(true);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1].line)).toMatchObject({ socketState: 'none', at: 1_500 });
    expect(writer.stats()).toMatchObject({ written: 2, skipped: 0, lastWriteAt: 1_500 });
  });

  it('treats nested field changes as changes', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine, dedupeWindowMs: 30_000 });

    writer.record({ ...baseRecord, failureCounters: { auth: 0, timeout: 1 } }, 1_000);
    expect(writer.record({ ...baseRecord, failureCounters: { auth: 0, timeout: 2 } }, 1_100)).toBe(true);
    // Key order alone is not a change.
    expect(writer.record({ ...baseRecord, failureCounters: { timeout: 2, auth: 0 } }, 1_200)).toBe(false);
    expect(lines).toHaveLength(2);
  });

  it('skips a record whose only change is at/*AgeMs until the window elapses, then writes once', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine, dedupeWindowMs: 30_000 });

    expect(writer.record({ ...baseRecord, at: 1_000, lastSequencedDeltaAgeMs: 10, uptimeMs: 10 }, 1_000)).toBe(true);
    expect(writer.record({ ...baseRecord, at: 20_000, lastSequencedDeltaAgeMs: 19_010, uptimeMs: 19_010 }, 20_000)).toBe(false);
    expect(writer.record({ ...baseRecord, at: 31_000, lastSequencedDeltaAgeMs: 30_010, uptimeMs: 30_010 }, 31_000)).toBe(true);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1].line)).toMatchObject({ at: 31_000, lastSequencedDeltaAgeMs: 30_010 });
    expect(writer.stats()).toMatchObject({ written: 2, skipped: 1, failed: 0, lastWriteAt: 31_000 });
  });

  it('honours an explicit volatileFields list instead of the default suffix rule', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine, dedupeWindowMs: 30_000, volatileFields: ['at'] });

    writer.record({ at: 1_000, socketState: 'open', lastSequencedDeltaAgeMs: 10 }, 1_000);
    // '*AgeMs' is no longer volatile under an explicit list, so this is a change.
    expect(writer.record({ at: 2_000, socketState: 'open', lastSequencedDeltaAgeMs: 1_010 }, 2_000)).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('swallows and counts a throwing appendLine, and retries the same state next tick', () => {
    const lines: string[] = [];
    let fail = true;
    const writer = new TraceWriter({
      path: 'trace.jsonl',
      dedupeWindowMs: 30_000,
      appendLine: (_path, line) => {
        if (fail) throw new Error('EACCES');
        lines.push(line);
      },
    });

    expect(() => writer.record({ ...baseRecord }, 1_000)).not.toThrow();
    expect(writer.stats()).toMatchObject({ written: 0, skipped: 0, failed: 1, lastWriteAt: null });

    fail = false;
    // A failed write must not have been recorded as the last state, so the very
    // same (unchanged) record still writes on the next attempt.
    expect(writer.record({ ...baseRecord }, 1_100)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(writer.stats()).toMatchObject({ written: 1, failed: 1, lastWriteAt: 1_100 });
  });

  it('counts an unserializable payload as failed without throwing', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine });
    const cyclic: Record<string, unknown> = { socketState: 'open' };
    cyclic.self = cyclic;

    expect(() => writer.record(cyclic, 1_000)).not.toThrow();
    expect(writer.record(cyclic, 1_000)).toBe(false);
    expect(lines).toHaveLength(0);
    expect(writer.stats()).toMatchObject({ written: 0, failed: 2 });
  });

  it('emits exactly one newline-terminated JSON line per record', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine, dedupeWindowMs: 0 });

    writer.record({ ...baseRecord }, 1_000);
    writer.record({ ...baseRecord }, 2_000);

    expect(lines).toHaveLength(2);
    for (const { line } of lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.split('\n')).toHaveLength(2);
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    // A zero window means every tick writes; nothing is ever dropped.
    expect(writer.stats()).toMatchObject({ written: 2, skipped: 0, failed: 0 });
  });

  it('preserves a caller-supplied at and stamps one when absent', () => {
    const { lines, appendLine } = capture();
    const writer = new TraceWriter({ path: 'trace.jsonl', appendLine, dedupeWindowMs: 0 });

    writer.record({ ...baseRecord, at: 42 }, 1_000);
    writer.record({ ...baseRecord }, 2_000);

    expect(JSON.parse(lines[0].line)).toMatchObject({ at: 42 });
    expect(JSON.parse(lines[1].line)).toMatchObject({ at: 2_000 });
  });
});

describe('createTraceWriter', () => {
  const ENV_VAR = 'NEMESIS_ORDERBOOK_TRACE_PATH_TEST';

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('is disabled when the env var is unset', () => {
    const writer = createTraceWriter(ENV_VAR);
    expect(writer.enabled).toBe(false);
    expect(writer.record({ ...baseRecord })).toBe(false);
  });

  it('binds to the env var path when set', () => {
    process.env[ENV_VAR] = 'orderbook-trace.jsonl';
    const { lines, appendLine } = capture();
    const writer = createTraceWriter(ENV_VAR, { appendLine });

    expect(writer.enabled).toBe(true);
    expect(writer.record({ ...baseRecord }, 1_000)).toBe(true);
    expect(lines[0].path).toBe('orderbook-trace.jsonl');
  });
});
