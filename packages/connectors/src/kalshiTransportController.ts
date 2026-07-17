import {
  recordKalshiCircuitFailure,
  recordKalshiCircuitSuccess,
  reserveKalshiProductionRetry,
  type KalshiEnvironment,
} from '@nemesis/core';

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;

export type KalshiTransportFailureClass =
  | 'dns'
  | 'tcp'
  | 'tls'
  | 'connection_reset'
  | 'timeout'
  | 'http_5xx'
  | 'abnormal_close'
  | 'normal_close'
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'protocol'
  | 'sequence'
  | 'local_stop'
  | 'configuration'
  | 'unknown';

export interface KalshiTransportFailure {
  classification: KalshiTransportFailureClass;
  occurredAt: number;
  detail: string;
  code: string | null;
  httpStatus: number | null;
  closeCode: number | null;
  closeReason: string | null;
  retryAfterMs: number | null;
  retryable: boolean;
  rotateEndpoint: boolean;
  sticky: boolean;
}

export interface KalshiTransportTelemetry {
  environment: KalshiEnvironment;
  generation: number;
  attemptId: string | null;
  activeEndpoint: string | null;
  failedEndpoint: string | null;
  nextEndpoint: string | null;
  failureClass: KalshiTransportFailureClass | null;
  errorCode: string | null;
  httpStatus: number | null;
  nextRetryAt: number | null;
  switchReason: string | null;
  subscriptionAcknowledged: boolean;
  pongReceived: boolean;
  exchangeDataReceived: boolean;
  lastExchangeDataAt: number | null;
  counters: Readonly<Record<KalshiTransportFailureClass, number>>;
}

/**
 * Shared socket-health evidence shape emitted by both authenticated Kalshi
 * stream telemetries. The stream telemetry interfaces extend this, so the
 * type checker proves every emitted telemetry record is a valid V2 record.
 */
export interface KalshiSocketHealthV2 {
  connected: boolean;
  authenticated: boolean;
  qualificationReady: boolean;
  environment: KalshiEnvironment;
  generation: number;
  attemptId: string | null;
  endpointUrl: string | null;
  activeEndpoint: string | null;
  failedEndpoint: string | null;
  nextEndpoint: string | null;
  failureClass: KalshiTransportFailureClass | null;
  errorCode: string | null;
  httpStatus: number | null;
  nextRetryAt: number | null;
  switchReason: string | null;
  subscriptionAcknowledged: boolean;
  lastMessageAt: number | null;
  lastPongAt: number | null;
  lastExchangeTimestamp: number | null;
  lastExchangeDataAt: number | null;
  failureCounters: Readonly<Record<KalshiTransportFailureClass, number>>;
}

export interface KalshiConnectionAttempt {
  generation: number;
  attemptId: string;
  endpoint: string;
}

export interface KalshiRetryDecision {
  retry: boolean;
  rotateEndpoint: boolean;
  delayMs: number | null;
  nextRetryAt: number | null;
}

interface TransportControllerOptions {
  now?: () => number;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  attemptPrefix?: string;
  coordinateRetries?: boolean;
}

const rotatingFailures = new Set<KalshiTransportFailureClass>([
  'dns',
  'tcp',
  'tls',
  'connection_reset',
  'timeout',
  'http_5xx',
  'abnormal_close',
]);

const retryingSameEndpointFailures = new Set<KalshiTransportFailureClass>([
  'normal_close',
  'rate_limit',
  'protocol',
  'sequence',
]);

const stickyFailures = new Set<KalshiTransportFailureClass>([
  'authentication',
  'authorization',
  'configuration',
]);


export class KalshiProductionConnectionController {
  private endpointIndex = 0;
  private generation = 0;
  private attemptCounter = 0;
  private attemptId: string | null = null;
  private activeEndpoint: string | null = null;
  private failedEndpoint: string | null = null;
  private nextEndpoint: string | null = null;
  private failure: KalshiTransportFailure | null = null;
  private nextRetryAt: number | null = null;
  private switchReason: string | null = null;
  private subscriptionAcknowledged = false;
  private pongReceived = false;
  private exchangeDataReceived = false;
  private lastExchangeDataAt: number | null = null;
  private reconnectDelayMs: number;
  private readonly counters = emptyCounters();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly attemptPrefix: string;
  private readonly coordinateRetries: boolean;

  constructor(
    private readonly environment: KalshiEnvironment,
    private readonly endpoints: readonly string[],
    options: TransportControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.attemptPrefix = options.attemptPrefix ?? 'kalshi-ws';
    this.coordinateRetries = options.coordinateRetries ?? true;
    this.reconnectDelayMs = this.baseDelayMs;
  }

  currentEndpoint(): string | null {
    return this.endpoints[this.endpointIndex] ?? this.endpoints[0] ?? null;
  }

