import {
  fetchMarkets,
  fetchOrderbook,
  KalshiRequestFailure,
  normalizeMarketPrice,
  getTierThresholds,
  verifySideDepth,
  type DiscoverySettings,
  type DiscoveryState,
  type DiscoveryMetrics,
  type DiscoveryMode,
  type TickerDepthResult,
  DEFAULT_DISCOVERY_SETTINGS,
  PRESET_OVERRIDES,
  type KalshiMarket,
  type KalshiOrderbook,
  type KalshiResponseMetadata,
} from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';
import {
  hasExecutableMarketQuote,
  marketLiquidityScore,
  selectExecutableMarkets,
} from './kalshiLiquidity.js';

const UNIVERSE_STALE_MS = 5 * 60_000;
const ORDERBOOK_TTL_MS = 12_000;
const REST_DEPTH_FALLBACK_PER_CYCLE = 8;
const MAX_UNIVERSE_PAGES = 50;
const MIN_EXECUTABLE_UNIVERSE = 25;

/**
 * Optional operator lever: restrict the discovered universe to markets whose
 * ticker begins with one of these series prefixes (comma-separated, e.g.
 * "KXINXHUD,KXNASDAQ100HUD,KXBTCD"). Lets the whole pipeline be pointed at a
 * chosen instrument set -- e.g. continuously-liquid financial-index or
 * crypto-daily markets whose pace suits the persistence-confirmation model --
 * without code changes. Unset means no restriction (the historical behaviour).
 * Read from env on every check (not module-load freeze) so a correctly launched
 * Electron process is never stuck with a null allowlist after a bad Start-Process
 * env handoff — and so tests can set the env mid-suite.
 */
function seriesAllowlistPrefixes(): readonly string[] | null {
  const raw = process.env.NEMESIS_SERIES_ALLOWLIST?.trim();
  if (!raw) return null;
  const list = raw.split(',').map((entry) => entry.trim().toUpperCase()).filter(Boolean);
  return list.length ? list : null;
}

/**
 * Optional operator cut-list: reject tickers whose prefix matches
 * NEMESIS_SERIES_DENYLIST (comma-separated). Applied even when no allowlist is
 * set, so a single losing series (e.g. KXETHD) can be removed without rewriting
 * the whole allowlist. Read dynamically like the allowlist.
 */
function seriesDenylistPrefixes(): readonly string[] {
  const raw = process.env.NEMESIS_SERIES_DENYLIST?.trim();
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim().toUpperCase()).filter(Boolean);
}

function tickerDeniedBySeries(ticker: string): boolean {
  const denylist = seriesDenylistPrefixes();
  if (denylist.length === 0) return false;
  const upper = ticker.toUpperCase();
  return denylist.some((prefix) => upper.startsWith(prefix));
}

/** True when a series allowlist env is configured (any non-empty prefix list). */
export function seriesAllowlistConfigured(): boolean {
  return seriesAllowlistPrefixes() != null;
}

/** True when a series denylist env is configured. */
export function seriesDenylistConfigured(): boolean {
  return seriesDenylistPrefixes().length > 0;
}

/** True when the market passes the series allowlist (or none is configured) and is not denylisted. */
export function withinSeriesAllowlist(market: Pick<KalshiMarket, 'ticker'>): boolean {
  if (tickerDeniedBySeries(market.ticker)) return false;
  const allowlist = seriesAllowlistPrefixes();
  if (!allowlist) return true;
  const ticker = market.ticker.toUpperCase();
  return allowlist.some((prefix) => ticker.startsWith(prefix));
}

/** True when a raw ticker string passes the series allowlist and is not denylisted. */
export function tickerWithinSeriesAllowlist(ticker: string): boolean {
  if (tickerDeniedBySeries(ticker)) return false;
  const allowlist = seriesAllowlistPrefixes();
  if (!allowlist) return true;
  const upper = ticker.toUpperCase();
  return allowlist.some((prefix) => upper.startsWith(prefix));
}

export interface ProductionUniverseRecord {
  market: KalshiMarket;
  sourceBaseUrl: string;
  verifiedAt: number;
}

