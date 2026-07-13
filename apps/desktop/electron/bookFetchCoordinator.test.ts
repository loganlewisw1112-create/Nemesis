import { describe, expect, it } from 'vitest';
import {
  BookFetchBackoffError,
  BookFetchCoordinator,
  classifyBookFetchFailure,
} from './bookFetchCoordinator.js';

describe('BookFetchCoordinator', () => {
  it('coalesces concurrent fetches for the same ticker', async () => {
    let release: ((value: string) => void) | undefined;
    let runs = 0;
    const coordinator = new BookFetchCoordinator(
      async () => {
        runs += 1;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      { successTtlMs: 600 },
    );

    const first = coordinator.fetch('TICKER', { allowCachedSuccess: false });
    const second = coordinator.fetch('TICKER', { allowCachedSuccess: false });
    await Promise.resolve();

    expect(runs).toBe(1);
    release?.('book');
    await expect(Promise.all([first, second])).resolves.toEqual(['book', 'book']);
  });

  it('keeps concurrent fetches isolated by ticker', async () => {
    const runs: string[] = [];
    const coordinator = new BookFetchCoordinator(
      async (ticker) => {
        runs.push(ticker);
        return `book-${ticker}`;
      },
      { successTtlMs: 600 },
    );

    await expect(Promise.all([
      coordinator.fetch('FIRST', { allowCachedSuccess: false }),
      coordinator.fetch('SECOND', { allowCachedSuccess: false }),
    ])).resolves.toEqual(['book-FIRST', 'book-SECOND']);
    expect(runs).toEqual(['FIRST', 'SECOND']);
  });

  it('serves a successful fetch from the short-lived cache', async () => {
    let now = 1_000;
    let runs = 0;
    const coordinator = new BookFetchCoordinator(
      async () => {
        runs += 1;
        return `book-${runs}`;
      },
      { successTtlMs: 600, now: () => now },
    );

    await expect(coordinator.fetch('TICKER')).resolves.toBe('book-1');
    await expect(coordinator.fetch('TICKER')).resolves.toBe('book-1');
    expect(coordinator.peek('TICKER')).toBe('book-1');
    expect(runs).toBe(1);

    now += 601;
    expect(coordinator.peek('TICKER')).toBeNull();
    await expect(coordinator.fetch('TICKER')).resolves.toBe('book-2');
    expect(runs).toBe(2);
  });

  it('backs off repeated no-depth failures exponentially', async () => {
    let now = 0;
    let runs = 0;
    const coordinator = new BookFetchCoordinator(
      async () => {
        runs += 1;
        throw new Error('book unavailable: no executable depth');
      },
      { successTtlMs: 600, now: () => now },
    );

    await expect(coordinator.fetch('EMPTY')).rejects.toThrow('no executable depth');
    expect(runs).toBe(1);

    const firstBackoff = await coordinator.fetch('EMPTY').catch((error: unknown) => error);
    expect(firstBackoff).toBeInstanceOf(BookFetchBackoffError);
    expect(firstBackoff).toMatchObject({
      kind: 'no-depth',
      failureCount: 1,
      retryAt: 15_000,
    });
    expect(runs).toBe(1);

    now = 15_000;
    await expect(coordinator.fetch('EMPTY')).rejects.toThrow('no executable depth');
    expect(runs).toBe(2);

    const secondBackoff = await coordinator.fetch('EMPTY').catch((error: unknown) => error);
    expect(secondBackoff).toMatchObject({
      kind: 'no-depth',
      failureCount: 2,
      retryAt: 45_000,
    });
    expect(runs).toBe(2);
  });

  it('uses a longer initial backoff for rate limits', async () => {
    let runs = 0;
    const coordinator = new BookFetchCoordinator(
      async () => {
        runs += 1;
        throw new Error('Kalshi API 429: Too Many Requests');
      },
      { successTtlMs: 600, now: () => 5_000 },
    );

    await expect(coordinator.fetch('LIMITED')).rejects.toThrow('429');
    const backoff = await coordinator.fetch('LIMITED').catch((error: unknown) => error);
    expect(backoff).toMatchObject({
      kind: 'rate-limit',
      failureCount: 1,
      retryAt: 35_000,
    });
    expect(runs).toBe(1);
  });

  it('clears prior failure history after a successful retry', async () => {
    let now = 0;
    let runs = 0;
    const coordinator = new BookFetchCoordinator(
      async () => {
        runs += 1;
        if (runs === 1 || runs === 3) throw new Error('book unavailable: no executable depth');
        return 'book';
      },
      { successTtlMs: 600, now: () => now },
    );

    await expect(coordinator.fetch('RECOVER')).rejects.toThrow('no executable depth');
    now = 15_000;
    await expect(coordinator.fetch('RECOVER')).resolves.toBe('book');
    await expect(coordinator.fetch('RECOVER', { allowCachedSuccess: false })).rejects.toThrow('no executable depth');

    const backoff = await coordinator.fetch('RECOVER').catch((error: unknown) => error);
    expect(backoff).toMatchObject({
      kind: 'no-depth',
      failureCount: 1,
      retryAt: 30_000,
    });
    expect(runs).toBe(3);
  });
});

describe('classifyBookFetchFailure', () => {
  it('classifies transient transport failures without treating them as no-depth', () => {
    expect(classifyBookFetchFailure(new Error('fetch failed'))).toBe('transient');
    expect(classifyBookFetchFailure(new Error('request aborted'))).toBe('transient');
    expect(classifyBookFetchFailure(new Error('unexpected response'))).toBe('other');
  });
});
