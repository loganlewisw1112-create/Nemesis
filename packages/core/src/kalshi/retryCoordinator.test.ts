import { beforeEach, describe, expect, it } from 'vitest';
import {
  kalshiProductionCircuitSnapshot,
  recordKalshiCircuitFailure,
  recordKalshiCircuitSuccess,
  reserveKalshiProductionRetry,
  resetKalshiProductionRetryCoordinatorForTests,
} from './retryCoordinator.js';

const T0 = 1_700_000_000_000;

function tripBreaker(at = T0, consumer = 'kalshi-ticker'): void {
  for (let i = 0; i < 8; i++) recordKalshiCircuitFailure('production', consumer, at + i);
}

describe('Kalshi production circuit breaker', () => {
  beforeEach(() => {
    resetKalshiProductionRetryCoordinatorForTests();
  });

  it('stays closed and does not hold reservations below the trip threshold', () => {
    for (let i = 0; i < 7; i++) recordKalshiCircuitFailure('production', 'kalshi-ticker', T0 + i);
    expect(kalshiProductionCircuitSnapshot('production', T0 + 10).state).toBe('closed');
    expect(reserveKalshiProductionRetry('production', T0 + 1_000, 'kalshi-rest')).toBe(T0 + 1_000);
  });

  it('opens after the threshold and floors reservations at the open window end', () => {
    tripBreaker();
    const snapshot = kalshiProductionCircuitSnapshot('production', T0 + 10);
    expect(snapshot.state).toBe('open');
    expect(snapshot.trips).toBe(1);
    expect(snapshot.openUntil).toBe(T0 + 7 + 30_000);
    const reserved = reserveKalshiProductionRetry('production', T0 + 1_000, 'kalshi-rest');
    expect(reserved).toBeGreaterThanOrEqual(T0 + 7 + 30_000);
  });

  it('prunes failures outside the sixty second window', () => {
    for (let i = 0; i < 7; i++) recordKalshiCircuitFailure('production', 'kalshi-ticker', T0 + i);
    recordKalshiCircuitFailure('production', 'kalshi-ticker', T0 + 61_000);
    const snapshot = kalshiProductionCircuitSnapshot('production', T0 + 61_001);
    expect(snapshot.state).toBe('closed');
    expect(snapshot.failuresInWindow).toBe(1);
  });

  it('elects the first crossing reservation as the half-open probe and holds other consumers behind it', () => {
    tripBreaker();
    const probe = reserveKalshiProductionRetry('production', T0 + 100, 'kalshi-ticker');
    const held = reserveKalshiProductionRetry('production', T0 + 100, 'kalshi-orderbook-ws');
    const snapshot = kalshiProductionCircuitSnapshot('production', T0 + 200);
    expect(snapshot.state).toBe('half_open');
    expect(snapshot.probeConsumer).toBe('kalshi-ticker');
    expect(held).toBeGreaterThanOrEqual(probe + 5_000);
  });

  it('lets the probe consumer keep normal stagger during half-open', () => {
    tripBreaker();
    const probe = reserveKalshiProductionRetry('production', T0 + 100, 'kalshi-ticker');
    const probeAgain = reserveKalshiProductionRetry('production', probe + 1, 'kalshi-ticker');
    expect(probeAgain).toBe(probe + 250);
  });

  it('closes on success and restores normal stagger', () => {
    tripBreaker();
    reserveKalshiProductionRetry('production', T0 + 100, 'kalshi-ticker');
    recordKalshiCircuitSuccess('production');
    const snapshot = kalshiProductionCircuitSnapshot('production', T0 + 200);
    expect(snapshot.state).toBe('closed');
    expect(snapshot.failuresInWindow).toBe(0);
    const later = T0 + 120_000;
    expect(reserveKalshiProductionRetry('production', later, 'kalshi-rest')).toBe(later);
  });

  it('re-opens when the half-open probe fails', () => {
    tripBreaker();
    reserveKalshiProductionRetry('production', T0 + 100, 'kalshi-ticker');
    recordKalshiCircuitFailure('production', 'kalshi-ticker', T0 + 40_000);
    const snapshot = kalshiProductionCircuitSnapshot('production', T0 + 40_001);
    expect(snapshot.state).toBe('open');
    expect(snapshot.trips).toBe(2);
    expect(snapshot.openUntil).toBe(T0 + 40_000 + 30_000);
  });

  it('isolates environments from each other', () => {
    tripBreaker();
    expect(kalshiProductionCircuitSnapshot('production', T0 + 10).state).toBe('open');
    expect(kalshiProductionCircuitSnapshot('demo', T0 + 10).state).toBe('closed');
    expect(reserveKalshiProductionRetry('demo', T0 + 1_000, 'kalshi-rest')).toBe(T0 + 1_000);
  });

  it('clears breaker state through the test reset helper', () => {
    tripBreaker();
    resetKalshiProductionRetryCoordinatorForTests();
    const snapshot = kalshiProductionCircuitSnapshot('production', T0 + 10);
    expect(snapshot.state).toBe('closed');
    expect(snapshot.trips).toBe(0);
    expect(snapshot.failuresInWindow).toBe(0);
  });
});