export class DiscoveryOrchestrator {
  settings: DiscoverySettings = { ...DEFAULT_DISCOVERY_SETTINGS };
  private universe: KalshiMarket[] = [];
  private liveUniverseLoaded = false;
  private universeUpdatedAt = 0;
  private universePages = 0;
  private depthByTicker = new Map<string, TickerDepthResult>();
  private orderbookCache = new Map<string, { book: Awaited<ReturnType<typeof fetchOrderbook>>; at: number }>();
  private paused = false;
  private depthPending = 0;
  private depthVerifiedCycle = 0;
  private orderbooksThisCycle = 0;
  private bookMsTotal = 0;
  private bookMsCount = 0;
  private belowScout = 0;
  private mode: DiscoveryMode = 'full';
  private depthPassInFlight: Promise<void> | null = null;
  private restDepthCursor = 0;
  private productionUniverseRecords: ProductionUniverseRecord[] = [];

  constructor(private registry: ConnectorRegistry) {}

  loadSettings(raw: Partial<DiscoverySettings> | null) {
    if (!raw) return;
    this.settings = { ...DEFAULT_DISCOVERY_SETTINGS, ...raw };
    this.applyPreset(this.settings.preset);
  }

  applyPreset(preset: DiscoverySettings['preset']) {
    const overrides = PRESET_OVERRIDES[preset] ?? {};
    this.settings = { ...this.settings, preset, ...overrides };
  }

  updateSettings(partial: Partial<DiscoverySettings>) {
    this.settings = { ...this.settings, ...partial };
    if (partial.preset) this.applyPreset(partial.preset);
  }

  pause() {
    this.paused = true;
    this.mode = 'frozen';
  }

  resume() {
    this.paused = false;
    this.mode = this.settings.depthVerifyEnabled
      ? (this.settings.signalPassEnabled ? 'full' : 'depth-only')
      : 'legacy';
  }

  getUniverse(): KalshiMarket[] {
    return this.universe;
  }

  hasLiveUniverse(): boolean {
    return this.liveUniverseLoaded;
  }

  getDepth(ticker: string): TickerDepthResult | undefined {
    return this.depthByTicker.get(ticker);
  }

  getMarketsForSignals(): KalshiMarket[] {
    if (!this.settings.depthVerifyEnabled) {
      return this.universe.slice(0, 75);
    }
    const qualified = this.universe.filter((m) => {
      const d = this.depthByTicker.get(m.ticker);
      if (!d) return false;
      return d.yes?.executableTier != null || d.no?.executableTier != null;
    });
    if (qualified.length > 0) return qualified;
    return this.universe.slice(0, Math.min(30, this.universe.length));
  }

  /** Put active trade-tape markets first so the existing depth pass verifies their books. */
  prioritizeMarkets(markets: KalshiMarket[]): KalshiMarket[] {
    const seen = new Set<string>();
    const prioritized = markets.filter((market) => {
      if (seen.has(market.ticker)) return false;
      seen.add(market.ticker);
      const status = market.status.toLowerCase();
      return (status === 'active' || status === 'open')
        && marketLiquidityScore(market) > 0
        && hasExecutableMarketQuote(market);
    });
    if (prioritized.length === 0) return this.universe;

    const priorityTickers = new Set(prioritized.map((market) => market.ticker));
    this.universe = [
      ...prioritized,
      ...this.universe.filter((market) => !priorityTickers.has(market.ticker)),
    ].slice(0, this.settings.maxTrackedTickers);
    return this.universe;
  }

  getProductionUniverseRecords(): ProductionUniverseRecord[] {
    return this.productionUniverseRecords.map((record) => ({ ...record, market: { ...record.market } }));
  }

  getMicrostructure(ticker: string, fallbackPrice: number) {
    const d = this.depthByTicker.get(ticker);
    if (d) return { spread: d.spread, depthUsd: d.depthUsd };
    const cached = this.orderbookCache.get(ticker);
    if (cached && Date.now() - cached.at < ORDERBOOK_TTL_MS) {
      const book = cached.book;
      const yesBid = book.yes[0]?.price ?? fallbackPrice;
      const yesAsk = book.yesAsk ?? book.yes[book.yes.length - 1]?.price ?? fallbackPrice;
      const spread = book.spread ?? Math.max(0.01, Math.abs(yesAsk - yesBid));
      const depthUsd = (book.yes[0]?.quantity ?? 50) * fallbackPrice;
      return { spread, depthUsd };
    }
    return { spread: 0.04, depthUsd: 200 };
  }

