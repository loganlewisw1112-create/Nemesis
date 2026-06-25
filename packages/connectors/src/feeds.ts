import type { KalshiTrade, GeoNewsItem } from '@nemesis/core';
import { fetchText, fetchMarkets, resilientFetch } from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';

export interface NewsItem {
  title: string;
  url: string;
  category: string;
  severity: number;
}

export interface InfraAlert {
  provider: string;
  status: 'operational' | 'degraded' | 'outage';
  summary: string;
}

export interface WeatherSnapshot {
  nws: number | null;
  openMeteo: number | null;
  lat: number;
  lon: number;
  fetchedAt: number;
}

export interface CryptoSnapshot {
  symbol: string;
  spotPrice: number;
  lagMs: number;
  fetchedAt: number;
}

export interface MacroSnapshot {
  releaseName: string;
  consensus: number;
  actual?: number;
  minutesToRelease: number;
  fetchedAt: number;
}

export interface SportsSnapshot {
  homeScore: number;
  awayScore: number;
  impliedWinProb: number;
  eventName: string;
  fetchedAt: number;
}

export interface FeedHubOptions {
  fredApiKey?: string;
  fetchFn?: typeof fetch;
}

const DEFAULT_FETCH = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined;

function getFetch(opts?: FeedHubOptions): typeof fetch {
  if (opts?.fetchFn) return opts.fetchFn;
  if (DEFAULT_FETCH) return DEFAULT_FETCH;
  throw new Error('fetch unavailable');
}

async function timed<T>(
  registry: ConnectorRegistry,
  id: Parameters<ConnectorRegistry['recordSuccess']>[0],
  fn: () => Promise<T>,
  opts?: { softFail?: boolean },
): Promise<T | null> {
  const start = Date.now();
  try {
    const result = await fn();
    registry.recordSuccess(id, Date.now() - start);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (opts?.softFail) {
      registry.recordWarn(id, msg);
    } else {
      registry.recordError(id, msg);
    }
    return null;
  }
}

export async function fetchNwsTemp(
  registry: ConnectorRegistry,
  lat: number,
  lon: number,
  _opts?: FeedHubOptions,
): Promise<number | null> {
  return timed(registry, 'nws', async () => {
    const points = await resilientFetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
      headers: { Accept: 'application/geo+json' },
      label: 'NWS points',
      timeoutMs: 10_000,
      retries: 2,
    });
    if (!points.ok) throw new Error(`NWS points ${points.status}`);
    const data = await points.json() as { properties?: { forecast?: string } };
    const forecastUrl = data.properties?.forecast;
    if (!forecastUrl) throw new Error('NWS forecast URL missing');
    const forecast = await resilientFetch(forecastUrl, {
      headers: { Accept: 'application/geo+json' },
      label: 'NWS forecast',
      timeoutMs: 10_000,
      retries: 2,
    });
    if (!forecast.ok) throw new Error(`NWS forecast ${forecast.status}`);
    const fdata = await forecast.json() as { properties?: { periods?: { temperature: number }[] } };
    const temp = fdata.properties?.periods?.[0]?.temperature;
    if (temp === undefined) throw new Error('NWS temperature missing');
    return temp;
  });
}

export async function fetchOpenMeteoTemp(
  registry: ConnectorRegistry,
  lat: number,
  lon: number,
  _opts?: FeedHubOptions,
): Promise<number | null> {
  return timed(registry, 'open-meteo', async () => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&timezone=auto&forecast_days=1`;
    const res = await resilientFetch(url, { label: 'Open-Meteo', timeoutMs: 10_000, retries: 2 });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json() as { daily?: { temperature_2m_max?: number[] } };
    const temp = data.daily?.temperature_2m_max?.[0];
    if (temp === undefined) throw new Error('Open-Meteo temperature missing');
    return temp;
  });
}

export async function fetchBinanceSpot(
  registry: ConnectorRegistry,
  symbol: string,
  _opts?: FeedHubOptions,
): Promise<{ price: number; lagMs: number } | null> {
  return timed(registry, 'binance-ws', async () => {
    const start = Date.now();
    const urls = [
      `https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=${symbol}`,
      `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
    ];
    for (const url of urls) {
      try {
        const res = await resilientFetch(url, { label: `Binance ${symbol}`, timeoutMs: 8_000, retries: 2 });
        if (!res.ok) continue;
        const data = await res.json() as { bidPrice?: string; askPrice?: string; price?: string };
        const bid = parseFloat(data.bidPrice ?? data.price ?? '');
        const ask = parseFloat(data.askPrice ?? data.price ?? '');
        const price = data.bidPrice && data.askPrice ? (bid + ask) / 2 : bid;
        if (!Number.isFinite(price)) continue;
        return { price, lagMs: Date.now() - start };
      } catch {
        continue;
      }
    }
    throw new Error(`Binance ${symbol} unreachable`);
  }, { softFail: true });
}

