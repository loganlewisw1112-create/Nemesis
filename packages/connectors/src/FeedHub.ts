import { fetchTrades, type KalshiMarket, type KalshiTrade, type GeoNewsItem } from '@nemesis/core';
import { BinanceStream, type BinanceQuote } from './binanceStream.js';
import type { ConnectorRegistry } from './registry.js';
import type { InfraAlert, NewsItem } from './feeds.js';
import {
  fetchBinanceSpot,
  fetchBlsCalendar,
  fetchCloudStatus,
  fetchEiaEnergy,
  fetchEspnScoreboard,
  fetchFredCpi,
  fetchGdeltNews,
  fetchWorldNews,
  fetchIndustrialRss,
  fetchNhcAdvisories,
  fetchNwsTemp,
  fetchOpenMeteoTemp,
  fetchSecEdgarHeadlines,
  pingKalshiPortfolio,
  pingKalshiWs,
  minutesToNextCpiRelease,
  type CryptoSnapshot,
  type FeedHubOptions,
  type MacroSnapshot,
  type SportsSnapshot,
  type WeatherSnapshot,
} from './feeds.js';
import {
  gdeltQueryFromTitle,
  hoursToSettle,
  isCryptoMarket,
  isWeatherMarket,
  parseBtcStrike,
  parseCpiStrike,
  parseCryptoSymbol,
  parseTemperatureStrike,
  parseWeatherCoords,
} from './parseMarket.js';

const STALE_MS: Record<string, number> = {
  weather: 180_000,
  crypto: 2_000,
  macro: 600_000,
  gdelt: 180_000,
  infra: 120_000,
  nhc: 300_000,
  industrial: 300_000,
  sports: 30_000,
  trades: 15_000,
  kalshiWs: 45_000,
  worldNews: 180_000,
  eia: 600_000,
  secEdgar: 300_000,
};

const SHARED_GDELT_QUERY = 'united states economy politics';
const TRADE_BACKOFF_BASE_MS = 30_000;
const TRADE_BACKOFF_MAX_MS = 300_000;
const TRADE_WARNING_THROTTLE_MS = 300_000;

export interface FeedHubTradeFeedState {
  status: 'ok' | 'degraded';
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  nextRetryAt: number | null;
  failureCount: number;
  lastError: string | null;
  cachedTradeCount: number;
  backoffMs: number;
  lastWarningAt: number | null;
}

function tradeBackoffMs(failureCount: number): number {
  return Math.min(TRADE_BACKOFF_MAX_MS, TRADE_BACKOFF_BASE_MS * (2 ** Math.max(0, failureCount - 1)));
}

export class FeedHub {
  private weather: WeatherSnapshot | null = null;
  private crypto = new Map<string, CryptoSnapshot>();
  private macro: MacroSnapshot | null = null;
  private gdeltCache = new Map<string, { news: NewsItem; fetchedAt: number }>();
  private infra: (InfraAlert & { fetchedAt: number }) | null = null;
  private nhc: { active: boolean; summary: string; fetchedAt: number } | null = null;
  private industrial: { headline: string; url: string; fetchedAt: number } | null = null;
  private sports: SportsSnapshot | null = null;
  private trades: KalshiTrade[] = [];
  private tradesFetchedAt = 0;
  private tradeWarningAt = 0;
  private tradeFeedState: FeedHubTradeFeedState = {
    status: 'ok',
    lastSuccessAt: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    failureCount: 0,
    lastError: null,
    cachedTradeCount: 0,
    backoffMs: 0,
    lastWarningAt: null,
  };
  private worldNews: GeoNewsItem[] = [];
  private worldNewsAt = 0;
  private kalshiWsAt = 0;
  private portfolioPingAt = 0;
  private eia: { series: string; value: number; period: string; fetchedAt: number } | null = null;
  private eiaAt = 0;
  private secEdgar: { title: string; link: string; fetchedAt: number } | null = null;
  private secEdgarAt = 0;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private lastMarkets: KalshiMarket[] = [];
  private refreshInFlight: Promise<void> | null = null;
  private refreshActiveKey: string | null = null;
  private refreshQueuedMarkets: KalshiMarket[] | null = null;
  private refreshQueuedKey: string | null = null;
  private binance: BinanceStream;

