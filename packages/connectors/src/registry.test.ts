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
