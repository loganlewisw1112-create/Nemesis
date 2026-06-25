for (const stream of [process.stdout, process.stderr] as const) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
    throw err;
  });
}
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return;
  throw err;
});

import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer, WebSocket as WsSocket, type RawData } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { validateBridgeMessage, type BridgeStatus, type NemesisBridgeMessage } from '@nemesis/bridge-contracts';
import {
  DEFAULT_GUARDRAILS,
  DEFAULT_PAPER_CASH,
  fetchOrderbook,
  normalizeMarketPrice,
  evaluateGates,
  canEnableLive,
  rankTheses,
  detectNoTradeRegimes,
  shouldShutdownSession,
  computeNetEdge,
  DEFAULT_SHUTDOWN_COUNTERS,
  recordInvalidation,
  recordAbnormalExecution,
  resetInvalidationStreak,
  recordManualOverride,
  applyApiDegradedElapsed,
  isRiskSettingOverride,
  rankThesesWithTiers,
  minNetEdgeForTier,
  type DiscoverySettings,
  type GuardrailSettings,
  type ThesisCard,
  type KalshiMarket,
  type PriceTick,
  type PaperPortfolio,
  type SessionStats,
  type PaperOrder,
  type GeoMarket,
  type WorldEventsPayload,
} from '@nemesis/core';
import { ConnectorRegistry, FeedHub, KalshiStream, isCryptoMarket, isMacroMarket, isSportsMarket, isWeatherMarket, inferMarketGeo } from '@nemesis/connectors';
import { JournalStore } from '@nemesis/journal';
import {
  dryRunFill,
  PaperDesk,
  simulatePaperBuy,
  simulatePaperClose,
  checkPaperRisk,
  resolveContractCount,
  AuditLog,
  PaperOrderBook,
  runFeeAwareBacktest,
  cancelAllLiveOrders,
  reconcileLiveBook,
  createLiveOrderRequest,
  submitLiveOrder,
  type LiveCredentials,
} from '@nemesis/execution';
import { StrategyQuarantine } from '@nemesis/capital';
import { tradeToThesis, weatherToThesis, macroToThesis, cryptoToThesis, globalToThesis, infraToThesis, sportsToThesis, releaseRadarWarning, scanMarketTheses } from '@nemesis/pods';
import { DiscoveryOrchestrator } from './discovery.js';

if (process.env.NEMESIS_E2E_USER_DATA) {
  app.setPath('userData', process.env.NEMESIS_E2E_USER_DATA);
}