  /** Reuse authenticated sequenced WebSocket books for discovery depth. */
  ingestOrderbook(book: KalshiOrderbook): void {
    const market = this.universe.find((candidate) => candidate.ticker === book.ticker);
    if (!market) return;
    const now = Date.now();
    this.orderbookCache.set(book.ticker, { book, at: now });
    this.recordDepth(market, book, now);
  }

  async refreshUniverse(signal?: AbortSignal): Promise<KalshiMarket[]> {
    if (this.paused) return this.universe;
    const start = Date.now();
    const merged: KalshiMarket[] = [];
    const productionByTicker = new Map<string, ProductionUniverseRecord>();
    let pages = 0;
    const allowlist = seriesAllowlistPrefixes();
    try {
      const ingestPage = (
        pageMarkets: KalshiMarket[],
        responseMetadata: KalshiResponseMetadata | null,
      ) => {
        merged.push(...pageMarkets);
        if (responseMetadata?.environment === 'production' && responseMetadata.status === 200) {
          for (const market of pageMarkets) {
            productionByTicker.set(market.ticker, {
              market: { ...market },
              sourceBaseUrl: responseMetadata.sourceBaseUrl,
              verifiedAt: responseMetadata.verifiedAt,
            });
          }
        }
      };

      if (allowlist) {
        // Prefix allowlists are a handful of series. Client-side filtering of the
        // global /markets stream pages past sports/parlays and often never reaches
        // KXBTCD/HUD within MAX_UNIVERSE_PAGES — leaving force-fill with zero
        // inventory and an empty track set. Query each series directly.
        for (const seriesTicker of allowlist) {
          let cursor: string | undefined;
          let seriesPages = 0;
          do {
            let responseMetadata: KalshiResponseMetadata | null = null;
            const res = await fetchMarkets({
              limit: this.settings.universePageSize,
              status: 'open',
              cursor,
              seriesTicker,
              signal,
              onResponseMetadata: (metadata) => { responseMetadata = metadata; },
            });
            ingestPage(res.markets.filter(withinSeriesAllowlist), responseMetadata);
            cursor = res.cursor;
            seriesPages += 1;
            pages += 1;
            if (pages === 1) {
              this.registry.recordSuccess('kalshi-rest', Date.now() - start);
            }
            if (!cursor || seriesPages >= MAX_UNIVERSE_PAGES) break;
          } while (true);
        }
      } else {
        let cursor: string | undefined;
        do {
          let responseMetadata: KalshiResponseMetadata | null = null;
          const res = await fetchMarkets({
            limit: this.settings.universePageSize,
            status: 'open',
            cursor,
            signal,
            onResponseMetadata: (metadata) => { responseMetadata = metadata; },
          });
          ingestPage(res.markets, responseMetadata);
          cursor = res.cursor;
          pages += 1;
          // Record success on the first successful page so kalshi-rest exits
          // "idle" within ~1-2 s of startup rather than waiting for all pages.
          if (pages === 1) {
            this.registry.recordSuccess('kalshi-rest', Date.now() - start);
          }
          const executableCount = selectExecutableMarkets(merged).length;
          // Kalshi may return long runs of newly-created, zero-volume
          // combination markets before liquid live markets. Keep paging until
          // the exact orderbook readiness minimum is available; do not let a
          // shallow page cap manufacture an empty live universe.
          if (!cursor || executableCount >= Math.min(this.settings.maxTrackedTickers, MIN_EXECUTABLE_UNIVERSE)) break;
        } while (pages < MAX_UNIVERSE_PAGES);
      }

      this.registry.recordSuccess('kalshi-rest', Date.now() - start);
      // Focused series allowlists are often thin overnight and Kalshi's markets
      // listing leaves volume_24h at 0 for most rows. selectExecutableMarkets
      // then returns [] (liquidityScore>0 gate), so force-fill had nothing to
      // subscribe and track sets stuck at 1 via priority-track only. Under an
      // allowlist, keep every open market that still shows an executable quote;
      // volume ranking remains the default for the unfocused universe.
      this.universe = (allowlist
        ? merged
          .filter((market) => {
            const status = market.status.toLowerCase();
            return (status === 'active' || status === 'open') && hasExecutableMarketQuote(market);
          })
          .sort((left, right) => {
            const volumeDelta = marketLiquidityScore(right) - marketLiquidityScore(left);
            if (volumeDelta !== 0) return volumeDelta;
            return left.ticker.localeCompare(right.ticker);
          })
        : selectExecutableMarkets(merged)
      ).slice(0, this.settings.maxTrackedTickers);
      this.productionUniverseRecords = this.universe
        .map((market) => productionByTicker.get(market.ticker))
        .filter((record): record is ProductionUniverseRecord => record != null);
      this.universeUpdatedAt = Date.now();
      this.universePages = pages;
      this.liveUniverseLoaded = true;
    } catch (e) {
      this.registry.recordError(
        'kalshi-rest',
        e instanceof Error ? e.message : String(e),
        e instanceof KalshiRequestFailure ? e.classification : undefined,
        e instanceof KalshiRequestFailure ? e.retryAfterMs : undefined,
      );
      if (!this.liveUniverseLoaded || Date.now() - this.universeUpdatedAt > UNIVERSE_STALE_MS) {
        throw e;
      }
    }
    return this.universe;
  }