  beginAttempt(): KalshiConnectionAttempt | null {
    const endpoint = this.currentEndpoint();
    if (!endpoint) return null;
    this.generation += 1;
    this.attemptCounter += 1;
    this.attemptId = `${this.attemptPrefix}-${this.generation}-${this.attemptCounter}`;
    this.activeEndpoint = endpoint;
    this.nextEndpoint = null;
    this.failure = null;
    this.nextRetryAt = null;
    this.switchReason = null;
    this.subscriptionAcknowledged = false;
    this.pongReceived = false;
    this.exchangeDataReceived = false;
    return { generation: this.generation, attemptId: this.attemptId, endpoint };
  }

  recordSubscriptionAck(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.subscriptionAcknowledged = true;
    this.tryResetBackoff();
    return true;
  }

  recordSubscriptionPending(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.subscriptionAcknowledged = false;
    return true;
  }

  recordPong(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.pongReceived = true;
    this.tryResetBackoff();
    return true;
  }

  recordExchangeData(generation: number, exchangeTimestamp: number): boolean {
    if (!this.isCurrent(generation) || !Number.isFinite(exchangeTimestamp)) return false;
    this.exchangeDataReceived = true;
    this.lastExchangeDataAt = exchangeTimestamp;
    this.tryResetBackoff();
    return true;
  }

  qualificationReady(now = this.now(), maxExchangeAgeMs = 25_000): boolean {
    return this.failure == null
      && this.subscriptionAcknowledged
      && this.pongReceived
      && this.exchangeDataReceived
      && this.lastExchangeDataAt != null
      && now >= this.lastExchangeDataAt
      && now - this.lastExchangeDataAt <= maxExchangeAgeMs;
  }

  recordFailure(generation: number, failure: KalshiTransportFailure): KalshiRetryDecision {
    if (!this.isCurrent(generation)) return noRetry();
    this.failure = failure;
    this.counters[failure.classification] += 1;
    this.failedEndpoint = this.activeEndpoint ?? this.currentEndpoint();
    this.activeEndpoint = null;
    this.subscriptionAcknowledged = false;
    this.pongReceived = false;
    this.exchangeDataReceived = false;

    const retry = failure.retryable && !failure.sticky;
    const rotateEndpoint = retry && failure.rotateEndpoint && this.endpoints.length > 1;
    if (rotateEndpoint) this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    this.nextEndpoint = retry ? this.currentEndpoint() : null;
    this.switchReason = rotateEndpoint ? failure.classification : null;
    if (!retry) {
      this.nextRetryAt = null;
      return noRetry();
    }

    if (this.coordinateRetries && failure.rotateEndpoint) {
      recordKalshiCircuitFailure(this.environment, this.attemptPrefix, this.now());
    }
    const minimumDelay = failure.classification === 'rate_limit'
      ? Math.max(this.reconnectDelayMs, failure.retryAfterMs ?? 0)
      : this.reconnectDelayMs;
    const jitter = Math.round(minimumDelay * this.jitterRatio * Math.max(0, Math.min(1, this.random())));
    const proposedRetryAt = this.now() + minimumDelay + jitter;
    const reservedRetryAt = this.coordinateRetries
      ? reserveKalshiProductionRetry(this.environment, proposedRetryAt, this.attemptPrefix)
      : proposedRetryAt;
    this.nextRetryAt = reservedRetryAt;
    this.reconnectDelayMs = Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, this.reconnectDelayMs * 2));
    return {
      retry: true,
      rotateEndpoint,
      delayMs: Math.max(0, reservedRetryAt - this.now()),
      nextRetryAt: reservedRetryAt,
    };
  }

  telemetry(): KalshiTransportTelemetry {
    return {
      environment: this.environment,
      generation: this.generation,
      attemptId: this.attemptId,
      activeEndpoint: this.activeEndpoint,
      failedEndpoint: this.failedEndpoint,
      nextEndpoint: this.nextEndpoint,
      failureClass: this.failure?.classification ?? null,
      errorCode: this.failure?.code ?? null,
      httpStatus: this.failure?.httpStatus ?? null,
      nextRetryAt: this.nextRetryAt,
      switchReason: this.switchReason,
      subscriptionAcknowledged: this.subscriptionAcknowledged,
      pongReceived: this.pongReceived,
      exchangeDataReceived: this.exchangeDataReceived,
      lastExchangeDataAt: this.lastExchangeDataAt,
      counters: { ...this.counters },
    };
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.attemptId != null;
  }

  private tryResetBackoff(): void {
    if (!this.subscriptionAcknowledged || !this.pongReceived || !this.exchangeDataReceived) return;
    this.reconnectDelayMs = this.baseDelayMs;
    this.failure = null;
    this.nextRetryAt = null;
    this.nextEndpoint = null;
    this.switchReason = null;
    if (this.coordinateRetries) recordKalshiCircuitSuccess(this.environment);
  }
}

