import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionedStateStream, type StateEnvelopeV2 } from './stateStreamCoalescer.js';

interface Row { id: string; value: number }

describe('VersionedStateStream', () => {
  afterEach(() => vi.useRealTimers());

  it('sends one full snapshot followed by monotonic keyed deltas', async () => {
    const sent: StateEnvelopeV2<Row>[] = [];
    const stream = new VersionedStateStream<Row>('markets', (row) => row.id, (envelope) => { sent.push(envelope); });
    stream.replace([{ id: 'a', value: 1 }, { id: 'b', value: 2 }], 1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    stream.update([{ id: 'a', value: 3 }], ['b'], 2);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toMatchObject({ revision: 1, full: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }] });
    expect(sent[1]).toMatchObject({ revision: 2, upserts: [{ id: 'a', value: 3 }], removals: ['b'] });
  });

  it('bounds 10,000 updates to one in-flight and one replaceable pending state', async () => {
    let release!: () => void;
    const firstSend = new Promise<void>((resolve) => { release = resolve; });
    const sent: StateEnvelopeV2<Row>[] = [];
    const stream = new VersionedStateStream<Row>('markets', (row) => row.id, (envelope) => {
      sent.push(envelope);
      return sent.length === 1 ? firstSend : undefined;
    });
    stream.replace([{ id: 'a', value: 0 }], 1);
    for (let value = 1; value <= 10_000; value += 1) stream.update([{ id: 'a', value }], [], value + 1);
    expect(stream.stats()).toMatchObject({ inFlight: 1, pending: 1, sent: 0 });
    release();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.upserts).toEqual([{ id: 'a', value: 10_000 }]);
    expect(sent.map((envelope) => envelope.revision)).toEqual([1, 2]);
    await vi.waitFor(() => expect(stream.stats()).toMatchObject({
      revision: 2,
      itemCount: 1,
      inFlight: 0,
      pending: 0,
      sent: 2,
    }));
  });

  it('retries from delivered state after a send failure without losing the latest state', async () => {
    const sent: StateEnvelopeV2<Row>[] = [];
    let fail = true;
    const stream = new VersionedStateStream<Row>('paper', (row) => row.id, (envelope) => {
      sent.push(envelope);
      if (fail) {
        fail = false;
        return Promise.reject(new Error('ipc closed'));
      }
      return undefined;
    });
    stream.replace([{ id: 'p', value: 7 }], 1);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.full).toEqual([{ id: 'p', value: 7 }]);
    expect(stream.stats()).toMatchObject({ failed: 1, sent: 1, pending: 0 });
  });

  it('cancels pending timers, releases retained state, and never delivers after stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: StateEnvelopeV2<Row>[] = [];
    const stream = new VersionedStateStream<Row>(
      'world',
      (row) => row.id,
      (envelope) => { sent.push(envelope); },
      1_000,
    );

    stream.replace([{ id: 'a', value: 1 }], 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);

    stream.update([{ id: 'a', value: 2 }], [], 0);
    expect(vi.getTimerCount()).toBe(1);
    stream.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(stream.stats()).toMatchObject({ itemCount: 0, inFlight: 0, pending: 0 });

    stream.update([{ id: 'a', value: 3 }], [], 2_000);
    stream.replace([{ id: 'b', value: 4 }], 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);
    expect(stream.stats()).toMatchObject({ itemCount: 0, pending: 0, sent: 1 });
  });
});
