import { describe, expect, it } from 'vitest';
import { createLatencyMetrics, measureExchangeRoundTrip, isExchangePathAcceptable } from './exchangeLatency.js';

describe('exchange latency instrumentation', () => {
  it('measures exchange submit and fill round trips separately', async () => {
    let now = 10;
    const measured = await measureExchangeRoundTrip({
      now: () => now,
      send: async () => {
        now += 7;
        return { orderId: 'abc', fillConfirmedAt: now + 11 };
      },
    });

    expect(measured.result.orderId).toBe('abc');
    expect(measured.metrics.orderSubmitRttMs).toBe(7);
    expect(measured.metrics.fillConfirmMs).toBe(18);
  });

  it('rejects exchange paths slower than the configured RTT budget', () => {
    const metrics = createLatencyMetrics({ orderSubmitRttMs: 75, fillConfirmMs: 120 });

    expect(isExchangePathAcceptable(metrics, { maxSubmitRttMs: 50, maxFillConfirmMs: 150 })).toEqual({
      ok: false,
      reason: 'slow exchange path',
    });
  });
});
