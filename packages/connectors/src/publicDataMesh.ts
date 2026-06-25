import type { ConnectorRegistry } from './registry.js';
import type { FeedHub } from './FeedHub.js';
import type { FeedHubOptions } from './feeds.js';

export type SourceTrustTier = 1 | 2 | 3 | 4 | 5;

export interface PublicDataSourceRecord {
  id: string;
  name: string;
  category: string;
  trust_tier: SourceTrustTier;
  stale_after_ms: number;
  last_success: number | null;
  last_error: string | null;
}

export interface PublicDataObservationRecord {
  id: string;
  source_id: string;
  key: string;
  value: number;
  unit: string;
  timestamp: number;
  observed_at: number;
  metadata_json: string;
}

export interface PublicDataReleaseRecord {
  id: string;
  source_id: string;
  title: string;
  url: string;
  published_at: number;
  observed_at: number;
  summary: string;
  trust_tier: SourceTrustTier;
  metadata_json: string;
}

export interface PublicDataFreshnessRow {
  source_id: string;
  name: string;
  trust_tier: SourceTrustTier;
  age_ms: number | null;
  stale_after_ms: number;
  stale: boolean;
}

export interface PublicDataMeshState {
  sources: PublicDataSourceRecord[];
  observations: PublicDataObservationRecord[];
  releases: PublicDataReleaseRecord[];
  freshness: PublicDataFreshnessRow[];
}

export interface PublicDataMeshSink {
  insertPublicDataSource(source: PublicDataSourceRecord): void;
  insertPublicDataObservation(observation: PublicDataObservationRecord): void;
  insertPublicDataRelease(release: PublicDataReleaseRecord): void;
}

export interface PublicDataMeshOptions {
  sink: PublicDataMeshSink;
  staleAfterMs?: Record<string, number>;
  retainRecords?: number;
}

type PublicDataListener = (state: PublicDataMeshState) => void;
type PublicDataSourceInput =
  Omit<PublicDataSourceRecord, 'trust_tier' | 'last_success' | 'last_error'> & {
    trust_tier?: SourceTrustTier;
    last_success?: number | null;
    last_error?: string | null;
  };

const DEFAULT_RETAIN_RECORDS = 500;
const DEFAULT_STALE_MS: Record<string, number> = {
  eia: 600_000,
  'sec-edgar': 300_000,
  nws: 300_000,
  'open-meteo': 300_000,
  fred: 600_000,
  bls: 600_000,
  gdelt: 180_000,
  nhc: 300_000,
  'cloud-status': 180_000,
  'industrial-rss': 300_000,
  espn: 60_000,
};

const SOURCE_LABELS: Record<string, { name: string; category: string }> = {
  eia: { name: 'EIA Energy', category: 'energy' },
  'sec-edgar': { name: 'SEC EDGAR RSS', category: 'filings' },
  nws: { name: 'NWS', category: 'weather' },
  'open-meteo': { name: 'Open-Meteo', category: 'weather' },
  fred: { name: 'FRED', category: 'macro' },
  bls: { name: 'BLS', category: 'macro' },
  gdelt: { name: 'GDELT', category: 'news' },
  nhc: { name: 'NHC RSS', category: 'weather' },
  'cloud-status': { name: 'Cloud Status', category: 'infrastructure' },
  'industrial-rss': { name: 'Industrial RSS', category: 'industrial' },
  espn: { name: 'ESPN Reference', category: 'sports' },
};

export function sourceTrustTier(sourceId: string): SourceTrustTier {
  if (['eia', 'sec-edgar', 'nws', 'fred', 'bls', 'nhc'].includes(sourceId)) return 1;
  if (['open-meteo', 'cloud-status', 'espn'].includes(sourceId)) return 2;
  if (['gdelt', 'industrial-rss'].includes(sourceId)) return 3;
  return 5;
}

