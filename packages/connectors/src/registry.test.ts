import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorRegistry } from './registry.js';

describe('ConnectorRegistry required REST lease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a 429 and Retry-After without discarding a still-fresh success lease', () => {
    const registry = new ConnectorRegistry();
    registry.recordSuccess('kalshi-rest', 25);
    vi.advanceTimersByTime(10_000);

    registry.recordError('kalshi-rest', 'Kalshi API 429', 'rate_limit', 12_000);

    expect(registry.get('kalshi-rest')).toMatchObject({
      status: 'warn',
      failureClass: 'rate_limit',
      qualificationReady: true,
      transportConnected: true,
      errorCount1h: 1,
      nextRetryAt: Date.now() + 12_000,
    });
    expect(registry.refreshFreshness('kalshi-rest', 30_000, Date.now() + 20_000)?.qualificationReady).toBe(true);
    expect(registry.refreshFreshness('kalshi-rest', 30_000, Date.now() + 20_001)?.qualificationReady).toBe(false);
  });

  it('aborts a hung REST health probe at its bounded timeout instead of blocking recovery', async () => {
    // Regression for the connection_reset that stalled kalshi-rest recovery to
    // ~69s and broke a G1 hold: the single-flight probe must not hang on a dead
    // socket, or every recovery tick is suppressed until the OS TCP timeout. The
    // probe passes a bounded AbortSignal, so a socket that never responds aborts
    // and frees the single flight. Uses real timers with a tiny timeout override.
    vi.useRealTimers();
    const registry = new ConnectorRegistry();
    let capturedSignal: AbortSignal | undefined;
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
      });
    }) as unknown as typeof fetch;

    await expect(registry.pingKalshiRest(hangingFetch, 20)).rejects.toThrow();

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
    expect(registry.get('kalshi-rest')?.qualificationReady).toBe(false);
  });

  it('absorbs a transient network fault while the success lease is still fresh', () => {
    // Regression for the aborted/timed-out kalshi-rest probe that de-qualified a
    // healthy feed and broke a G1 hold: a transient class (timeout, reset, abort,
    // server blip) must keep qualification while a recent success is within the
    // lease, and only de-qualify once staleness crosses it.
    const registry = new ConnectorRegistry();
    registry.recordSuccess('kalshi-rest', 25);
    vi.advanceTimersByTime(10_000);

    registry.recordError('kalshi-rest', 'The operation was aborted due to timeout', 'timeout');
    expect(registry.get('kalshi-rest')).toMatchObject({
      status: 'warn',
      failureClass: 'timeout',
      qualificationReady: true,
    });

    // Beyond the 30s success lease, the same transient class de-qualifies.
    vi.advanceTimersByTime(21_000);
    registry.recordError('kalshi-rest', 'connection reset by peer', 'connection_reset');
    expect(registry.get('kalshi-rest')).toMatchObject({
      status: 'error',
      qualificationReady: false,
    });
  });

  it('fails qualification immediately for hard authentication failures', () => {
    const registry = new ConnectorRegistry();
    registry.recordSuccess('kalshi-rest', 25);
    vi.advanceTimersByTime(1_000);

    registry.recordError('kalshi-rest', 'Kalshi API 401', 'authentication');

    expect(registry.get('kalshi-rest')).toMatchObject({
      status: 'error',
      failureClass: 'authentication',
      qualificationReady: false,
    });
  });
});
