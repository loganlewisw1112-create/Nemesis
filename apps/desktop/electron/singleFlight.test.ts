import { describe, expect, it } from 'vitest';
import { createSingleFlight } from './singleFlight.js';

describe('createSingleFlight', () => {
  it('shares an in-flight run instead of starting duplicate work', async () => {
    let release: (() => void) | undefined;
    let runs = 0;
    const run = createSingleFlight(async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return runs;
    });

    const first = run();
    const second = run();

    expect(runs).toBe(1);
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
  });

  it('allows a new run after the prior run settles', async () => {
    let runs = 0;
    const run = createSingleFlight(async () => {
      runs += 1;
      return runs;
    });

    await expect(run()).resolves.toBe(1);
    await expect(run()).resolves.toBe(2);
  });
});