export function publicDataSource(
  id: string,
  overrides: Partial<Omit<PublicDataSourceRecord, 'id' | 'trust_tier'>> = {},
): PublicDataSourceRecord {
  const label = SOURCE_LABELS[id] ?? { name: id, category: 'unknown' };
  return {
    id,
    name: overrides.name ?? label.name,
    category: overrides.category ?? label.category,
    trust_tier: sourceTrustTier(id),
    stale_after_ms: overrides.stale_after_ms ?? DEFAULT_STALE_MS[id] ?? 300_000,
    last_success: overrides.last_success ?? null,
    last_error: overrides.last_error ?? null,
  };
}

export class PublicDataMesh {
  private sources = new Map<string, PublicDataSourceRecord>();
  private observations: PublicDataObservationRecord[] = [];
  private releases: PublicDataReleaseRecord[] = [];
  private listeners = new Set<PublicDataListener>();
  private readonly retainRecords: number;

  constructor(private options: PublicDataMeshOptions) {
    this.retainRecords = options.retainRecords ?? DEFAULT_RETAIN_RECORDS;
  }

  onUpdate(listener: PublicDataListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ingestSource(source: PublicDataSourceInput) {
    const full: PublicDataSourceRecord = {
      ...source,
      trust_tier: source.trust_tier ?? sourceTrustTier(source.id),
      last_success: source.last_success ?? null,
      last_error: source.last_error ?? null,
    };
    this.sources.set(full.id, full);
    this.options.sink.insertPublicDataSource(full);
    this.emit();
  }

  ingestObservation(observation: PublicDataObservationRecord) {
    this.ensureSource(observation.source_id, observation.observed_at, null);
    this.options.sink.insertPublicDataObservation(observation);
    this.observations = retain([observation, ...this.observations], this.retainRecords);
    this.emit();
  }

  ingestRelease(release: PublicDataReleaseRecord) {
    this.ensureSource(release.source_id, release.observed_at, null);
    this.options.sink.insertPublicDataRelease(release);
    this.releases = retain([release, ...this.releases], this.retainRecords);
    this.emit();
  }

  ingestFeedHubSnapshot(feedHub: FeedHub, now = Date.now()) {
    const weather = feedHub.getWeatherSnapshot();
    if (weather) {
      this.ingestSource(publicDataSource('nws', { last_success: weather.fetchedAt }));
      this.ingestSource(publicDataSource('open-meteo', { last_success: weather.fetchedAt }));
      if (weather.nws !== null) this.ingestObservation(numberObservation('nws', 'temperature_f', weather.nws, 'fahrenheit', weather.fetchedAt, now));
      if (weather.openMeteo !== null) this.ingestObservation(numberObservation('open-meteo', 'temperature_max_c', weather.openMeteo, 'celsius', weather.fetchedAt, now));
    }

    const macro = feedHub.getMacroSnapshot();
    if (macro) {
      this.ingestSource(publicDataSource('fred', { last_success: macro.fetchedAt }));
      this.ingestSource(publicDataSource('bls', { last_success: macro.fetchedAt }));
      if (typeof macro.actual === 'number') this.ingestObservation(numberObservation('fred', 'cpi_yoy', macro.actual, 'percent', macro.fetchedAt, now));
      this.ingestObservation(numberObservation('bls', 'minutes_to_cpi_release', macro.minutesToRelease, 'minutes', macro.fetchedAt, now));
    }

    const worldNews = feedHub.getWorldNews();
    if (worldNews.length > 0) {
      this.ingestSource(publicDataSource('gdelt', { last_success: now }));
      for (const item of worldNews.slice(0, 10)) {
        this.ingestRelease({
          id: stableId('gdelt', item.url || item.title, item.fetchedAt),
          source_id: 'gdelt',
          title: item.title,
          url: item.url,
          published_at: item.fetchedAt,
          observed_at: now,
          summary: `${item.region} / ${item.category}`,
          trust_tier: sourceTrustTier('gdelt'),
          metadata_json: JSON.stringify({ severity: item.severity, countryCode: item.countryCode, lat: item.lat, lon: item.lon }),
        });
      }
    }

    const infra = feedHub.getInfraAlert();
    if (infra) {
      this.ingestSource(publicDataSource('cloud-status', { last_success: now }));
      this.ingestRelease({
        id: stableId('cloud-status', infra.summary, now),
        source_id: 'cloud-status',
        title: `${infra.provider}: ${infra.status}`,
        url: '',
        published_at: now,
        observed_at: now,
        summary: infra.summary,
        trust_tier: sourceTrustTier('cloud-status'),
        metadata_json: JSON.stringify({ provider: infra.provider, status: infra.status }),
      });
    }
  }

  getState(now = Date.now()): PublicDataMeshState {
    const sources = [...this.sources.values()].sort((a, b) => a.trust_tier - b.trust_tier || a.id.localeCompare(b.id));
    return {
      sources,
      observations: [...this.observations],
      releases: [...this.releases],
      freshness: sources.map((source) => {
        const latest = latestObservedAt(source.id, this.observations, this.releases) ?? source.last_success;
        const age_ms = latest === null ? null : Math.max(0, now - latest);
        const stale_after_ms = this.options.staleAfterMs?.[source.id] ?? source.stale_after_ms;
        return {
          source_id: source.id,
          name: source.name,
          trust_tier: source.trust_tier,
          age_ms,
          stale_after_ms,
          stale: age_ms === null || age_ms > stale_after_ms,
        };
      }),
    };
  }

  private ensureSource(sourceId: string, lastSuccess: number, lastError: string | null) {
    const existing = this.sources.get(sourceId);
    if (existing) {
      const updated = { ...existing, last_success: Math.max(existing.last_success ?? 0, lastSuccess), last_error: lastError };
      this.sources.set(sourceId, updated);
      this.options.sink.insertPublicDataSource(updated);
      return;
    }
    const source = publicDataSource(sourceId, { last_success: lastSuccess, last_error: lastError });
    this.sources.set(sourceId, source);
    this.options.sink.insertPublicDataSource(source);
  }

  private emit() {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

export function parseEiaSeriesResponse(
  seriesId: string,
  label: string,
  raw: unknown,
  observedAt = Date.now(),
): PublicDataObservationRecord[] {
  const rows = eiaRows(raw);
  return rows
    .map((row, idx): PublicDataObservationRecord | null => {
      const value = Number.parseFloat(String(row.value ?? ''));
      const timestamp = parsePeriod(row.period);
      if (!Number.isFinite(value) || timestamp === null) return null;
      return {
        id: stableId('eia', `${seriesId}-${row.period}-${idx}`, observedAt),
        source_id: 'eia',
        key: seriesId,
        value,
        unit: String(row.units ?? row.unit ?? ''),
        timestamp,
        observed_at: observedAt,
        metadata_json: JSON.stringify({ label, period: row.period }),
      };
    })
    .filter((row): row is PublicDataObservationRecord => row !== null);
}

export function parseSecEdgarRss(xml: string, observedAt = Date.now()): PublicDataReleaseRecord[] {
  const itemBlocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
  return itemBlocks.map((item, idx): PublicDataReleaseRecord | null => {
    const title = stripTags(textIn(item, 'title')).trim();
    if (!title) return null;
    const url = stripTags(textIn(item, 'link')).trim() || linkHref(item);
    const dateText = stripTags(textIn(item, 'pubDate')).trim() || stripTags(textIn(item, 'updated')).trim();
    const published = Date.parse(dateText);
    const summary = stripTags(textIn(item, 'description')).trim() || stripTags(textIn(item, 'summary')).trim();
    const publishedAt = Number.isFinite(published) ? published : observedAt;
    return {
      id: stableId('sec-edgar', `${title}-${url}-${idx}`, publishedAt),
      source_id: 'sec-edgar',
      title: decodeXml(title),
      url: decodeXml(url),
      published_at: publishedAt,
      observed_at: observedAt,
      summary: decodeXml(summary),
      trust_tier: sourceTrustTier('sec-edgar'),
      metadata_json: '{}',
    };
  }).filter((row): row is PublicDataReleaseRecord => row !== null);
}

export async function fetchEiaEnergySnapshot(
  registry: ConnectorRegistry,
  opts: FeedHubOptions & { apiKey?: string; seriesId?: string; label?: string } = {},
): Promise<PublicDataObservationRecord[]> {
  const seriesId = opts.seriesId ?? 'PET.RWTC.D';
  const label = opts.label ?? 'WTI spot price';
  const fetchFn = opts.fetchFn ?? fetch;
  const url = opts.apiKey
    ? `https://api.eia.gov/v2/seriesid/${encodeURIComponent(seriesId)}?api_key=${encodeURIComponent(opts.apiKey)}`
    : `https://api.eia.gov/v2/seriesid/${encodeURIComponent(seriesId)}`;
  const start = Date.now();
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`EIA ${res.status}`);
    const observations = parseEiaSeriesResponse(seriesId, label, await res.json(), Date.now());
    registry.recordSuccess('eia', Date.now() - start);
    return observations;
  } catch (err) {
    registry.recordWarn('eia', err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function fetchSecEdgarRss(
  registry: ConnectorRegistry,
  opts: FeedHubOptions = {},
): Promise<PublicDataReleaseRecord[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const start = Date.now();
  try {
    const res = await fetchFn('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&output=atom&count=40', {
      headers: {
        Accept: 'application/atom+xml, application/rss+xml, text/xml',
        'User-Agent': 'NEMESIS Global Event Alpha contact@example.com',
      },
    });
    if (!res.ok) throw new Error(`SEC EDGAR ${res.status}`);
    const releases = parseSecEdgarRss(await res.text(), Date.now());
    registry.recordSuccess('sec-edgar', Date.now() - start);
    return releases;
  } catch (err) {
    registry.recordWarn('sec-edgar', err instanceof Error ? err.message : String(err));
    return [];
  }
}

function numberObservation(sourceId: string, key: string, value: number, unit: string, timestamp: number, observedAt: number): PublicDataObservationRecord {
  return {
    id: stableId(sourceId, `${key}-${timestamp}`, observedAt),
    source_id: sourceId,
    key,
    value,
    unit,
    timestamp,
    observed_at: observedAt,
    metadata_json: '{}',
  };
}

function eiaRows(raw: unknown): Array<{ period?: unknown; value?: unknown; unit?: unknown; units?: unknown }> {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { response?: { data?: unknown }; data?: unknown };
  const data = obj.response?.data ?? obj.data;
  return Array.isArray(data) ? data as Array<{ period?: unknown; value?: unknown; unit?: unknown; units?: unknown }> : [];
}

function parsePeriod(period: unknown): number | null {
  if (typeof period !== 'string' || period.length === 0) return null;
  const iso = period.length === 7 ? `${period}-01T00:00:00.000Z` : `${period}T00:00:00.000Z`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function textIn(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1] ?? '';
}

function linkHref(xml: string): string {
  const match = xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
  return match?.[1] ?? '';
}

function stripTags(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function latestObservedAt(
  sourceId: string,
  observations: PublicDataObservationRecord[],
  releases: PublicDataReleaseRecord[],
): number | null {
  let latest: number | null = null;
  for (const observation of observations) {
    if (observation.source_id === sourceId) latest = Math.max(latest ?? 0, observation.observed_at);
  }
  for (const release of releases) {
    if (release.source_id === sourceId) latest = Math.max(latest ?? 0, release.observed_at);
  }
  return latest;
}

function stableId(sourceId: string, input: string, timestamp: number): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `${sourceId}-${Math.abs(hash).toString(36)}-${timestamp}`;
}

function retain<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(0, limit) : items;
}
