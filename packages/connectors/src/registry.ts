import type { ConnectorHealth, KalshiFailureClass } from '@nemesis/core';
import { fetchMarkets, KalshiRequestFailure } from '@nemesis/core';

const REQUIRED_REST_FRESHNESS_MS = 30_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;

function inferFailureClass(error: string): KalshiFailureClass {
  if (/\b429\b|rate.?limit|too many requests/i.test(error)) return 'rate_limit';
  if (/\b401\b|authentication/i.test(error)) return 'authentication';
  if (/\b403\b|authorization/i.test(error)) return 'authorization';
  if (/timeout|timed out/i.test(error)) return 'timeout';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|SSL/i.test(error)) return 'network';
  return 'unknown';
}

export type ConnectorId =
  | 'kalshi-rest'
  | 'kalshi-trades'
  | 'kalshi-ws'
  | 'kalshi-ticker-ws'
  | 'kalshi-orderbook-ws'
  | 'kalshi-portfolio'
  | 'nws'
  | 'open-meteo'
  | 'fred'
  | 'bls'
  | 'binance-ws'
  | 'gdelt'
  | 'eia'
  | 'sec-edgar'
  | 'nhc'
  | 'cloud-status'
  | 'industrial-rss'
  | 'espn';

export interface ConnectorDef {
  id: ConnectorId;
  name: string;
  pollMs?: number;
}

export const CONNECTORS: ConnectorDef[] = [
  { id: 'kalshi-rest', name: 'Kalshi REST', pollMs: 30_000 },
  { id: 'kalshi-trades', name: 'Kalshi Trade Tape', pollMs: 15_000 },
  { id: 'kalshi-ws', name: 'Kalshi WebSocket', pollMs: 5_000 },
  { id: 'kalshi-ticker-ws', name: 'Kalshi Ticker WebSocket', pollMs: 5_000 },
  { id: 'kalshi-orderbook-ws', name: 'Kalshi Orderbook WebSocket', pollMs: 5_000 },
  { id: 'kalshi-portfolio', name: 'Kalshi Portfolio' },
  { id: 'nws', name: 'NWS', pollMs: 300_000 },
  { id: 'open-meteo', name: 'Open-Meteo', pollMs: 300_000 },
  { id: 'fred', name: 'FRED', pollMs: 600_000 },
  { id: 'bls', name: 'BLS', pollMs: 600_000 },
  { id: 'binance-ws', name: 'Binance WS' },
  { id: 'gdelt', name: 'GDELT', pollMs: 120_000 },
  { id: 'eia', name: 'EIA Energy', pollMs: 600_000 },
  { id: 'sec-edgar', name: 'SEC EDGAR RSS', pollMs: 300_000 },
  { id: 'nhc', name: 'NHC RSS', pollMs: 300_000 },
  { id: 'cloud-status', name: 'Cloud Status', pollMs: 180_000 },
  { id: 'industrial-rss', name: 'Industrial RSS', pollMs: 300_000 },
  { id: 'espn', name: 'ESPN Reference', pollMs: 60_000 },
];

export class ConnectorRegistry {
  private health = new Map<ConnectorId, ConnectorHealth>();
  private lastRecordedError = new Map<ConnectorId, { error: string; failureClass: KalshiFailureClass; at: number }>();

  constructor() {
    for (const c of CONNECTORS) {
      this.health.set(c.id, {
        id: c.id,
        name: c.name,
        status: 'warn',
        lastSuccess: null,
        latencyMs: null,
        errorCount1h: 0,
        lastError: null,
      });
    }
  }

  getAll(): ConnectorHealth[] {
    return [...this.health.values()].map((health) => ({ ...health }));
  }

  get(id: ConnectorId): ConnectorHealth | undefined {
    const health = this.health.get(id);
    return health ? { ...health } : undefined;
  }

  recordAttempt(id: ConnectorId, now = Date.now()) {
    const h = this.health.get(id);
    if (!h) return;
    h.lastAttempt = now;
  }