export async function fetchFredCpi(
  registry: ConnectorRegistry,
  apiKey: string | undefined,
  opts?: FeedHubOptions,
): Promise<{ latest: number; prior: number } | null> {
  if (!apiKey) {
    registry.recordWarn('fred', 'Optional — set NEMESIS_FRED_API_KEY for live CPI');
    return null;
  }
  return timed(registry, 'fred', async () => {
    const fetchFn = getFetch(opts);
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=${apiKey}&file_type=json&sort_order=desc&limit=13`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`FRED ${res.status}`);
    const data = await res.json() as { observations?: { value: string }[] };
    const obs = data.observations?.filter((o) => o.value !== '.').map((o) => parseFloat(o.value)) ?? [];
    if (obs.length < 2) throw new Error('FRED no observations');
    const latest = obs[0];
    const yearAgo = obs[Math.min(12, obs.length - 1)];
    const yoy = ((latest / yearAgo) - 1) * 100;
    if (!Number.isFinite(yoy)) throw new Error('FRED value invalid');
    return { latest: yoy, prior: yoy };
  });
}

export function minutesToNextCpiRelease(): number {
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  for (let attempt = 0; attempt < 14; attempt++) {
    const release = secondTuesdayUtc(year, month);
    release.setUTCHours(13, 30, 0, 0);
    if (release.getTime() > now.getTime()) {
      return Math.max(0, Math.round((release.getTime() - now.getTime()) / 60_000));
    }
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }
  return 7 * 24 * 60;
}

function secondTuesdayUtc(year: number, month: number): Date {
  let tuesdays = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, month, d));
    if (dt.getUTCMonth() !== month) break;
    if (dt.getUTCDay() === 2) {
      tuesdays++;
      if (tuesdays === 2) return dt;
    }
  }
  return new Date(Date.UTC(year, month, 15));
}

export async function fetchBlsCalendar(
  registry: ConnectorRegistry,
  _opts?: FeedHubOptions,
): Promise<number | null> {
  return timed(registry, 'bls', async () => {
    const minutes = minutesToNextCpiRelease();
    if (minutes > 60 * 24 * 30) throw new Error('BLS calendar out of range');
    return minutes;
  });
}

export async function fetchGdeltNews(
  registry: ConnectorRegistry,
  query: string,
  _opts?: FeedHubOptions,
): Promise<NewsItem | null> {
  return timed(registry, 'gdelt', async () => {
    const q = encodeURIComponent(query.slice(0, 60));
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&maxrecords=3&format=json&sort=DateDesc&timespan=3d`;
    const res = await resilientFetch(url, { label: 'GDELT', timeoutMs: 8_000, retries: 1 });
    if (res.status === 429) throw new Error('GDELT rate limited — using cache');
    if (!res.ok) throw new Error(`GDELT ${res.status}`);
    const data = await res.json() as { articles?: { title?: string; url?: string; domain?: string; tone?: number }[] };
    const article = data.articles?.[0];
    if (!article?.title) throw new Error('GDELT no articles');
    const tone = article.tone ?? 0;
    const severity = Math.min(1, Math.max(0.1, Math.abs(tone) / 10));
    return {
      title: article.title,
      url: article.url ?? '',
      category: article.domain?.split('.')[0] ?? 'news',
      severity,
    };
  }, { softFail: true });
}