const DATA_DIR = path.join(app.getPath('userData'), 'nemesis-data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const JOURNAL_PATH = path.join(DATA_DIR, 'journal.json');
const PAPER_PATH = path.join(DATA_DIR, 'paper-portfolio.json');
const EQUITY_HISTORY_PATH = path.join(DATA_DIR, 'equity-history.json');
const SESSION_STATS_PATH = path.join(DATA_DIR, 'session-stats.json');
const PAPER_ORDERS_PATH = path.join(DATA_DIR, 'paper-orders.json');
const AUDIT_PATH = path.join(DATA_DIR, 'audit-log.json');
const DISCOVERY_SETTINGS_PATH = path.join(DATA_DIR, 'discovery-settings.json');

const MAX_TICKS = 120;
const PAPER_OK = new Set(['tradeable', 'qualified', 'watch-only']);
const MARKET_REFRESH_MS = 15_000;
const WATCHED_TICK_MS = 1_000;
const FEED_WAIT_MS = 2_000;

app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');

let mainWindow: BrowserWindow | null = null;
const widgetWindows = new Set<BrowserWindow>();
const registry = new ConnectorRegistry();
const discovery = new DiscoveryOrchestrator(registry);
const feedHub = new FeedHub(registry);
const kalshiStream = new KalshiStream(registry);
const journal = new JournalStore();
const quarantine = new StrategyQuarantine();
let settings: GuardrailSettings = { ...DEFAULT_GUARDRAILS };
let theses: ThesisCard[] = [];
let reviewOnly = false;
let marketsCache: KalshiMarket[] = [];
const paperDesk = new PaperDesk(DEFAULT_PAPER_CASH);
const paperOrderBook = new PaperOrderBook();
const auditLog = new AuditLog();
const tickHistory = new Map<string, PriceTick[]>();
let watchedTicker: string | null = null;
let activeRegimes: string[] = [];
let sessionStatsData: SessionStats = {
  dayStart: Date.now(),
  dailyPnl: 0,
  tradeCount: 0,
  abortCount: 0,
  startingEquity: DEFAULT_PAPER_CASH,
};
let equityHistory: { t: number; equity: number; deployed: number; cash: number }[] = [
  { t: Date.now(), equity: DEFAULT_PAPER_CASH, deployed: 0, cash: DEFAULT_PAPER_CASH },
];
let lastApiHealthTickAt = Date.now();

// Bridge WebSocket server (port 7430)
const bridgeClients = new Set<WsSocket>();
let bridgeSeq = 0;
let geaProcess: ChildProcess | null = null;
const bridgeStatus: BridgeStatus = {
  connected: false,
  brainRole: null,
  lastSeenAt: null,
  clientCount: 0,
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getShutdownCounters() {
  return sessionStatsData.shutdown ?? { ...DEFAULT_SHUTDOWN_COUNTERS };
}

function ensureShutdownCounters() {
  if (!sessionStatsData.shutdown) {
    sessionStatsData.shutdown = { ...DEFAULT_SHUTDOWN_COUNTERS };
  }
  return sessionStatsData.shutdown;
}

function recordDryRunInvalidation() {
  recordInvalidation(ensureShutdownCounters());
  saveSessionStats();
}

function recordDryRunAbnormalExecution() {
  recordAbnormalExecution(ensureShutdownCounters());
  saveSessionStats();
}

function resetDryRunInvalidationStreak() {
  const shutdown = ensureShutdownCounters();
  if (shutdown.consecutiveInvalidations === 0) return;
  resetInvalidationStreak(shutdown);
  saveSessionStats();
}

function recordSettingsManualOverride() {
  recordManualOverride(ensureShutdownCounters());
  saveSessionStats();
}

function tickApiHealthDegraded() {
  const now = Date.now();
  const elapsed = now - lastApiHealthTickAt;
  lastApiHealthTickAt = now;
  const degraded = !registry.isHealthy('kalshi-rest');
  const shutdown = ensureShutdownCounters();
  const before = shutdown.apiDegradedMinutes;
  applyApiDegradedElapsed(shutdown, degraded, elapsed);
  if (shutdown.apiDegradedMinutes !== before) saveSessionStats();
}

function loadSettings() {
  ensureDataDir();
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = { ...DEFAULT_GUARDRAILS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  }
}

function saveSettings() {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function loadDiscoverySettings() {
  ensureDataDir();
  if (fs.existsSync(DISCOVERY_SETTINGS_PATH)) {
    try {
      discovery.loadSettings(JSON.parse(fs.readFileSync(DISCOVERY_SETTINGS_PATH, 'utf8')));
    } catch {
      /* keep defaults */
    }
  }
}

function saveDiscoverySettings() {
  ensureDataDir();
  fs.writeFileSync(DISCOVERY_SETTINGS_PATH, JSON.stringify(discovery.settings, null, 2));
}

function broadcastDiscovery() {
  broadcast('discovery:update', discovery.getState());
}

function buildWorldEventsPayload(): WorldEventsPayload {
  const geoNews = feedHub.getWorldNews();
  const geoMarkets: GeoMarket[] = [];
  for (const t of theses) {
    const market = marketsCache.find((m) => m.ticker === t.ticker);
    if (!market) continue;
    const geo = inferMarketGeo(market);
    if (!geo) continue;
    geoMarkets.push({
      ticker: t.ticker,
      title: t.title,
      category: t.category,
      marketPrice: t.marketPrice,
      netEdge: t.netEdge,
      status: t.status,
      lat: geo.lat,
      lon: geo.lon,
      countryCode: geo.countryCode,
      thesisId: t.id,
    });
  }
  const heatData: Record<string, number> = {};
  for (const n of geoNews) {
    heatData[n.countryCode] = Math.max(heatData[n.countryCode] ?? 0, n.severity);
  }
  for (const m of geoMarkets) {
    if (m.netEdge > 0) {
      heatData[m.countryCode] = Math.min(1, (heatData[m.countryCode] ?? 0) + 0.2);
    }
  }
  return { geoNews, geoMarkets, heatData, lastUpdated: Date.now() };
}

function broadcastWorldEvents() {
  broadcast('worldevents:update', buildWorldEventsPayload());
}

function loadJournal() {
  ensureDataDir();
  if (fs.existsSync(JOURNAL_PATH)) {
    try {
      journal.load(JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')));
    } catch {
      /* keep empty */
    }
  }
}

function loadEquityHistory() {
  ensureDataDir();
  if (fs.existsSync(EQUITY_HISTORY_PATH)) {
    try {
      equityHistory = JSON.parse(fs.readFileSync(EQUITY_HISTORY_PATH, 'utf8'));
    } catch {
      /* keep default */
    }
  }
}

function saveEquityHistory() {
  ensureDataDir();
  fs.writeFileSync(EQUITY_HISTORY_PATH, JSON.stringify(equityHistory, null, 2));
}

function loadSessionStats() {
  ensureDataDir();
  if (fs.existsSync(SESSION_STATS_PATH)) {
    try {
      sessionStatsData = { ...sessionStatsData, ...JSON.parse(fs.readFileSync(SESSION_STATS_PATH, 'utf8')) };
    } catch {
      /* keep default */
    }
  }
  if (!isSameDay(sessionStatsData.dayStart)) {
    resetDailySession();
  }
}

function saveSessionStats() {
  ensureDataDir();
  fs.writeFileSync(SESSION_STATS_PATH, JSON.stringify(sessionStatsData, null, 2));
}

function loadPaperOrders() {
  ensureDataDir();
  if (fs.existsSync(PAPER_ORDERS_PATH)) {
    try {
      paperOrderBook.load(JSON.parse(fs.readFileSync(PAPER_ORDERS_PATH, 'utf8')));
    } catch {
      /* keep empty */
    }
  }
}

function savePaperOrders() {
  ensureDataDir();
  fs.writeFileSync(PAPER_ORDERS_PATH, JSON.stringify(paperOrderBook.snapshot(), null, 2));
}

function loadAuditLog() {
  ensureDataDir();
  if (fs.existsSync(AUDIT_PATH)) {
    try {
      auditLog.load(JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')));
    } catch {
      /* keep empty */
    }
  }
}

function saveAuditLog() {
  ensureDataDir();
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(auditLog.list(), null, 2));
}

function isSameDay(ts: number): boolean {
  const a = new Date(ts);
  const b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function resetDailySession() {
  const marks = getMarkPrices();
  const { equity } = paperDesk.markToMarket(marks);
  sessionStatsData = {
    dayStart: Date.now(),
    dailyPnl: 0,
    tradeCount: 0,
    abortCount: 0,
    startingEquity: equity,
    shutdown: { ...DEFAULT_SHUTDOWN_COUNTERS },
  };
  saveSessionStats();
}

function getDailyPnl(): number {
  const marks = getMarkPrices();
  const { equity } = paperDesk.markToMarket(marks);
  return equity - sessionStatsData.startingEquity;
}

function refreshDailyPnl() {
  sessionStatsData.dailyPnl = getDailyPnl();
}

function loadPaperPortfolio() {
  ensureDataDir();
  if (fs.existsSync(PAPER_PATH)) {
    try {
      paperDesk.load(JSON.parse(fs.readFileSync(PAPER_PATH, 'utf8')) as PaperPortfolio);
    } catch {
      paperDesk.reset(DEFAULT_PAPER_CASH);
    }
  }
}

function savePaperPortfolio() {
  ensureDataDir();
  fs.writeFileSync(PAPER_PATH, JSON.stringify(paperDesk.snapshot(), null, 2));
}

function getMarkPrices(): Map<string, number> {
  const marks = new Map<string, number>();
  for (const t of theses) {
    marks.set(t.ticker, t.side === 'yes' ? t.marketPrice : 1 - t.marketPrice);
  }
  return marks;
}

function recordTick(ticker: string, yesPrice: number, spread: number, netEdge: number) {
  const tick: PriceTick = { t: Date.now(), yesPrice, spread, netEdge };
  const list = tickHistory.get(ticker) ?? [];
  list.push(tick);
  if (list.length > MAX_TICKS) list.shift();
  tickHistory.set(ticker, list);
  if (watchedTicker === ticker) {
    broadcast('ticks:update', { ticker, ticks: list });
  }
}

function snapshotEquity() {
  const marks = getMarkPrices();
  const { equity, deployed } = paperDesk.markToMarket(marks);
  const port = paperDesk.snapshot();
  equityHistory.push({ t: Date.now(), equity, deployed, cash: port.cash });
  if (equityHistory.length > 2000) equityHistory.shift();
  saveEquityHistory();
  refreshDailyPnl();
  saveSessionStats();
}

function fallbackBook(card: ThesisCard) {
  return {
    ticker: card.ticker,
    yes: [{ price: card.marketPrice, quantity: 500 }],
    no: [{ price: 1 - card.marketPrice, quantity: 500 }],
    yesAsk: card.marketPrice,
    noAsk: 1 - card.marketPrice,
    spread: card.spread,
  };
}

async function fetchBookForCard(card: ThesisCard) {
  try {
    const book = await fetchOrderbook(card.ticker);
    // Guarantee depth levels so paper fills never abort with "insufficient depth"
    if (book.yesAsk === undefined && book.yes.length === 0) book.yesAsk = card.marketPrice;
    if (book.noAsk === undefined && book.no.length === 0) book.noAsk = 1 - card.marketPrice;
    if (book.yes.length === 0) book.yes = [{ price: card.marketPrice, quantity: 500 }];
    if (book.no.length === 0) book.no = [{ price: 1 - card.marketPrice, quantity: 500 }];
    return book;
  } catch {
    return fallbackBook(card);
  }
}

function computeRegimeState(spread: number, depthUsd: number, freshnessMs: number, sourceDisagree: boolean) {
  refreshDailyPnl();
  const regime = detectNoTradeRegimes({
    spread,
    maxSpread: 0.08,
    depthUsd,
    minDepth: 50,
    freshnessMs,
    maxFreshnessMs: 120000,
    sourceDisagree,
    apiHealthy: registry.isHealthy('kalshi-rest'),
    dailyPnl: sessionStatsData.dailyPnl,
    dailyTarget: settings.dailyLossCapUsd,
    strategyDrawdown: sessionStatsData.dailyPnl < -settings.dailyLossCapUsd * 0.5,
  });
  activeRegimes = regime.active;
  const shutdown = shouldShutdownSession(getShutdownCounters());
  return { ...regime, reviewOnly: regime.reviewOnly || shutdown };
}

function finalizeThesis(card: ThesisCard): ThesisCard {
  if (quarantine.isFrozen(card.playbook)) return { ...card, status: 'blocked' };
  if (reviewOnly && !settings.demoMode) return { ...card, status: 'observe' };
  if (
    settings.demoMode
    && card.netEdge >= 0.008
    && !['blocked', 'stale'].includes(card.status)
  ) {
    return { ...card, status: 'tradeable' };
  }
  return card;
}

function applyKalshiQuote(ticker: string, yesPrice: number, spread: number) {
  let changed = false;
  theses = theses.map((t) => {
    if (t.ticker !== ticker) return t;
    changed = true;
    const marketPrice = t.side === 'yes' ? yesPrice : 1 - yesPrice;
    const edge = computeNetEdge(t.impliedPrice, marketPrice, spread);
    return {
      ...t,
      marketPrice,
      spread,
      grossEdge: edge.grossEdge,
      netEdge: edge.netEdge,
      feeEstimate: edge.feeCost,
      updatedAt: Date.now(),
      edgeHistory: [...t.edgeHistory.slice(-19), edge.netEdge],
    };
  });
  if (changed) {
    const card = theses.find((t) => t.ticker === ticker);
    recordTick(ticker, yesPrice, spread, card?.netEdge ?? 0);
    broadcast('markets:update', {
      markets: marketsCache,
      theses: rankTheses(theses),
      connectors: registry.getAll(),
    });
    broadcastPaperUpdate();
  }
}

function processWorkingOrders() {
  const working = paperOrderBook.working();
  if (working.length === 0) return;
  for (const order of working) {
    const card = theses.find((t) => t.ticker === order.ticker);
    if (!card) continue;
    const mark = card.side === 'yes' ? card.marketPrice : 1 - card.marketPrice;
    const hit =
      (order.orderType === 'limit' && mark <= order.limitPrice) ||
      (order.orderType === 'stop' && mark >= order.limitPrice) ||
      (order.orderType === 'take-profit' && mark >= order.limitPrice);
    if (!hit) continue;
    void (async () => {
      const book = await fetchBookForCard(card);
      const result = simulatePaperBuy(paperDesk, card, book, settings, order.contracts);
      if (result.ok) {
        paperOrderBook.fill(order.id);
        savePaperPortfolio();
        savePaperOrders();
        sessionStatsData.tradeCount += 1;
        broadcastPaperUpdate();
      }
    })();
  }
}

function broadcastPaperUpdate() {
  const marks = getMarkPrices();
  const mtm = paperDesk.markToMarket(marks);
  const portfolio = paperDesk.snapshot();
  const marksObj: Record<string, number> = {};
  for (const [k, v] of marks) marksObj[k] = v;
  snapshotEquity();
  broadcast('paper:update', {
    portfolio,
    marks: marksObj,
    equity: mtm.equity,
    unrealized: mtm.unrealized,
    equityHistory,
    workingOrders: paperOrderBook.working(),
    dailyPnl: sessionStatsData.dailyPnl,
    activeRegimes,
  });
}

async function refreshWatchedTicker() {
  if (!watchedTicker) return;
  const card = theses.find((t) => t.ticker === watchedTicker);
  if (!card) return;
  try {
    const book = await fetchOrderbook(watchedTicker);
    const yesBid = book.yes[0]?.price ?? card.marketPrice;
    const yesAsk = book.yes[book.yes.length - 1]?.price ?? card.marketPrice;
    const yesPrice = (yesBid + yesAsk) / 2;
    const spread = Math.abs(yesAsk - yesBid) || card.spread;
    recordTick(watchedTicker, yesPrice, spread, card.netEdge);
    broadcastPaperUpdate();
  } catch {
    const jitter = (Math.random() - 0.5) * 0.02;
    const yesPrice = Math.max(0.01, Math.min(0.99, card.marketPrice + jitter));
    recordTick(watchedTicker, yesPrice, card.spread, card.netEdge);
    broadcastPaperUpdate();
  }
}

function broadcast(channel: string, data: unknown) {
  for (const w of [mainWindow, ...widgetWindows]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, data);
  }
}

function applyDepthToCard(card: ThesisCard): ThesisCard {
  const d = discovery.getDepth(card.ticker);
  if (!d) return card;
  const sideResult = card.side === 'yes' ? d.yes : d.no;
  if (!sideResult?.executableTier) return card;
  return {
    ...card,
    executableTier: sideResult.executableTier,
    fillableUsd: sideResult.fillableUsd,
    slippagePp: sideResult.slippagePp,
    depthLevels: sideResult.depthLevels,
  };
}

function rankThesesForUi(cards: ThesisCard[]): ThesisCard[] {
  return discovery.settings.depthVerifyEnabled ? rankThesesWithTiers(cards) : rankTheses(cards);
}

async function refreshMarkets() {
  try {
    if (discovery.getUniverse().length === 0) {
      await discovery.refreshUniverse();
    }
    await discovery.runDepthPass();
    marketsCache = discovery.getUniverse();
    await buildThesesFromMarkets(discovery.getMarketsForSignals());
    broadcast('markets:update', {
      markets: marketsCache,
      theses: rankThesesForUi(theses),
      connectors: registry.getAll(),
      discovery: discovery.getState(),
      gates: evaluateGates(settings, journal.count(), settings.backtestPassed ?? false, registry.isHealthy('kalshi-rest'), settings.humanQuizPassed ?? false),
    });
    broadcastDiscovery();
    broadcastWorldEvents();
    broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });
  } catch (e) {
    registry.recordError('kalshi-rest', e instanceof Error ? e.message : String(e));
    if (marketsCache.length === 0) {
      marketsCache = FIXTURE_MARKETS;
      discovery.seedFixtureDepth(FIXTURE_MARKETS);
    }
    await buildThesesFromMarkets(marketsCache);
    broadcast('markets:update', {
      markets: marketsCache,
      theses: rankThesesForUi(theses),
      offline: true,
      connectors: registry.getAll(),
      discovery: discovery.getState(),
    });
    broadcastDiscovery();
  }
}

async function refreshUniverseLoop() {
  try {
    await discovery.refreshUniverse();
    marketsCache = discovery.getUniverse();
    broadcastDiscovery();
  } catch {
    /* keep cached universe */
  }
}

async function buildThesesFromMarkets(markets: KalshiMarket[]) {
  await Promise.race([
    feedHub.refreshForMarkets(markets),
    new Promise<void>((resolve) => setTimeout(resolve, FEED_WAIT_MS)),
  ]);
  feedHub.kickRefresh(markets);

  const cards: ThesisCard[] = [];
  const slice = markets;

  const micro = await Promise.all(
    slice.map(async (m) => {
      const p = normalizeMarketPrice(m);
      const ms = discovery.getMicrostructure(m.ticker, p);
      return { m, p, ...ms };
    }),
  );

  for (const { m, p, spread, depthUsd } of micro) {
    if (isWeatherMarket(m)) {
      const wx = feedHub.weatherInputFor(m);
      cards.push(weatherToThesis({
        ticker: m.ticker,
        title: m.title,
        strike: wx.strike,
        nwsForecast: wx.nwsForecast,
        openMeteoForecast: wx.openMeteoForecast,
        marketPrice: p,
        spread,
        depthUsd,
        hoursToSettle: wx.hoursToSettle,
      }));
    } else if (isCryptoMarket(m)) {
      const cx = feedHub.cryptoInputFor(m, p);
      cards.push(cryptoToThesis({
        ticker: m.ticker,
        title: m.title,
        spotPrice: cx.spotPrice,
        strike: cx.strike,
        marketPrice: p,
        spread,
        depthUsd,
        lagMs: cx.lagMs,
        kalshiImpliedSpot: cx.kalshiImpliedSpot,
      }));
    } else if (isMacroMarket(m)) {
      const macro = feedHub.macroInputFor(m);
      cards.push(macroToThesis({
        ticker: m.ticker,
        title: m.title,
        releaseName: macro.releaseName,
        consensus: macro.consensus,
        actual: macro.actual,
        marketPrice: p,
        spread,
        depthUsd,
        minutesToRelease: macro.minutesToRelease,
      }));
    } else {
      cards.push(globalToThesis({
        ticker: m.ticker,
        marketTitle: m.title,
        news: feedHub.globalNewsFor(m),
        marketPrice: p,
        spread,
        depthUsd,
      }));
    }

    const infraAlert = feedHub.getInfraAlert();
    if (infraAlert) {
      const infra = infraToThesis(m.ticker, m.title, infraAlert, p, spread, depthUsd);
      if (infra) cards.push(infra);
    }

    if (isSportsMarket(m)) {
      const sports = feedHub.getSportsSnapshot();
      if (sports) {
        cards.push(sportsToThesis({
          ticker: m.ticker,
          title: m.title,
          homeScore: sports.homeScore,
          awayScore: sports.awayScore,
          impliedWinProb: sports.impliedWinProb,
          marketPrice: p,
          spread,
          depthUsd,
        }));
      }
    }

    for (const trade of feedHub.getTradesForTicker(m.ticker)) {
      const flow = tradeToThesis(trade, m);
      if (flow) cards.push(flow);
    }

    const macro = feedHub.macroInputFor(m);
    const release = releaseRadarWarning({
      name: macro.releaseName,
      ticker: m.ticker,
      title: m.title,
      minutesToRelease: macro.minutesToRelease,
      marketPrice: p,
    });
    if (release) cards.push(release);

    const depth = discovery.getDepth(m.ticker);
    const sideTier = depth?.yes?.executableTier ?? depth?.no?.executableTier;
    const minEdge = minNetEdgeForTier(sideTier ?? undefined, settings.demoMode);

    for (const scanned of scanMarketTheses({
      ticker: m.ticker,
      title: m.title,
      category: m.category ?? 'general',
      marketPrice: p,
      spread,
      depthUsd,
      minNetEdge: minEdge,
      depthContext: depth,
    })) {
      if (!cards.some((c) => c.ticker === scanned.ticker && c.side === scanned.side)) {
        cards.push(scanned);
      }
    }
  }

  const regime = computeRegimeState(0.04, 200, 5000, false);
  reviewOnly = regime.reviewOnly;

  let built = cards.map(finalizeThesis).map(applyDepthToCard);
  // Only enforce depth-tier filter for live trading — paper/demo shows everything with positive edge
  if (discovery.settings.depthVerifyEnabled && settings.liveEnabled) {
    const withTier = built.filter((c) => c.executableTier != null);
    built = withTier.length > 0 ? withTier : built;
  }
  theses = rankThesesForUi(built);
  kalshiStream.track([...new Set(theses.map((t) => t.ticker))]);

  for (const c of theses) {
    recordTick(c.ticker, c.marketPrice, c.spread, c.netEdge);
  }
  broadcastPaperUpdate();
}

const FIXTURE_MARKETS: KalshiMarket[] = [
  { ticker: 'DEMO-WX-1', title: 'NYC High Temp > 90°F', status: 'open', yes_ask: 34, category: 'weather' },
  { ticker: 'DEMO-CRYPTO-1', title: 'BTC above $98k', status: 'open', yes_ask: 52, category: 'crypto' },
  { ticker: 'DEMO-MACRO-1', title: 'CPI above 3.2%', status: 'open', yes_ask: 41, category: 'economics' },
];

function getLiveCreds(): LiveCredentials | null {
  if (!settings.kalshiApiKeyId) return null;
  const privateKeyPem = process.env.NEMESIS_KALSHI_PRIVATE_KEY ?? settings.kalshiPrivateKey ?? '';
  if (!privateKeyPem) return null;
  return { apiKeyId: settings.kalshiApiKeyId, privateKeyPem };
}

async function activateKillSwitch(source: 'ipc' | 'shortcut'): Promise<GuardrailSettings> {
  settings.killSwitchActive = true;
  settings.liveEnabled = false;
  await cancelAllLiveOrders(getLiveCreds(), settings);
  const paperCancelled = paperOrderBook.cancelAll();
  if (paperCancelled > 0) {
    savePaperOrders();
    broadcastPaperUpdate();
  }
  saveSettings();
  auditLog.append({
    action: 'kill_switch',
    detail: `kill switch activated (${source})`,
    ok: true,
  });
  saveAuditLog();
  broadcast('settings:update', settings);
  return settings;
}

function broadcastBridgeStatus() {
  broadcast('bridge:status', { ...bridgeStatus });
}

function broadcastToGea(msg: Omit<NemesisBridgeMessage, 'seq'>) {
  const full: NemesisBridgeMessage = { ...msg, seq: ++bridgeSeq };
  const json = JSON.stringify(full);
  for (const client of bridgeClients) {
    if (client.readyState === WsSocket.OPEN) client.send(json);
  }
}

function buildNemesisStateMirror() {
  const marks = getMarkPrices();
  const mtm = paperDesk.markToMarket(marks);
  const gates = evaluateGates(
    settings,
    journal.count(),
    settings.backtestPassed ?? false,
    registry.isHealthy('kalshi-rest'),
    settings.humanQuizPassed ?? false,
  );
  return {
    thesesCount: theses.length,
    marketsCount: marketsCache.length,
    isLive: settings.liveEnabled,
    paperCash: paperDesk.snapshot().cash,
    paperEquity: mtm.equity,
    dailyPnl: sessionStatsData.dailyPnl,
    gates: gates.map((g) => g.id),
    activeRegimes,
    timestamp: Date.now(),
  };
}

function setupBridgeServer() {
  const port = parseInt(process.env.NEMESIS_BRIDGE_PORT ?? '7430', 10);
  const wss = new WebSocketServer({ port });
  wss.on('error', (err: Error) => {
    console.warn('[nemesis] Bridge server unavailable on port ' + port + ': ' + err.message);
    bridgeStatus.connected = false;
    bridgeStatus.clientCount = 0;
    broadcastBridgeStatus();
  });

  wss.on('connection', (ws: WsSocket) => {
    bridgeClients.add(ws);
    bridgeStatus.connected = true;
    bridgeStatus.clientCount = bridgeClients.size;
    broadcastBridgeStatus();

    const hello: NemesisBridgeMessage = {
      type: 'bridge:hello',
      payload: { version: '0.1.0', role: 'nemesis', timestamp: Date.now() },
      seq: ++bridgeSeq,
    };
    ws.send(JSON.stringify(hello));
    broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });

    ws.on('message', (raw: RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as NemesisBridgeMessage;
        bridgeStatus.lastSeenAt = Date.now();

        const validation = validateBridgeMessage(msg);
        if (!validation.ok) {
          auditLog.append({ action: 'gate_block', detail: `bridge packet rejected: ${validation.reason}`, ok: false });
          saveAuditLog();
          return;
        }

        const valid = validation.value;
        if (valid.type === 'brain:recommendation') {
          bridgeStatus.brainRole = (valid.payload as { brain_role: BridgeStatus['brainRole'] }).brain_role;
          broadcastBridgeStatus();
          broadcast('bridge:recommendation', valid.payload);
        } else if (valid.type === 'brain:no-trade' || valid.type === 'brain:exit') {
          broadcast('bridge:recommendation', valid.payload);
        } else if (valid.type === 'bridge:ping') {
          const pong: NemesisBridgeMessage = { type: 'bridge:pong', payload: {}, seq: ++bridgeSeq };
          ws.send(JSON.stringify(pong));
        }
      } catch {
        auditLog.append({ action: 'gate_block', detail: 'bridge packet rejected: malformed json', ok: false });
        saveAuditLog();
      }
    });

    ws.on('close', () => {
      bridgeClients.delete(ws);
      bridgeStatus.connected = bridgeClients.size > 0;
      bridgeStatus.clientCount = bridgeClients.size;
      broadcastBridgeStatus();
    });

    ws.on('error', (_err: Error) => {
      // 'close' fires after 'error'
    });
  });
}