  private kalshiApiKey: string | undefined;

  constructor(
    private registry: ConnectorRegistry,
    private opts: FeedHubOptions = {},
  ) {
    this.opts.fredApiKey = opts.fredApiKey ?? process.env.NEMESIS_FRED_API_KEY;
    this.binance = new BinanceStream(registry);
    this.binance.start();
  }

  setKalshiApiKey(key: string | undefined) {
    this.kalshiApiKey = key;
  }

  startBackgroundPolling(intervalMs = 8_000) {
    if (this.backgroundTimer) return;
    this.backgroundTimer = setInterval(() => {
      if (this.lastMarkets.length > 0) void this.refreshForMarkets(this.lastMarkets);
    }, intervalMs);
  }

  stopBackgroundPolling() {
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
    this.binance.stop();
  }

  getWeatherSnapshot(): WeatherSnapshot | null {
    return this.weather;
  }

  getCryptoSnapshot(symbol: string): CryptoSnapshot | null {
    return this.crypto.get(symbol) ?? null;
  }

  getMacroSnapshot(): MacroSnapshot | null {
    return this.macro;
  }

  getGdeltNews(query: string): NewsItem | null {
    return this.gdeltCache.get(query)?.news ?? null;
  }

  getWorldNews(): GeoNewsItem[] {
    return this.worldNews;
  }

  getInfraAlert(): InfraAlert | null {
    if (!this.infra || this.infra.status === 'operational') return null;
    return { provider: this.infra.provider, status: this.infra.status, summary: this.infra.summary };
  }

  getNhcSummary(): string | null {
    return this.nhc?.active ? this.nhc.summary : null;
  }

  getIndustrialHeadline(): { headline: string; url: string } | null {
    return this.industrial;
  }

  getSportsSnapshot(): SportsSnapshot | null {
    return this.sports;
  }

  getTradesForTicker(ticker: string): KalshiTrade[] {
    return this.trades.filter((t) => t.ticker === ticker);
  }

  getTradeFeedState(): FeedHubTradeFeedState {
    return { ...this.tradeFeedState, cachedTradeCount: this.trades.length };
  }

  refreshForMarkets(markets: KalshiMarket[]): Promise<void> {
    this.lastMarkets = markets;
    const key = this.marketRefreshKey(markets);
    if (this.refreshInFlight) {
      if (key !== this.refreshActiveKey) {
        this.refreshQueuedMarkets = markets;
        this.refreshQueuedKey = key;
      }
      return this.refreshInFlight;
    }

    this.refreshActiveKey = key;
    this.refreshInFlight = this.runRefreshLoop(markets, key).finally(() => {
      this.refreshInFlight = null;
      this.refreshActiveKey = null;
      this.refreshQueuedMarkets = null;
      this.refreshQueuedKey = null;
    });
    return this.refreshInFlight;
  }

  private async runRefreshLoop(markets: KalshiMarket[], key: string): Promise<void> {
    let currentMarkets = markets;
    let currentKey = key;
    for (;;) {
      this.refreshQueuedMarkets = null;
      this.refreshQueuedKey = null;
      await this.refreshForMarketsOnce(currentMarkets);
      const nextMarkets = this.refreshQueuedMarkets;
      const nextKey = this.refreshQueuedKey;
      if (!nextMarkets || !nextKey || nextKey === currentKey) return;
      currentMarkets = nextMarkets;
      currentKey = nextKey;
      this.refreshActiveKey = currentKey;
    }
  }

  private marketRefreshKey(markets: KalshiMarket[]): string {
    return markets.map((m) => m.ticker).join('\u0000');
  }

