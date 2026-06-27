import type { ConnectorHealth } from '@nemesis/core';
import { fetchMarkets } from '@nemesis/core';

export type ConnectorId =
  | 'kalshi-rest'
  | 'kalshi-trades'
  | 'kalshi-ws'
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
    return [...this.health.values()];
  }

  get(id: ConnectorId): ConnectorHealth | undefined {
    return this.health.get(id);
  }

  recordSuccess(id: ConnectorId, latencyMs: number) {
    const h = this.health.get(id);
    if (!h) return;
    h.status = 'ok';
    h.lastSuccess = Date.now();
    h.latencyMs = latencyMs;
    h.lastError = null;
  }

  recordError(id: ConnectorId, error: string) {
    const h = this.health.get(id);
    if (!h) return;
    h.status = 'error';
    h.errorCount1h += 1;
    h.lastError = error;
  }

  recordWarn(id: ConnectorId, detail: string) {
    const h = this.health.get(id);
    if (!h) return;
    if (h.status === 'ok') return;
    h.status = 'warn';
    h.lastError = detail;
  }

  recordDegraded(id: ConnectorId, detail: string) {
    const h = this.health.get(id);
    if (!h) return;
    h.status = 'warn';
    h.lastError = detail;
  }

  isHealthy(id: ConnectorId): boolean {
    const h = this.health.get(id);
    return h?.status === 'ok';
  }

  async pingKalshiRest(fetchFn?: typeof fetch): Promise<void> {
    const start = Date.now();
    try {
      await fetchMarkets({ limit: 1, fetchFn });
      this.recordSuccess('kalshi-rest', Date.now() - start);
    } catch (e) {
      this.recordError('kalshi-rest', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}
