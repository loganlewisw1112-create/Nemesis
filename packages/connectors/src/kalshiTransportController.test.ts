import { beforeEach, describe, expect, it } from 'vitest';
import {
  kalshiProductionCircuitSnapshot,
  recordKalshiCircuitFailure,
  resetKalshiProductionRetryCoordinatorForTests,
} from '@nemesis/core';
import {
  KalshiProductionConnectionController,
  classifyKalshiWebSocketClose,
  classifyKalshiWebSocketError,
  createKalshiTransportFailure,
} from './kalshiTransportController.js';

const endpoints = ['wss://primary.example/ws', 'wss://alias.example/ws'];

function controller(nowRef = { value: 1_700_000_000_000 }) {
  return new KalshiProductionConnectionController('production', endpoints, {
    now: () => nowRef.value,
    random: () => 0,
    coordinateRetries: false,
  });
}

describe('KalshiProductionConnectionController', () => {
  beforeEach(() => {
    resetKalshiProductionRetryCoordinatorForTests();
  });

  it.each([
    [Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'dns', true],
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'tcp', true],
    [Object.assign(new Error('TLS handshake failed'), { code: 'EPROTO' }), 'tls', true],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'connection_reset', true],
    [Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }), 'timeout', true],
    [Object.assign(new Error('server failed'), { statusCode: 503 }), 'http_5xx', true],
    [Object.assign(new Error('unauthorized'), { statusCode: 401 }), 'authentication', false],
    [Object.assign(new Error('forbidden'), { statusCode: 403 }), 'authorization', false],
    [Object.assign(new Error('too many requests'), { statusCode: 429 }), 'rate_limit', false],
    [new Error('invalid protocol frame'), 'protocol', false],
    [new SyntaxError("The URL's protocol must be one of 'ws:', 'wss:', or 'ws+unix:'"), 'configuration', false],
    [Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }), 'configuration', false],
  ])('classifies %s as %s', (error, classification, rotates) => {
    const failure = classifyKalshiWebSocketError(error);
    expect(failure).toMatchObject({ classification, rotateEndpoint: rotates });
  });

  it('treats configuration failures as sticky and non-retryable', () => {
    const failure = classifyKalshiWebSocketError(new SyntaxError("The URL's protocol must be one of 'ws:'"));
    expect(failure).toMatchObject({ classification: 'configuration', sticky: true, retryable: false });
  });

  it('rotates only retryable transport and abnormal-close failures', () => {
    const stream = controller();
    const first = stream.beginAttempt()!;
    const tlsDecision = stream.recordFailure(first.generation, createKalshiTransportFailure('tls', 'handshake reset'));
    expect(tlsDecision).toMatchObject({ retry: true, rotateEndpoint: true, delayMs: 1_000 });
    expect(stream.telemetry()).toMatchObject({
      activeEndpoint: null,
      failedEndpoint: endpoints[0],
      nextEndpoint: endpoints[1],
      failureClass: 'tls',
      switchReason: 'tls',
    });

    const second = stream.beginAttempt()!;
    const normalDecision = stream.recordFailure(second.generation, classifyKalshiWebSocketClose(1000, 'normal'));
    expect(normalDecision).toMatchObject({ retry: true, rotateEndpoint: false });
    expect(stream.telemetry().nextEndpoint).toBe(endpoints[1]);
  });

  it('keeps 429 on the same endpoint and stops on 401 or 403', () => {
    const now = { value: 1_700_000_100_000 };
    const rateLimited = controller(now);
    const first = rateLimited.beginAttempt()!;
    const decision = rateLimited.recordFailure(first.generation, createKalshiTransportFailure(
      'rate_limit', '429', { httpStatus: 429, retryAfterMs: 4_000 }, now.value,
    ));
    expect(decision).toMatchObject({ retry: true, rotateEndpoint: false, delayMs: 4_000 });
    expect(rateLimited.telemetry().nextEndpoint).toBe(endpoints[0]);

    for (const failureClass of ['authentication', 'authorization'] as const) {
      const blocked = controller({ value: now.value + 10_000 });
      const attempt = blocked.beginAttempt()!;
      expect(blocked.recordFailure(attempt.generation, createKalshiTransportFailure(failureClass, failureClass)))
        .toEqual({ retry: false, rotateEndpoint: false, delayMs: null, nextRetryAt: null });
      expect(blocked.telemetry().nextEndpoint).toBeNull();
    }
  });

  it('resets backoff only after ack, real pong, and exchange data', () => {
    const now = { value: 1_700_000_200_000 };
    const stream = controller(now);
    const first = stream.beginAttempt()!;
    expect(stream.recordFailure(first.generation, createKalshiTransportFailure('timeout', 'first')).delayMs).toBe(1_000);

    now.value += 10_000;
    const second = stream.beginAttempt()!;
    stream.recordSubscriptionAck(second.generation);
    stream.recordPong(second.generation);
    expect(stream.recordFailure(second.generation, createKalshiTransportFailure('timeout', 'second')).delayMs).toBe(2_000);

    now.value += 10_000;
    const third = stream.beginAttempt()!;
    stream.recordSubscriptionAck(third.generation);
    stream.recordPong(third.generation);
    stream.recordExchangeData(third.generation, now.value);
    expect(stream.qualificationReady(now.value)).toBe(true);
    expect(stream.recordFailure(third.generation, createKalshiTransportFailure('timeout', 'third')).delayMs).toBe(1_000);
  });

  it('revokes acknowledgement while another subscription batch is pending', () => {
    const now = { value: 1_700_000_250_000 };
    const stream = controller(now);
    const attempt = stream.beginAttempt()!;
    stream.recordSubscriptionAck(attempt.generation);
    stream.recordPong(attempt.generation);
    stream.recordExchangeData(attempt.generation, now.value);
    expect(stream.qualificationReady(now.value)).toBe(true);
    stream.recordSubscriptionPending(attempt.generation);
    expect(stream.qualificationReady(now.value)).toBe(false);
  });

  it('ignores stale generations and redacts sensitive detail', () => {
    const stream = controller();
    const first = stream.beginAttempt()!;
    const second = stream.beginAttempt()!;
    expect(stream.recordFailure(first.generation, createKalshiTransportFailure('timeout', 'stale')))
      .toEqual({ retry: false, rotateEndpoint: false, delayMs: null, nextRetryAt: null });
    expect(stream.telemetry().generation).toBe(second.generation);

    const failure = createKalshiTransportFailure('configuration', 'authorization=secret token:abc');
    expect(failure.detail).not.toContain('secret');
    expect(failure.detail).not.toContain('abc');
  });

  it('feeds the shared circuit breaker only on rotating failures when coordinating retries', () => {
    const now = { value: 1_700_000_300_000 };
    const stream = new KalshiProductionConnectionController('production', endpoints, {
      now: () => now.value,
      random: () => 0,
      coordinateRetries: true,
    });
    const attempt = stream.beginAttempt()!;
    stream.recordFailure(attempt.generation, createKalshiTransportFailure('tls', 'reset', {}, now.value));
    expect(kalshiProductionCircuitSnapshot('production', now.value).failuresInWindow).toBe(1);

    const second = stream.beginAttempt()!;
    stream.recordFailure(second.generation, createKalshiTransportFailure('rate_limit', '429', {}, now.value));
    expect(kalshiProductionCircuitSnapshot('production', now.value).failuresInWindow).toBe(1);
  });

  it('returns sticky no-retry immediately and records nothing while the breaker is open', () => {
    const now = { value: 1_700_000_400_000 };
    for (let i = 0; i < 8; i++) recordKalshiCircuitFailure('production', 'kalshi-rest', now.value + i);
    expect(kalshiProductionCircuitSnapshot('production', now.value + 10).state).toBe('open');

    const stream = new KalshiProductionConnectionController('production', endpoints, {
      now: () => now.value,
      random: () => 0,
      coordinateRetries: true,
    });
    const attempt = stream.beginAttempt()!;
    const decision = stream.recordFailure(attempt.generation, createKalshiTransportFailure('authentication', '401', {}, now.value));
    expect(decision).toEqual({ retry: false, rotateEndpoint: false, delayMs: null, nextRetryAt: null });
    const snapshot = kalshiProductionCircuitSnapshot('production', now.value + 10);
    expect(snapshot.state).toBe('open');
    expect(snapshot.failuresInWindow).toBe(8);
  });
});