  private async refreshForMarketsOnce(markets: KalshiMarket[]): Promise<void> {
    for (const m of markets.filter(isCryptoMarket)) {
      this.binance.track(parseCryptoSymbol(m.title, m.ticker));
    }

    const tasks: Promise<void>[] = [];

    if (this.isStale(this.weather?.fetchedAt, STALE_MS.weather)) {
      tasks.push(this.refreshWeather(markets));
    }

    for (const m of markets.filter(isCryptoMarket)) {
      const symbol = parseCryptoSymbol(m.title, m.ticker);
      const snap = this.crypto.get(symbol);
      const live = this.binance.getQuote(symbol);
      if (live) {
        this.crypto.set(symbol, {
          symbol,
          spotPrice: live.price,
          lagMs: live.lagMs,
          fetchedAt: live.fetchedAt,
          momentumBps: live.momentumBps,
          volatilityBps: live.volatilityBps,
          sampleCount: live.sampleCount,
          windowMs: live.windowMs,
        });
      } else if (this.isStale(snap?.fetchedAt, STALE_MS.crypto)) {
        tasks.push(this.refreshCrypto(symbol));
      }
    }

    if (this.isStale(this.macro?.fetchedAt, STALE_MS.macro)) {
      tasks.push(this.refreshMacro());
    }

    if (this.isStale(this.infra?.fetchedAt, STALE_MS.infra)) {
      tasks.push(this.refreshInfra());
    }

    if (this.isStale(this.nhc?.fetchedAt, STALE_MS.nhc)) {
      tasks.push(this.refreshNhc());
    }

    if (this.isStale(this.industrial?.fetchedAt, STALE_MS.industrial)) {
      tasks.push(this.refreshIndustrial());
    }

    if (this.isStale(this.sports?.fetchedAt, STALE_MS.sports)) {
      tasks.push(this.refreshSports());
    }

    if (this.shouldRefreshTrades()) {
      tasks.push(this.refreshTrades());
    }

    if (this.isStale(this.kalshiWsAt, STALE_MS.kalshiWs)) {
      tasks.push(this.refreshKalshiWs());
    }

    if (this.isStale(this.portfolioPingAt, 300_000)) {
      tasks.push(this.refreshPortfolioPing());
    }

    const gdeltCached = this.gdeltCache.get(SHARED_GDELT_QUERY);
    if (this.isStale(gdeltCached?.fetchedAt, STALE_MS.gdelt)) {
      tasks.push(this.refreshGdelt(SHARED_GDELT_QUERY));
    }

    if (this.isStale(this.worldNewsAt, STALE_MS.worldNews)) {
      tasks.push(this.refreshWorldNews());
    }

    if (this.isStale(this.eiaAt, STALE_MS.eia)) {
      tasks.push(this.refreshEia());
    }

    if (this.isStale(this.secEdgarAt, STALE_MS.secEdgar)) {
      tasks.push(this.refreshSecEdgar());
    }

    await Promise.allSettled(tasks);
  }

  /** Non-blocking refresh — returns immediately, uses cache for thesis build */
  kickRefresh(markets: KalshiMarket[]) {
    void this.refreshForMarkets(markets);
  }

  private isStale(fetchedAt: number | undefined, maxAge: number): boolean {
    if (!fetchedAt) return true;
    return Date.now() - fetchedAt > maxAge;
  }

  private shouldRefreshTrades(now = Date.now()): boolean {
    const nextRetryAt = this.tradeFeedState.nextRetryAt;
    if (nextRetryAt !== null && now < nextRetryAt) return false;
    return this.tradeFeedState.status === 'degraded' || this.isStale(this.tradesFetchedAt, STALE_MS.trades);
  }

  private async refreshWeather(markets: KalshiMarket[]): Promise<void> {
    const m = markets.find(isWeatherMarket) ?? markets[0];
    const { lat, lon } = parseWeatherCoords(m?.title ?? 'NYC');
    const [nws, openMeteo] = await Promise.all([
      fetchNwsTemp(this.registry, lat, lon, this.opts),
      fetchOpenMeteoTemp(this.registry, lat, lon, this.opts),
    ]);
    this.weather = { nws, openMeteo, lat, lon, fetchedAt: Date.now() };
  }

  private async refreshCrypto(symbol: string): Promise<void> {
    const result = await fetchBinanceSpot(this.registry, symbol, this.opts);
    if (result) {
      const fetchedAt = Date.now();
      this.crypto.set(symbol, {
        symbol,
        spotPrice: result.price,
        lagMs: result.lagMs,
        fetchedAt,
        momentumBps: 0,
        volatilityBps: 0,
        sampleCount: 1,
        windowMs: 0,
      });
    }
  }