export async function fetchCloudStatus(
  registry: ConnectorRegistry,
  opts?: FeedHubOptions,
): Promise<InfraAlert | null> {
  return timed(registry, 'cloud-status', async () => {
    const fetchFn = getFetch(opts);
    const res = await fetchFn('https://status.aws.amazon.com/rss/all.rss');
    if (!res.ok) throw new Error(`AWS status ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>[\s\S]*?<\/item>/g)];
    for (const item of items.slice(0, 5)) {
      const title = item[1].trim();
      const lower = title.toLowerCase();
      if (lower.includes('resolved') || lower.includes('operating normally')) continue;
      if (lower.includes('degrad') || lower.includes('issue') || lower.includes('error') || lower.includes('outage')) {
        const status = lower.includes('outage') ? 'outage' as const : 'degraded' as const;
        return { provider: 'AWS', status, summary: title.slice(0, 120) };
      }
    }
    return { provider: 'AWS', status: 'operational', summary: 'All systems operational' };
  });
}

export async function fetchNhcAdvisories(
  registry: ConnectorRegistry,
  _opts?: FeedHubOptions,
): Promise<{ active: boolean; summary: string } | null> {
  return timed(registry, 'nhc', async () => {
    const xml = await fetchText('https://www.nhc.noaa.gov/index-at.xml', {
      label: 'NHC',
      timeoutMs: 10_000,
      retries: 2,
    });
    const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)]
      .map((m) => m[1].trim())
      .filter((t) => t && !t.toLowerCase().includes('nhc') && !t.toLowerCase().includes('rss'));
    const active = titles.some((t) => /storm|hurricane|depression|cyclone/i.test(t));
    if (!active) return { active: false, summary: 'No active tropical cyclones' };
    const names = titles.filter((t) => /storm|hurricane|depression|cyclone/i.test(t)).slice(0, 3);
    return { active: true, summary: names.join('; ') || 'Active tropical weather' };
  }, { softFail: true });
}

export async function fetchIndustrialRss(
  registry: ConnectorRegistry,
  _opts?: FeedHubOptions,
): Promise<{ headline: string; url: string } | null> {
  return timed(registry, 'industrial-rss', async () => {
    const xml = await fetchText('https://feeds.feedburner.com/industrialnewsroom', {
      label: 'Industrial RSS',
      timeoutMs: 10_000,
      retries: 2,
    });
    const m = xml.match(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    if (!m) throw new Error('Industrial RSS empty');
    const link = xml.match(/<item>[\s\S]*?<link>([^<]+)<\/link>/);
    return { headline: m[1].trim(), url: link?.[1]?.trim() ?? '' };
  }, { softFail: true });
}

export async function fetchEspnScoreboard(
  registry: ConnectorRegistry,
  opts?: FeedHubOptions,
): Promise<SportsSnapshot | null> {
  return timed(registry, 'espn', async () => {
    const fetchFn = getFetch(opts);
    const res = await fetchFn('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    const data = await res.json() as {
      events?: {
        name?: string;
        competitions?: {
          competitors?: { homeAway?: string; score?: string; team?: { displayName?: string } }[];
          status?: { type?: { completed?: boolean } };
        }[];
      }[];
    };
    const event = data.events?.find((e) => {
      const comp = e.competitions?.[0];
      return comp && !comp.status?.type?.completed;
    }) ?? data.events?.[0];
    if (!event?.competitions?.[0]) throw new Error('ESPN no events');
    const comp = event.competitions[0];
    const home = comp.competitors?.find((c) => c.homeAway === 'home');
    const away = comp.competitors?.find((c) => c.homeAway === 'away');
    const homeScore = parseInt(home?.score ?? '0', 10);
    const awayScore = parseInt(away?.score ?? '0', 10);
    const total = homeScore + awayScore;
    const impliedWinProb = total > 0 ? homeScore / total : 0.5;
    return {
      homeScore,
      awayScore,
      impliedWinProb: Math.min(0.95, Math.max(0.05, impliedWinProb)),
      eventName: event.name ?? 'Live event',
      fetchedAt: Date.now(),
    };
  });
}

export async function pingKalshiWs(registry: ConnectorRegistry): Promise<boolean> {
  const start = Date.now();
  try {
    // Reuse the same base-URL fallback logic as the REST connector
    await fetchMarkets({ limit: 1 });
    registry.recordSuccess('kalshi-ws', Date.now() - start);
    return true;
  } catch (e) {
    registry.recordWarn('kalshi-ws', e instanceof Error ? e.message : 'Kalshi stream offline');
    return false;
  }
}

interface RegionQuery { query: string; region: string; lat: number; lon: number; countryCode: string }

const REGION_QUERIES: RegionQuery[] = [
  { query: 'united states federal reserve economy politics', region: 'US', lat: 38, lon: -97, countryCode: 'USA' },
  { query: 'european union germany france economy ecb', region: 'EU', lat: 50, lon: 10, countryCode: 'DEU' },
  { query: 'china economy trade beijing', region: 'ASIA', lat: 35, lon: 105, countryCode: 'CHN' },
  { query: 'middle east oil geopolitics saudi iran', region: 'MENA', lat: 25, lon: 45, countryCode: 'SAU' },
  { query: 'global inflation recession central bank interest rates', region: 'GLOBAL', lat: 20, lon: 0, countryCode: 'GLB' },
];

export async function fetchWorldNews(
  registry: ConnectorRegistry,
  opts?: FeedHubOptions,
): Promise<GeoNewsItem[]> {
  const results = await Promise.allSettled(
    REGION_QUERIES.map(async (r): Promise<GeoNewsItem | null> => {
      const item = await fetchGdeltNews(registry, r.query, opts);
      if (!item) return null;
      return {
        title: item.title,
        url: item.url,
        category: item.category,
        severity: item.severity,
        region: r.region,
        lat: r.lat,
        lon: r.lon,
        countryCode: r.countryCode,
        fetchedAt: Date.now(),
      };
    }),
  );
  const items: GeoNewsItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value !== null) items.push(r.value);
  }
  return items;
}

export async function pingKalshiPortfolio(
  registry: ConnectorRegistry,
  apiKey?: string,
): Promise<boolean> {
  if (!apiKey) {
    registry.recordWarn('kalshi-portfolio', 'Optional — set NEMESIS_KALSHI_API_KEY for live portfolio');
    return false;
  }
  registry.recordWarn('kalshi-portfolio', 'Credentials detected — signed portfolio sync pending pilot');
  return false;
}

export type TradesByTicker = Map<string, KalshiTrade[]>;
