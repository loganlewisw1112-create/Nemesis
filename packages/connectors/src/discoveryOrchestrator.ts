import {
  fetchMarkets,
  fetchOrderbook,
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
} from '@nemesis/core';
import type { ConnectorRegistry } from './registry.js';

const UNIVERSE_STALE_MS = 5 * 60_000;
const ORDERBOOK_TTL_MS = 12_000;

export class DiscoveryOrchestrator {
  settings: DiscoverySettings = { ...DEFAULT_DISCOVERY_SETTINGS };
  private universe: KalshiMarket[] = [];
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

  async refreshUniverse(): Promise<KalshiMarket[]> {
    if (this.paused) return this.universe;
    const start = Date.now();
    const merged: KalshiMarket[] = [];
    let cursor: string | undefined;
    let pages = 0;
    try {
      do {
        const res = await fetchMarkets({
          limit: this.settings.universePageSize,
          status: 'open',
          cursor,
        });
        merged.push(...res.markets);
        cursor = res.cursor;
        pages += 1;
        // Record success on the first successful page so kalshi-rest exits
        // "idle" within ~1-2 s of startup rather than waiting for all pages.
        if (pages === 1) {
          this.registry.recordSuccess('kalshi-rest', Date.now() - start);
        }
        if (!cursor || merged.length >= this.settings.maxTrackedTickers * 2) break;
      } while (pages < 10);

      this.registry.recordSuccess('kalshi-rest', Date.now() - start);
      this.universe = merged
        .sort((a, b) => (b.volume_24h ?? b.volume ?? 0) - (a.volume_24h ?? a.volume ?? 0))
        .slice(0, this.settings.maxTrackedTickers);
      this.universeUpdatedAt = Date.now();
      this.universePages = pages;
    } catch (e) {
      this.registry.recordError('kalshi-rest', e instanceof Error ? e.message : String(e));
      if (this.universe.length === 0 || Date.now() - this.universeUpdatedAt > UNIVERSE_STALE_MS) {
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

    const thresholds = getTierThresholds(this.settings.preset);
    const candidates = this.universe.slice(0, this.settings.depthChecksPerCycle);
    this.depthPending = candidates.length;

    // Fetch orderbooks in parallel batches (sequential was 150 × ~400ms ≈ 60 s)
    const CONCURRENCY = 8;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      if (this.orderbooksThisCycle >= this.settings.depthChecksPerCycle) break;
      const batch = candidates.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async (m) => {
        const p = normalizeMarketPrice(m);
        const t0 = Date.now();
        let book;
        try {
          book = await this.fetchBookCached(m.ticker);
        } catch {
          this.depthPending = Math.max(0, this.depthPending - 1);
          return;
        }
        this.orderbooksThisCycle += 1;
        this.bookMsTotal += Date.now() - t0;
        this.bookMsCount += 1;

        const yesBid = book.yes[0]?.price ?? p;
        const yesAsk = book.yesAsk ?? book.yes[book.yes.length - 1]?.price ?? p;
        const spread = book.spread ?? Math.max(0.01, Math.abs(yesAsk - yesBid));
        const depthUsd = (book.yes[0]?.quantity ?? 50) * p;

        const yes = verifySideDepth(book, 'yes', p, thresholds);
        const no = verifySideDepth(book, 'no', 1 - p, thresholds);

        if (yes.executableTier == null && no.executableTier == null) this.belowScout += 1;

        this.depthByTicker.set(m.ticker, {
          ticker: m.ticker,
          spread,
          depthUsd,
          verifiedAt: Date.now(),
          yes,
          no,
        });
        this.depthVerifiedCycle += 1;
        this.depthPending = Math.max(0, candidates.length - this.depthVerifiedCycle);
      }));
    }

    this.mode = this.settings.signalPassEnabled ? 'full' : 'depth-only';
  }

  seedFixtureDepth(markets: KalshiMarket[]) {
    this.universe = markets;
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
}
