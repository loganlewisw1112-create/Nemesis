import { describe, expect, it } from 'vitest';
import { dedupeByExecutionKey, ExecutionReservation } from './executionConcurrency.js';

interface Candidate {
  ticker: string;
  side: 'yes' | 'no';
  rank: number;
}

const executionKey = (candidate: Candidate) => `${candidate.ticker}:${candidate.side}`;

describe('dedupeByExecutionKey', () => {
  it('keeps the first and highest-ranked candidate for an execution key', () => {
    const ranked: Candidate[] = [
      { ticker: 'KENSHE', side: 'yes', rank: 1 },
      { ticker: 'KENSHE', side: 'yes', rank: 2 },
    ];

    expect(dedupeByExecutionKey(ranked, executionKey)).toEqual([ranked[0]]);
  });

  it('allows the same ticker on the opposite side', () => {
    const candidates: Candidate[] = [
      { ticker: 'KENSHE', side: 'yes', rank: 1 },
      { ticker: 'KENSHE', side: 'no', rank: 2 },
    ];

    expect(dedupeByExecutionKey(candidates, executionKey)).toEqual(candidates);
  });

  it('allows different tickers', () => {
    const candidates: Candidate[] = [
      { ticker: 'KENSHE', side: 'yes', rank: 1 },
      { ticker: 'BOUZHA', side: 'yes', rank: 2 },
    ];

    expect(dedupeByExecutionKey(candidates, executionKey)).toEqual(candidates);
  });
});

describe('ExecutionReservation', () => {
  it('permits only one in-flight reservation for an identical key', () => {
    const reservations = new ExecutionReservation();

    expect(reservations.tryAcquire('KENSHE:yes')).toBeTypeOf('function');
    expect(reservations.tryAcquire('KENSHE:yes')).toBeNull();
    expect(reservations.isReserved('KENSHE:yes')).toBe(true);
  });

  it('permits a later execution after release', () => {
    const reservations = new ExecutionReservation();
    const release = reservations.tryAcquire('KENSHE:yes');

    release?.();

    expect(reservations.isReserved('KENSHE:yes')).toBe(false);
    expect(reservations.tryAcquire('KENSHE:yes')).toBeTypeOf('function');
  });

  it('does not let a stale release clear a newer reservation', () => {
    const reservations = new ExecutionReservation();
    const staleRelease = reservations.tryAcquire('KENSHE:yes');
    staleRelease?.();
    const currentRelease = reservations.tryAcquire('KENSHE:yes');

    staleRelease?.();

    expect(currentRelease).toBeTypeOf('function');
    expect(reservations.isReserved('KENSHE:yes')).toBe(true);
  });
});
