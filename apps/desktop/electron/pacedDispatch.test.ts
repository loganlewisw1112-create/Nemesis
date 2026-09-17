import { describe, expect, it } from 'vitest';
import { pacedDispatch } from './pacedDispatch.js';

const noopSleep = async () => {};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('pacedDispatch', () => {
  it('processes every item', async () => {
    const seen: number[] = [];
    await pacedDispatch([1, 2, 3, 4, 5], async (n) => { seen.push(n); }, {
      gapMs: 0,
      maxConcurrency: 2,
      sleep: noopSleep,
    });
    expect(seen.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('spaces successive dispatches by gapMs and never after the last item', async () => {
    const sleeps: number[] = [];
    await pacedDispatch(['a', 'b', 'c'], async () => {}, {
      gapMs: 500,
      maxConcurrency: 3,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    // n-1 gaps: the batch is spread out, not burst, and no trailing wait.
    expect(sleeps).toEqual([500, 500]);
  });

  it('never exceeds maxConcurrency in flight', async () => {
    let current = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const worker = async () => {
      current += 1;
      peak = Math.max(peak, current);
      await new Promise<void>((resolve) => { gates.push(resolve); });
      current -= 1;
    };

    const items = [0, 1, 2, 3, 4, 5];
    const done = pacedDispatch(items, worker, { gapMs: 0, maxConcurrency: 2, sleep: noopSleep });

    for (let i = 0; i < items.length + 2; i += 1) {
      await tick();
      expect(current).toBeLessThanOrEqual(2);
      gates.shift()?.();
    }

    await done;
    expect(peak).toBe(2);
  });

  it('continues past a rejecting worker so one failure never aborts the sweep', async () => {
    const seen: number[] = [];
    await pacedDispatch([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      seen.push(n);
    }, { gapMs: 0, maxConcurrency: 1, sleep: noopSleep });
    expect(seen).toEqual([1, 3]);
  });

  it('handles an empty item list without dispatching or sleeping', async () => {
    let sleeps = 0;
    let workerCalls = 0;
    await pacedDispatch([], async () => { workerCalls += 1; }, {
      gapMs: 500,
      maxConcurrency: 3,
      sleep: async () => { sleeps += 1; },
    });
    expect(workerCalls).toBe(0);
    expect(sleeps).toBe(0);
  });
});