function spawnGlobalEventAlpha() {
  if (process.env.NEMESIS_AUTO_SPAWN_GEA === 'false') return;
  if (geaProcess && !geaProcess.killed) return;

  const bridgePort = process.env.NEMESIS_BRIDGE_PORT ?? '7430';
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const geaRoot = path.resolve(__dirname, '..', '..', 'global-event-alpha');
  const builtMain = path.join(geaRoot, 'dist-electron', 'main.js');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEMESIS_BRIDGE_URL: `ws://localhost:${bridgePort}`,
  };
  delete childEnv.VITE_DEV_SERVER_URL;

  let command: string | null = null;
  let args: string[] = [];
  let cwd = repoRoot;
  const geaPath = process.env.NEMESIS_GEA_PATH;

  if (geaPath && fs.existsSync(geaPath)) {
    command = geaPath;
  } else if (process.env.VITE_DEV_SERVER_URL) {
    command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    args = ['run', 'dev', '-w', '@nemesis/global-event-alpha'];
  } else if (fs.existsSync(builtMain)) {
    command = process.execPath;
    args = [builtMain];
    cwd = geaRoot;
  }

  if (!command) return;
  geaProcess = spawn(command, args, { cwd, detached: true, stdio: 'ignore', env: childEnv });
  geaProcess.once('exit', () => {
    geaProcess = null;
  });
  geaProcess.unref();
}