  private async refreshMacro(): Promise<void> {
    const [fred, blsMinutes] = await Promise.all([
      fetchFredCpi(this.registry, this.opts.fredApiKey, this.opts),
      fetchBlsCalendar(this.registry, this.opts),
    ]);
    const minutes = blsMinutes ?? minutesToNextCpiRelease();
    this.macro = {
      releaseName: 'CPI',
      consensus: 3.2,
      actual: fred ? parseFloat(fred.latest.toFixed(2)) : undefined,
      minutesToRelease: minutes,
      fetchedAt: Date.now(),
    };
  }

  private async refreshGdelt(query: string): Promise<void> {
    const news = await fetchGdeltNews(this.registry, query, this.opts);
    if (news) {
      this.gdeltCache.set(query, { news, fetchedAt: Date.now() });
    }
  }

  private async refreshWorldNews(): Promise<void> {
    const items = await fetchWorldNews(this.registry, this.opts);
    if (items.length > 0) {
      this.worldNews = items;
    }
    this.worldNewsAt = Date.now();
  }

  private async refreshInfra(): Promise<void> {
    const alert = await fetchCloudStatus(this.registry, this.opts);
    if (alert) {
      this.infra = { ...alert, fetchedAt: Date.now() };
    }
  }

  private async refreshNhc(): Promise<void> {
    const nhc = await fetchNhcAdvisories(this.registry, this.opts);
    if (nhc) {
      this.nhc = { ...nhc, fetchedAt: Date.now() };
    }
  }

  private async refreshIndustrial(): Promise<void> {
    const item = await fetchIndustrialRss(this.registry, this.opts);
    if (item) {
      this.industrial = { ...item, fetchedAt: Date.now() };
    }
  }

  private async refreshSports(): Promise<void> {
    const sports = await fetchEspnScoreboard(this.registry, this.opts);
    if (sports) {
      this.sports = sports;
    }
  }

  private async refreshTrades(): Promise<void> {
    const now = Date.now();
    const nextRetryAt = this.tradeFeedState.nextRetryAt;
    if (nextRetryAt !== null && now < nextRetryAt) return;

    const attemptStartedAt = now;
    this.tradeFeedState = {
      ...this.tradeFeedState,
      lastAttemptAt: attemptStartedAt,
      cachedTradeCount: this.trades.length,
    };

    try {
      const res = await fetchTrades({ limit: 100, fetchFn: this.opts.fetchFn });
      const fetchedAt = Date.now();
      this.trades = res.trades ?? [];
      this.tradesFetchedAt = fetchedAt;
      this.tradeFeedState = {
        status: 'ok',
        lastSuccessAt: fetchedAt,
        lastAttemptAt: attemptStartedAt,
        nextRetryAt: null,
        failureCount: 0,
        lastError: null,
        cachedTradeCount: this.trades.length,
        backoffMs: 0,
        lastWarningAt: this.tradeWarningAt || null,
      };
      this.registry.recordSuccess('kalshi-trades', fetchedAt - attemptStartedAt);
    } catch (e) {
      const failedAt = Date.now();
      const message = e instanceof Error ? e.message : String(e);
      const failureCount = this.tradeFeedState.failureCount + 1;
      const backoffMs = tradeBackoffMs(failureCount);
      const nextRetryAt = failedAt + backoffMs;
      const shouldWarn = this.tradeWarningAt === 0
        || failureCount === 1
        || failedAt - this.tradeWarningAt >= TRADE_WARNING_THROTTLE_MS;
      if (shouldWarn) {
        console.warn(
          '[feedhub] optional Kalshi trade tape degraded; using cached/no trade-flow theses:',
          `${message}; retry in ${Math.round(backoffMs / 1000)}s`,
        );
        this.tradeWarningAt = failedAt;
      }
      this.tradeFeedState = {
        status: 'degraded',
        lastSuccessAt: this.tradeFeedState.lastSuccessAt,
        lastAttemptAt: attemptStartedAt,
        nextRetryAt,
        failureCount,
        lastError: message,
        cachedTradeCount: this.trades.length,
        backoffMs,
        lastWarningAt: this.tradeWarningAt || null,
      };
      this.registry.recordDegraded(
        'kalshi-trades',
        `Trade tape degraded (${failureCount} failure${failureCount === 1 ? '' : 's'}): ${message}; retry in ${Math.round(backoffMs / 1000)}s`,
      );
      /* trades are optional - keep cached trade tape and leave Kalshi REST errors to required callers */
    }
  }

