import type { KalshiEnvironment } from '../types.js';

const RETRY_STAGGER_MS = 250;
const CIRCUIT_FAILURE_WINDOW_MS = 60_000;
const CIRCUIT_TRIP_THRESHOLD = 8;
const CIRCUIT_OPEN_MS = 30_000;
const CIRCUIT_HALF_OPEN_STAGGER_MS = 5_000;

export type KalshiCircuitState = 'closed' | 'open' | 'half_open';

export interface KalshiCircuitSnapshot {
  state: KalshiCircuitState;
  openUntil: number | null;
  failuresInWindow: number;
  trips: number;
  probeConsumer: string | null;
  lastFailureAt: number | null;
  lastFailureConsumer: string | null;
}

interface CircuitRecord {
  state: KalshiCircuitState;
  failureTimestamps: number[];
  openUntil: number;
  probeConsumer: string | null;
  probeReservedAt: number;
  trips: number;
  lastFailureAt: number | null;
  lastFailureConsumer: string | null;
}

const nextReservationByEnvironment = new Map<KalshiEnvironment, number>();
const circuitByEnvironment = new Map<KalshiEnvironment, CircuitRecord>();

function circuitFor(environment: KalshiEnvironment): CircuitRecord {
  let record = circuitByEnvironment.get(environment);
  if (!record) {
    record = {
      state: 'closed',
      failureTimestamps: [],
      openUntil: 0,
      probeConsumer: null,
      probeReservedAt: 0,
      trips: 0,
      lastFailureAt: null,
      lastFailureConsumer: null,
    };
    circuitByEnvironment.set(environment, record);
  }
  return record;
}

function pruneWindow(record: CircuitRecord, at: number): void {
  while (record.failureTimestamps.length > 0 && record.failureTimestamps[0]! <= at - CIRCUIT_FAILURE_WINDOW_MS) {
    record.failureTimestamps.shift();
  }
}

/**
 * Record one retryable (rotating-class) production transport failure. Sticky
 * credential failures (401/403/configuration) must never be recorded here:
 * they stop their consumer immediately and must not hold healthy transports.
 */
export function recordKalshiCircuitFailure(
  environment: KalshiEnvironment,
  consumer: string,
  at = Date.now(),
): void {
  const record = circuitFor(environment);
  pruneWindow(record, at);
  record.failureTimestamps.push(at);
  record.lastFailureAt = at;
  record.lastFailureConsumer = consumer;
  if (record.state === 'half_open') {
    record.state = 'open';
    record.openUntil = at + CIRCUIT_OPEN_MS;
    record.probeConsumer = null;
    record.trips += 1;
  } else if (record.state === 'closed' && record.failureTimestamps.length >= CIRCUIT_TRIP_THRESHOLD) {
    record.state = 'open';
    record.openUntil = at + CIRCUIT_OPEN_MS;
    record.trips += 1;
  }
}

/** Any real production success closes the breaker and clears the window. */
export function recordKalshiCircuitSuccess(environment: KalshiEnvironment): void {
  const record = circuitFor(environment);
  record.state = 'closed';
  record.failureTimestamps.length = 0;
  record.openUntil = 0;
  record.probeConsumer = null;
  record.probeReservedAt = 0;
}

export function kalshiProductionCircuitSnapshot(
  environment: KalshiEnvironment,
  at = Date.now(),
): KalshiCircuitSnapshot {
  const record = circuitFor(environment);
  pruneWindow(record, at);
  return {
    state: record.state,
    openUntil: record.state === 'open' ? record.openUntil : null,
    failuresInWindow: record.failureTimestamps.length,
    trips: record.trips,
    probeConsumer: record.probeConsumer,
    lastFailureAt: record.lastFailureAt,
    lastFailureConsumer: record.lastFailureConsumer,
  };
}

/**
 * Shared production retry reservation for REST and WebSocket transports. It
 * staggers retries without sharing credentials, requests, or response data.
 * While the shared circuit is open, reservations are floored at the open
 * window's end; the first reservation to cross it becomes the half-open
 * probe, and every other consumer is held behind the probe so one transport
 * tests the network before the rest redial together.
 */
export function reserveKalshiProductionRetry(
  environment: KalshiEnvironment,
  proposedAt: number,
  consumer = 'unattributed',
): number {
  const record = circuitFor(environment);
  let floor = proposedAt;
  let electedProbe = false;
  if (record.state === 'open') {
    floor = Math.max(floor, record.openUntil);
    record.state = 'half_open';
    record.probeConsumer = consumer;
    electedProbe = true;
  } else if (record.state === 'half_open' && consumer !== record.probeConsumer) {
    floor = Math.max(floor, record.probeReservedAt + CIRCUIT_HALF_OPEN_STAGGER_MS);
  }
  const previous = nextReservationByEnvironment.get(environment) ?? 0;
  const reservedAt = Math.max(floor, previous + RETRY_STAGGER_MS);
  nextReservationByEnvironment.set(environment, reservedAt);
  if (electedProbe) record.probeReservedAt = reservedAt;
  return reservedAt;
}

export function resetKalshiProductionRetryCoordinatorForTests(): void {
  nextReservationByEnvironment.clear();
  circuitByEnvironment.clear();
}