function setupIpc() {
  ipcMain.handle('nemesis:getState', () => ({
    settings,
    theses: rankThesesForUi(theses),
    gates: evaluateGates(settings, journal.count(), settings.backtestPassed ?? false, registry.isHealthy('kalshi-rest'), settings.humanQuizPassed ?? false),
    connectors: registry.getAll(),
    journalCount: journal.count(),
    reviewOnly,
    canLive: canEnableLive(evaluateGates(settings, journal.count(), settings.backtestPassed ?? false, registry.isHealthy('kalshi-rest'), settings.humanQuizPassed ?? false)),
    activeRegimes,
    dailyPnl: sessionStatsData.dailyPnl,
    humanQuizPassed: settings.humanQuizPassed ?? false,
    backtestPassed: settings.backtestPassed ?? false,
    shutdown: getShutdownCounters(),
  }));

  ipcMain.handle('nemesis:getMarkets', () => marketsCache);

  ipcMain.handle('nemesis:updateSettings', (_e, partial: Partial<GuardrailSettings>) => {
    if (partial.liveEnabled && !getLiveCreds()) {
      return { ok: false, error: 'Kalshi credentials not configured — add API Key ID and Private Key in Settings' };
    }
    const riskOverride = settings.liveEnabled && isRiskSettingOverride(partial);
    settings = { ...settings, ...partial };
    if (riskOverride) recordSettingsManualOverride();
    feedHub.setKalshiApiKey(settings.kalshiApiKeyId);
    saveSettings();
    broadcast('settings:update', settings);
    return { ok: true, settings };
  });

  ipcMain.handle('nemesis:journalAdd', (_e, thesisId: string, notes?: string) => {
    const card = theses.find((t) => t.id === thesisId);
    if (!card) return null;
    const entry = journal.addFromThesis(card, notes);
    ensureDataDir();
    fs.writeFileSync(JOURNAL_PATH, JSON.stringify(journal.list(), null, 2));
    return entry;
  });

  ipcMain.handle('nemesis:journalExport', () => journal.exportCsv());

  ipcMain.handle('nemesis:dryRun', async (_e, thesisId: string) => {
    const card = theses.find((t) => t.id === thesisId);
    if (!card || !PAPER_OK.has(card.status)) {
      recordDryRunInvalidation();
      return { aborted: true, abortReason: 'not tradeable' };
    }
    try {
      const book = await fetchOrderbook(card.ticker);
      const result = dryRunFill(book, card.side, 10, card.impliedPrice);
      if (result.aborted) {
        recordDryRunAbnormalExecution();
      } else {
        resetDryRunInvalidationStreak();
      }
      return result;
    } catch {
      const book = { ticker: card.ticker, yes: [{ price: card.marketPrice, quantity: 100 }], no: [] };
      const result = dryRunFill(book, card.side, 10, card.impliedPrice);
      if (result.aborted) {
        recordDryRunAbnormalExecution();
      } else {
        resetDryRunInvalidationStreak();
      }
      return result;
    }
  });

  ipcMain.handle('nemesis:passQuiz', () => {
    settings = { ...settings, humanQuizPassed: true };
    saveSettings();
    saveAuditLog();
    broadcast('settings:update', settings);
    return true;
  });

  ipcMain.handle('nemesis:passBacktest', () => {
    const result = runFeeAwareBacktest(journal.list());
    settings = { ...settings, backtestPassed: result.passed };
    saveSettings();
    auditLog.append({ action: 'backtest', detail: result.detail, ok: result.passed });
    saveAuditLog();
    broadcast('settings:update', settings);
    return result;
  });

  ipcMain.handle('nemesis:quarantinePlaybook', (_e, playbook: string) => {
    quarantine.evaluate({ playbook: playbook as never, signals: 25, wins: 5, losses: 20, staleRate: 0.1, disagreementRate: 0.1, fillDrag: 0.05 });
    return quarantine.listFrozen();
  });

  ipcMain.handle('nemesis:killSwitch', () => activateKillSwitch('ipc'));

  ipcMain.handle('nemesis:unlockLive', (_e, confirmText: string) => {
    if (confirmText !== 'ENABLE LIVE') {
      return { ok: false, error: 'Type ENABLE LIVE to confirm' };
    }
    if (!getLiveCreds()) {
      return { ok: false, error: 'Kalshi credentials not configured — add API Key ID and Private Key in Settings' };
    }
    settings = { ...settings, liveEnabled: true, demoMode: false, dryRun: false, killSwitchActive: false };
    recordSettingsManualOverride();
    saveSettings();
    auditLog.append({ action: 'live_order', detail: 'live mode enabled', ok: true });
    saveAuditLog();
    broadcast('settings:update', settings);
    return { ok: true, settings };
  });

  ipcMain.handle('nemesis:exportSession', () => {
    const marks = getMarkPrices();
    const mtm = paperDesk.markToMarket(marks);
    return {
      trades: paperDesk.snapshot().trades,
      equityHistory,
      audit: auditLog.list(),
      sessionStats: sessionStatsData,
      equity: mtm.equity,
      csv: journal.exportCsv(),
    };
  });

  ipcMain.handle('nemesis:reconcileLive', async () => {
    if (!settings.liveEnabled) return { ok: true, mismatches: [] };
    const local = paperDesk.snapshot().positions.map((p) => ({
      ticker: p.ticker,
      side: p.side,
      contracts: p.contracts,
      avgPrice: p.entryPrice,
    }));
    return reconcileLiveBook(local, getLiveCreds());
  });

  ipcMain.handle('nemesis:refresh', refreshMarkets);

  ipcMain.handle('nemesis:liveBuy', async (_e, thesisId: string, contracts?: number, limitPrice?: number) => {
    if (!settings.liveEnabled) return { ok: false, error: 'live trading not enabled' };
    if (settings.killSwitchActive) return { ok: false, error: 'kill switch active' };
    const creds = getLiveCreds();
    if (!creds) return { ok: false, error: 'Kalshi credentials not configured' };
    const card = theses.find((t) => t.id === thesisId);
    if (!card || !PAPER_OK.has(card.status)) {
      return { ok: false, error: 'thesis not eligible for live trading' };
    }
    const risk = checkPaperRisk(card, paperDesk.snapshot(), settings, getDailyPnl());
    if (!risk.ok) {
      auditLog.append({ action: 'gate_block', thesisId, ticker: card.ticker, detail: risk.error ?? 'blocked', ok: false });
      saveAuditLog();
      return { ok: false, error: risk.error };
    }
    const qty = resolveContractCount(card, paperDesk.snapshot(), settings, contracts);
    const mark = card.side === 'yes' ? card.marketPrice : 1 - card.marketPrice;
    const req = createLiveOrderRequest(card, qty, limitPrice ?? mark);
    const result = await submitLiveOrder(req, creds, settings);
    auditLog.append({
      action: 'live_order',
      thesisId,
      ticker: card.ticker,
      detail: result.ok ? `order ${result.orderId ?? 'placed'}` : result.error ?? 'failed',
      ok: result.ok,
    });
    saveAuditLog();
    return result;
  });

  ipcMain.handle('nemesis:paperBuy', async (_e, thesisId: string, contracts?: number) => {
    const card = theses.find((t) => t.id === thesisId);
    if (!card || card.netEdge <= 0) {
      return { ok: false, error: 'thesis not eligible for paper trading' };
    }
    const risk = checkPaperRisk(card, paperDesk.snapshot(), settings, getDailyPnl());
    if (!risk.ok) {
      auditLog.append({ action: 'gate_block', thesisId, ticker: card.ticker, detail: risk.error ?? 'blocked', ok: false });
      saveAuditLog();
      return { ok: false, error: risk.error };
    }
    const book = await fetchBookForCard(card);
    const result = simulatePaperBuy(paperDesk, card, book, settings, contracts);
    if (!result.ok) {
      sessionStatsData.abortCount += 1;
      auditLog.append({
        action: 'paper_abort',
        thesisId,
        ticker: card.ticker,
        detail: result.abortReason ?? result.error ?? 'aborted',
        ok: false,
      });
      saveAuditLog();
      saveSessionStats();
      return result;
    }
    sessionStatsData.tradeCount += 1;
    auditLog.append({ action: 'paper_buy', thesisId, ticker: card.ticker, detail: `filled ${result.fill?.filled}`, ok: true });
    savePaperPortfolio();
    saveAuditLog();
    broadcastPaperUpdate();
    return result;
  });

  ipcMain.handle('nemesis:paperClose', async (_e, positionId: string, contracts?: number) => {
    const pos = paperDesk.snapshot().positions.find((p) => p.id === positionId);
    if (!pos) return { ok: false, error: 'position not found' };
    const card = theses.find((t) => t.ticker === pos.ticker);
    const expectedPrice = pos.side === 'yes'
      ? (card?.marketPrice ?? pos.entryPrice)
      : (1 - (card?.marketPrice ?? pos.entryPrice));
    const qty = contracts ?? pos.contracts;
    const book = card ? await fetchBookForCard(card) : fallbackBook({
      ...pos,
      id: pos.thesisId,
      marketPrice: pos.entryPrice,
      impliedPrice: pos.entryPrice,
      category: pos.category ?? '',
      playbook: pos.playbook as never,
      status: 'tradeable',
      grossEdge: 0,
      netEdge: 0,
      spread: 0.02,
      depthUsd: 100,
      predictability: 50,
      feeEstimate: 0,
      signalReason: '',
      externalSummary: '',
      createdAt: 0,
      updatedAt: 0,
      freshnessMs: 0,
      edgeHistory: [],
      drivers: [],
      invalidations: [],
      title: pos.title,
    });
    const result = simulatePaperClose(paperDesk, positionId, book, pos.side, expectedPrice, qty, settings);
    if (result.ok) {
      sessionStatsData.tradeCount += 1;
      auditLog.append({ action: 'paper_close', ticker: pos.ticker, detail: `pnl ${result.pnl?.toFixed(2)}`, ok: true });
      savePaperPortfolio();
      saveAuditLog();
      broadcastPaperUpdate();
    }
    return result;
  });

  ipcMain.handle('nemesis:paperPreview', async (_e, thesisId: string, contracts?: number) => {
    const card = theses.find((t) => t.id === thesisId);
    if (!card) return { aborted: true, abortReason: 'thesis not found' };
    const qty = resolveContractCount(card, paperDesk.snapshot(), settings, contracts);
    const book = await fetchBookForCard(card);
    return dryRunFill(book, card.side, qty, card.impliedPrice, settings.maxSlippagePp);
  });

  ipcMain.handle('nemesis:paperPlaceLimit', (_e, thesisId: string, contracts: number, limitPrice: number) => {
    const card = theses.find((t) => t.id === thesisId);
    if (!card) return { ok: false, error: 'thesis not found' };
    const order: PaperOrder = {
      id: `po-${Date.now()}`,
      thesisId,
      ticker: card.ticker,
      side: card.side,
      orderType: 'limit',
      contracts,
      limitPrice,
      createdAt: Date.now(),
      status: 'working',
    };
    paperOrderBook.add(order);
    savePaperOrders();
    broadcastPaperUpdate();
    return { ok: true, order };
  });

  ipcMain.handle('nemesis:paperCancelOrder', (_e, orderId: string) => {
    const ok = paperOrderBook.cancel(orderId);
    if (ok) {
      savePaperOrders();
      broadcastPaperUpdate();
    }
    return { ok };
  });

  ipcMain.handle('nemesis:getPaperPortfolio', () => {
    const marks = getMarkPrices();
    const mtm = paperDesk.markToMarket(marks);
    const marksObj: Record<string, number> = {};
    for (const [k, v] of marks) marksObj[k] = v;
    refreshDailyPnl();
    return {
      portfolio: paperDesk.snapshot(),
      marks: marksObj,
      equity: mtm.equity,
      unrealized: mtm.unrealized,
      equityHistory,
      workingOrders: paperOrderBook.working(),
      dailyPnl: sessionStatsData.dailyPnl,
      activeRegimes,
    };
  });

  ipcMain.handle('nemesis:resetPaper', (_e, startingCash?: number) => {
    const cash = (startingCash && startingCash > 0) ? startingCash : DEFAULT_PAPER_CASH;
    paperDesk.reset(cash);
    equityHistory = [{ t: Date.now(), equity: cash, deployed: 0, cash }];
    resetDailySession();
    savePaperPortfolio();
    saveEquityHistory();
    broadcastPaperUpdate();
    return paperDesk.snapshot();
  });

  ipcMain.handle('nemesis:getTickHistory', (_e, ticker: string) => tickHistory.get(ticker) ?? []);

  ipcMain.handle('nemesis:watchTicker', (_e, ticker: string | null) => {
    watchedTicker = ticker;
    if (ticker && tickHistory.has(ticker)) {
      broadcast('ticks:update', { ticker, ticks: tickHistory.get(ticker) });
    }
    return true;
  });

  ipcMain.handle('nemesis:getDiscoveryState', () => discovery.getState());

  ipcMain.handle('nemesis:updateDiscoverySettings', (_e, partial: Partial<DiscoverySettings>) => {
    discovery.updateSettings(partial);
    saveDiscoverySettings();
    broadcastDiscovery();
    return { ok: true, state: discovery.getState() };
  });

  ipcMain.handle('nemesis:pauseDiscovery', () => {
    discovery.pause();
    broadcastDiscovery();
    return discovery.getState();
  });

  ipcMain.handle('nemesis:resumeDiscovery', () => {
    discovery.resume();
    broadcastDiscovery();
    return discovery.getState();
  });

  ipcMain.handle('nemesis:forceUniverseRefresh', async () => {
    await refreshUniverseLoop();
    return discovery.getState();
  });

  ipcMain.handle('nemesis:getWorldEvents', () => buildWorldEventsPayload());

  ipcMain.handle('nemesis:getBridgeStatus', () => ({ ...bridgeStatus }));

  ipcMain.handle('nemesis:openWidget', (_e, type: string) => {
    const SIZES: Record<string, [number, number]> = {
      pnl:    [240, 130],
      risk:   [280, 180],
      ticker: [280, 320],
      gates:  [280, 180],
      scout:  [260, 200],
      world:  [360, 240],
    };
    const [w, h] = SIZES[type] ?? [280, 200];
    const win = new BrowserWindow({
      width: w, height: h,
      frame: false,
      alwaysOnTop: true,
      resizable: true,
      minWidth: 160, minHeight: 80,
      backgroundColor: '#181b26',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      win.loadURL(`${devUrl}widget.html?widget=${type}`).catch(console.error);
    } else {
      win.loadFile(path.join(__dirname, '../dist/widget.html'), { query: { widget: type } }).catch(console.error);
    }
    widgetWindows.add(win);
    win.on('closed', () => widgetWindows.delete(win));
    return { ok: true };
  });

  ipcMain.handle('nemesis:closeThisWidget', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle('nemesis:forceDepthPass', async () => {
    await discovery.runDepthPass();
    await refreshMarkets();
    return discovery.getState();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#0a0b0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[nemesis] did-fail-load', code, desc, url);
    if (devUrl && mainWindow) {
      setTimeout(() => {
        mainWindow?.loadURL(devUrl).catch((err) => console.error('[nemesis] reload failed', err));
      }, 1500);
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (devUrl) {
    mainWindow.loadURL(devUrl).catch((err) => console.error('[nemesis] loadURL failed', err));
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  loadSettings();
  feedHub.setKalshiApiKey(settings.kalshiApiKeyId);
  loadDiscoverySettings();
  loadJournal();
  loadPaperPortfolio();
  loadEquityHistory();
  loadSessionStats();
  loadPaperOrders();
  loadAuditLog();
  kalshiStream.onQuote((q) => applyKalshiQuote(q.ticker, q.yesPrice, q.spread));
  kalshiStream.start();
  setupIpc();
  setupBridgeServer();
  createWindow();
  spawnGlobalEventAlpha();
  feedHub.startBackgroundPolling(8_000);
  try {
    await discovery.refreshUniverse();
    marketsCache = discovery.getUniverse();
  } catch {
    marketsCache = FIXTURE_MARKETS;
    discovery.seedFixtureDepth(FIXTURE_MARKETS);
  }
  await refreshMarkets();
  setInterval(refreshMarkets, MARKET_REFRESH_MS);
  setInterval(refreshUniverseLoop, 60_000);
  setInterval(refreshWatchedTicker, WATCHED_TICK_MS);
  setInterval(() => {
    tickApiHealthDegraded();
    processWorkingOrders();
    if (paperDesk.snapshot().positions.length > 0) {
      broadcastPaperUpdate();
    }
  }, 5_000);

  globalShortcut.register('CommandOrControl+Shift+K', () => {
    void activateKillSwitch('shortcut');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (geaProcess && !geaProcess.killed) geaProcess.kill();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