  private async refreshKalshiWs(): Promise<void> {
    await pingKalshiWs(this.registry);
    this.kalshiWsAt = Date.now();
  }

  private async refreshPortfolioPing(): Promise<void> {
    await pingKalshiPortfolio(this.registry, this.kalshiApiKey ?? process.env.NEMESIS_KALSHI_API_KEY);
    this.portfolioPingAt = Date.now();
  }

  private async refreshEia(): Promise<void> {
    const result = await fetchEiaEnergy(
      this.registry,
      this.opts.eiaApiKey ?? process.env.NEMESIS_EIA_API_KEY,
      this.opts,
    );
    if (result) this.eia = { ...result, fetchedAt: Date.now() };
    this.eiaAt = Date.now();
  }

  private async refreshSecEdgar(): Promise<void> {
    const result = await fetchSecEdgarHeadlines(this.registry, this.opts);
    if (result) this.secEdgar = { ...result, fetchedAt: Date.now() };
    this.secEdgarAt = Date.now();
  }

  getEiaSnapshot(): { series: string; value: number; period: string } | null {
    return this.eia;
  }

  getSecEdgarHeadline(): { title: string; link: string } | null {
    return this.secEdgar;
  }

  /** Helpers used by main.ts when building pod inputs */
  weatherInputFor(market: KalshiMarket) {
    const wx = this.weather;
    const strike = parseTemperatureStrike(market.title);
    return {
      strike,
      nwsForecast: wx?.nws ?? strike,
      openMeteoForecast: wx?.openMeteo ?? strike,
      hoursToSettle: hoursToSettle(market),
    };
  }

  cryptoInputFor(market: KalshiMarket, marketPrice: number) {
    const symbol = parseCryptoSymbol(market.title, market.ticker);
    const live = this.binance.getQuote(symbol);
    const snap = this.crypto.get(symbol);
    const strike = parseBtcStrike(market.title);
    const binanceQuote = live ?? this.snapshotToBinanceQuote(symbol, snap);
    return {
      symbol,
      spotPrice: binanceQuote?.price ?? strike,
      strike,
      lagMs: binanceQuote?.lagMs ?? 0,
      kalshiImpliedSpot: marketPrice * strike,
      binanceQuote,
    };
  }

  private snapshotToBinanceQuote(symbol: string, snap: CryptoSnapshot | undefined): BinanceQuote | undefined {
    if (!snap) return undefined;
    return {
      symbol,
      price: snap.spotPrice,
      lagMs: snap.lagMs,
      fetchedAt: snap.fetchedAt,
      momentumBps: snap.momentumBps ?? 0,
      volatilityBps: snap.volatilityBps ?? 0,
      sampleCount: snap.sampleCount ?? 1,
      windowMs: snap.windowMs ?? 0,
    };
  }

  macroInputFor(market: KalshiMarket) {
    const macro = this.macro;
    return {
      releaseName: macro?.releaseName ?? 'CPI',
      consensus: parseCpiStrike(market.title),
      actual: macro?.actual,
      minutesToRelease: macro?.minutesToRelease ?? minutesToNextCpiRelease(),
    };
  }

  globalNewsFor(market: KalshiMarket): NewsItem {
    const shared = this.gdeltCache.get(SHARED_GDELT_QUERY)?.news;
    if (shared) return { ...shared, title: shared.title.slice(0, 120) };
    const query = gdeltQueryFromTitle(market.title);
    const cached = this.gdeltCache.get(query)?.news;
    if (cached) return cached;
    const industrial = this.industrial;
    if (industrial) {
      return {
        title: industrial.headline,
        url: industrial.url,
        category: 'industrial',
        severity: 0.35,
      };
    }
    const nhc = this.nhc;
    if (nhc?.active) {
      return { title: nhc.summary, url: 'https://www.nhc.noaa.gov', category: 'weather', severity: 0.5 };
    }
    return {
      title: `Monitoring: ${market.title.slice(0, 60)}`,
      url: '',
      category: market.category ?? 'general',
      severity: 0.2,
    };
  }
}