export function createKalshiTransportFailure(
  classification: KalshiTransportFailureClass,
  detail: string,
  fields: Partial<Omit<KalshiTransportFailure,
    'classification' | 'detail' | 'occurredAt' | 'retryable' | 'rotateEndpoint' | 'sticky'>> = {},
  occurredAt = Date.now(),
): KalshiTransportFailure {
  return {
    classification,
    detail: redactDetail(detail),
    occurredAt,
    code: fields.code ?? null,
    httpStatus: fields.httpStatus ?? null,
    closeCode: fields.closeCode ?? null,
    closeReason: fields.closeReason == null ? null : redactDetail(fields.closeReason),
    retryAfterMs: fields.retryAfterMs ?? null,
    retryable: rotatingFailures.has(classification) || retryingSameEndpointFailures.has(classification),
    rotateEndpoint: rotatingFailures.has(classification),
    sticky: stickyFailures.has(classification),
  };
}

export function classifyKalshiWebSocketError(error: unknown, occurredAt = Date.now()): KalshiTransportFailure {
  const record = isRecord(error) ? error : {};
  const nested = isRecord(record.error) ? record.error : {};
  const status = finiteInteger(record.statusCode ?? record.status ?? nested.statusCode ?? nested.status);
  const code = stringValue(record.code ?? nested.code);
  const retryAfterMs = finiteInteger(record.retryAfterMs ?? nested.retryAfterMs);
  const message = error instanceof Error ? error.message : stringValue(record.message) ?? String(error);
  const combined = `${code ?? ''} ${message}`;
  let classification: KalshiTransportFailureClass;
  if (status === 401 || /\b401\b|unauthenticated|invalid credentials?/i.test(combined)) classification = 'authentication';
  else if (status === 403 || /\b403\b|forbidden|not authorized/i.test(combined)) classification = 'authorization';
  else if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(combined)) classification = 'rate_limit';
  else if ((status != null && status >= 500 && status <= 599) || /\b5\d\d\b/.test(combined)) classification = 'http_5xx';
  // Ordered before the dns/tls/protocol regexes: "The URL's protocol must be
  // one of 'ws:'" would otherwise match the generic protocol branch.
  else if (/ERR_INVALID_URL|invalid url|url's protocol must be|unsupported protocol/i.test(combined)) classification = 'configuration';
  else if (/ENOTFOUND|EAI_AGAIN|dns|getaddrinfo/i.test(combined)) classification = 'dns';
  else if (/ECONNRESET|EPIPE|socket hang up|connection reset/i.test(combined)) classification = 'connection_reset';
  else if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out/i.test(combined)) classification = 'timeout';
  else if (/CERT_|TLS|SSL|EPROTO|handshake/i.test(combined)) classification = 'tls';
  else if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNABORTED/i.test(combined)) classification = 'tcp';
  else if (/protocol|invalid frame|parse error/i.test(combined)) classification = 'protocol';
  else classification = 'unknown';
  return createKalshiTransportFailure(classification, message, { code, httpStatus: status, retryAfterMs }, occurredAt);
}

export function classifyKalshiWebSocketClose(
  code: number,
  reason: string | null,
  locallyStopped = false,
  occurredAt = Date.now(),
): KalshiTransportFailure {
  if (locallyStopped) return createKalshiTransportFailure('local_stop', 'local websocket stop', { closeCode: code }, occurredAt);
  const detail = reason || `websocket closed with code ${code}`;
  if (/unauthenticated|invalid credentials?|\b401\b/i.test(detail)) {
    return createKalshiTransportFailure('authentication', detail, { closeCode: code, closeReason: reason }, occurredAt);
  }
  if (/forbidden|not authorized|\b403\b/i.test(detail)) {
    return createKalshiTransportFailure('authorization', detail, { closeCode: code, closeReason: reason }, occurredAt);
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(detail)) {
    return createKalshiTransportFailure('rate_limit', detail, { closeCode: code, closeReason: reason }, occurredAt);
  }
  if (code === 1000) return createKalshiTransportFailure('normal_close', detail, { closeCode: code, closeReason: reason }, occurredAt);
  if (code === 1002 || code === 1003 || code === 1007 || code === 1008) {
    return createKalshiTransportFailure('protocol', detail, { closeCode: code, closeReason: reason }, occurredAt);
  }
  return createKalshiTransportFailure('abnormal_close', detail, { closeCode: code, closeReason: reason }, occurredAt);
}

function noRetry(): KalshiRetryDecision {
  return { retry: false, rotateEndpoint: false, delayMs: null, nextRetryAt: null };
}

function emptyCounters(): Record<KalshiTransportFailureClass, number> {
  return {
    dns: 0,
    tcp: 0,
    tls: 0,
    connection_reset: 0,
    timeout: 0,
    http_5xx: 0,
    abnormal_close: 0,
    normal_close: 0,
    authentication: 0,
    authorization: 0,
    rate_limit: 0,
    protocol: 0,
    sequence: 0,
    local_stop: 0,
    configuration: 0,
    unknown: 0,
  };
}

function finiteInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function redactDetail(value: string): string {
  return value
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/gi, '[redacted-key]')
    .replace(/(authorization|api[-_ ]?key|signature|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\[^\s,;]*/gi, '[redacted-user-path]')
    .slice(0, 500);
}