  recordSuccess(id: ConnectorId, latencyMs: number) {
    const h = this.health.get(id);
    if (!h) return;
    const now = Date.now();
    h.status = 'ok';
    h.lastSuccess = now;
    h.lastMessageAt = now;
    h.latencyMs = latencyMs;
    h.lastError = null;
    h.lastAttempt = now;
    h.failureClass = null;
    h.transportConnected = true;
    h.qualificationReady = true;
    h.nextRetryAt = null;
    this.lastRecordedError.delete(id);
  }

  recordError(
    id: ConnectorId,
    error: string,
    failureClass?: KalshiFailureClass,
    retryAfterMs?: number | null,
  ) {
    const h = this.health.get(id);
    if (!h) return;
    const now = Date.now();
    const resolvedFailureClass = failureClass ?? inferFailureClass(error);
    const previousError = this.lastRecordedError.get(id);
    const duplicate = previousError?.failureClass === resolvedFailureClass
      && previousError.error === error
      && now - previousError.at < 1_000;
    if (!duplicate) h.errorCount1h += 1;
    this.lastRecordedError.set(id, { error, failureClass: resolvedFailureClass, at: now });
    h.lastError = error;
    h.lastAttempt = now;
    h.failureClass = resolvedFailureClass;
    if (resolvedFailureClass === 'rate_limit') {
      const backoffMs = Math.max(DEFAULT_RATE_LIMIT_BACKOFF_MS, retryAfterMs ?? 0);
      h.nextRetryAt = Math.max(h.nextRetryAt ?? 0, now + backoffMs);
      const lastSuccessAgeMs = h.lastSuccess == null ? Number.POSITIVE_INFINITY : now - h.lastSuccess;
      const leaseFresh = lastSuccessAgeMs <= REQUIRED_REST_FRESHNESS_MS;
      h.status = leaseFresh ? 'warn' : 'error';
      h.qualificationReady = leaseFresh;
      h.transportConnected = true;
      return;
    }
    h.status = 'error';
    h.qualificationReady = false;
  }

  recordWarn(id: ConnectorId, detail: string) {
    const h = this.health.get(id);
    if (!h) return;
    h.status = 'warn';
    h.lastError = detail;
    h.qualificationReady = false;
  }

  recordDegraded(id: ConnectorId, detail: string) {
    const h = this.health.get(id);
    if (!h) return;
    h.status = 'warn';
    h.lastError = detail;
    h.qualificationReady = false;
  }

  recordTelemetry(id: ConnectorId, telemetry: Partial<Omit<ConnectorHealth, 'id' | 'name'>>) {
    const h = this.health.get(id);
    if (!h) return;
    Object.assign(h, telemetry);
  }

  refreshFreshness(id: ConnectorId, staleAfterMs: number, now = Date.now()): ConnectorHealth | undefined {
    const h = this.health.get(id);
    if (!h) return undefined;
    const sourceAt = h.lastMessageAt ?? h.lastSuccess;
    h.freshnessMs = sourceAt === null || sourceAt === undefined ? null : Math.max(0, now - sourceAt);
    if (h.freshnessMs === null || h.freshnessMs > staleAfterMs) {
      h.qualificationReady = false;
      if (h.status === 'ok') h.status = 'warn';
    }
    return { ...h };
  }

  isHealthy(id: ConnectorId): boolean {
    const h = this.health.get(id);
    return h?.status === 'ok';
  }

  async pingKalshiRest(fetchFn?: typeof fetch): Promise<void> {
    const start = Date.now();
    const health = this.health.get('kalshi-rest');
    if (health?.nextRetryAt != null && start < health.nextRetryAt) return;
    this.recordAttempt('kalshi-rest', start);
    try {
      await fetchMarkets({ limit: 1, fetchFn });
      this.recordSuccess('kalshi-rest', Date.now() - start);
    } catch (e) {
      this.recordError(
        'kalshi-rest',
        e instanceof Error ? e.message : String(e),
        e instanceof KalshiRequestFailure ? e.classification : undefined,
        e instanceof KalshiRequestFailure ? e.retryAfterMs : undefined,
      );
      throw e;
    }
  }
}
