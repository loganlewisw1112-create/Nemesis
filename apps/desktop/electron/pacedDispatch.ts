export interface PacedDispatchOptions {
  /** Minimum delay between successive dispatch starts. */
  gapMs: number;
  /** Maximum number of workers allowed in flight at once. */
  maxConcurrency: number;
  /** Injectable delay, primarily for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `worker(item)` for every item while spreading the dispatches out instead
 * of bursting them: successive starts are separated by at least `gapMs` and no
 * more than `maxConcurrency` workers run concurrently. This keeps a batch of
 * outbound REST calls under an upstream rate limit — a burst of 25 concurrent
 * market re-verifications reliably drew Kalshi 429s, which then stranded markets
 * past their provenance TTL and decayed the tracked orderbook set below 25.
 *
 * A worker rejection is swallowed per item so one failure never aborts the
 * remaining dispatches; callers are expected to record their own failures.
 */
export async function pacedDispatch<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  options: PacedDispatchOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const gapMs = Math.max(0, options.gapMs);
  const maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
  const inFlight = new Set<Promise<void>>();

  for (let index = 0; index < items.length; index += 1) {
    const task = Promise.resolve(worker(items[index]))
      .catch(() => undefined)
      .finally(() => { inFlight.delete(task); });
    inFlight.add(task);

    if (inFlight.size >= maxConcurrency) {
      await Promise.race(inFlight);
    }
    if (gapMs > 0 && index < items.length - 1) {
      await sleep(gapMs);
    }
  }

  await Promise.all(inFlight);
}