  runDepthPass(): Promise<void> {
    if (this.depthPassInFlight) return this.depthPassInFlight;
    this.depthPassInFlight = this.runDepthPassOnce().finally(() => {
      this.depthPassInFlight = null;
    });
    return this.depthPassInFlight;
  }

  private async runDepthPassOnce(): Promise<void> {
    if (this.paused) return;
    if (!this.settings.depthVerifyEnabled) {
      this.mode = 'legacy';
      return;
    }
    if (this.settings.autoPauseOnApiDegrade && this.registry.get('kalshi-rest')?.status === 'error') {
      this.mode = 'depth-only';
      return;
    }

    this.depthVerifiedCycle = 0;
    this.orderbooksThisCycle = 0;
    this.bookMsTotal = 0;
    this.bookMsCount = 0;
    this.belowScout = 0;

    const configuredCandidates = this.universe.slice(0, this.settings.depthChecksPerCycle);
    const now = Date.now();
    const cachedCandidates = configuredCandidates.filter((market) => {
      const cached = this.orderbookCache.get(market.ticker);
      return cached != null && now - cached.at < ORDERBOOK_TTL_MS;
    });
    const cachedTickers = new Set(cachedCandidates.map((market) => market.ticker));
    const missingCandidates = configuredCandidates.filter((market) => !cachedTickers.has(market.ticker));
    const restFallbackCandidates: KalshiMarket[] = [];
    if (missingCandidates.length > 0) {
      const fallbackCount = Math.min(REST_DEPTH_FALLBACK_PER_CYCLE, missingCandidates.length);
      const start = this.restDepthCursor % missingCandidates.length;
      for (let offset = 0; offset < fallbackCount; offset += 1) {
        restFallbackCandidates.push(missingCandidates[(start + offset) % missingCandidates.length]!);
      }
      this.restDepthCursor = (start + fallbackCount) % missingCandidates.length;
    }
    const candidates = [
      ...cachedCandidates.map((market) => ({ market, fromCache: true })),
      ...restFallbackCandidates.map((market) => ({ market, fromCache: false })),
    ];
    this.depthPending = missingCandidates.length;

    // Fetch orderbooks in parallel batches (sequential was 150 × ~400ms ≈ 60 s)
    const CONCURRENCY = 8;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      if (this.orderbooksThisCycle >= this.settings.depthChecksPerCycle) break;
      const batch = candidates.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async ({ market: m, fromCache }) => {
        const t0 = Date.now();
        let book;
        try {
          book = await this.fetchBookCached(m.ticker);
        } catch {
          if (!fromCache) this.depthPending = Math.max(0, this.depthPending - 1);
          return;
        }
        this.orderbooksThisCycle += 1;
        this.bookMsTotal += Date.now() - t0;
        this.bookMsCount += 1;

        this.recordDepth(m, book, Date.now());
        const recorded = this.depthByTicker.get(m.ticker);
        if (recorded?.yes?.executableTier == null && recorded?.no?.executableTier == null) this.belowScout += 1;
        this.depthVerifiedCycle += 1;
        if (!fromCache) this.depthPending = Math.max(0, this.depthPending - 1);
      }));
    }

    this.mode = this.settings.signalPassEnabled ? 'full' : 'depth-only';
  }

  seedFixtureDepth(markets: KalshiMarket[]) {
    this.universe = markets;
    this.liveUniverseLoaded = false;
    this.universeUpdatedAt = Date.now();
    this.universePages = markets.length > 0 ? 1 : 0;
    this.depthPending = 0;
    this.mode = this.settings.signalPassEnabled ? 'full' : 'depth-only';
    for (const m of markets) {
      const scout = {
        executableTier: 'scout' as const,
        fillableUsd: 150,
        slippagePp: 0.01,
        depthLevels: 3,
      };
      this.depthByTicker.set(m.ticker, {
        ticker: m.ticker,
        spread: 0.03,
        depthUsd: 400,
        verifiedAt: Date.now(),
        yes: scout,
        no: { ...scout, fillableUsd: 120 },
      });
    }
  }

  getState(): DiscoveryState {
    const depths = [...this.depthByTicker.values()];
    let scout = 0;
    let solid = 0;
    let whale = 0;
    for (const d of depths) {
      const tiers = [d.yes?.executableTier, d.no?.executableTier].filter(Boolean);
      if (tiers.includes('whale')) whale += 1;
      else if (tiers.includes('solid')) solid += 1;
      else if (tiers.includes('scout')) scout += 1;
    }

    const metrics: DiscoveryMetrics = {
      trackedTickers: this.universe.length,
      universePages: this.universePages,
      universeAgeSec: this.universeUpdatedAt ? Math.round((Date.now() - this.universeUpdatedAt) / 1000) : 0,
      depthPending: this.depthPending,
      depthVerifiedCycle: this.depthVerifiedCycle,
      avgBookMs: this.bookMsCount ? Math.round(this.bookMsTotal / this.bookMsCount) : 0,
      scoutCount: scout,
      solidCount: solid,
      whaleCount: whale,
      belowScout: this.belowScout,
      orderbooksThisCycle: this.orderbooksThisCycle,
      orderbookBudget: this.settings.depthChecksPerCycle,
      mode: this.paused ? 'frozen' : this.mode,
      paused: this.paused,
    };

    return { settings: { ...this.settings }, metrics };
  }

  private async fetchBookCached(ticker: string) {
    const cached = this.orderbookCache.get(ticker);
    if (cached && Date.now() - cached.at < ORDERBOOK_TTL_MS) return cached.book;
    const book = await fetchOrderbook(ticker);
    this.orderbookCache.set(ticker, { book, at: Date.now() });
    return book;
  }

  private recordDepth(market: KalshiMarket, book: KalshiOrderbook, verifiedAt: number): void {
    const price = normalizeMarketPrice(market);
    const yesBid = book.yes[0]?.price ?? price;
    const yesAsk = book.yesAsk ?? book.yes[book.yes.length - 1]?.price ?? price;
    const spread = book.spread ?? Math.max(0.01, Math.abs(yesAsk - yesBid));
    const depthUsd = (book.yes[0]?.quantity ?? 50) * price;
    const thresholds = getTierThresholds(this.settings.preset);
    this.depthByTicker.set(market.ticker, {
      ticker: market.ticker,
      spread,
      depthUsd,
      verifiedAt,
      yes: verifySideDepth(book, 'yes', price, thresholds),
      no: verifySideDepth(book, 'no', 1 - price, thresholds),
    });
  }
}
