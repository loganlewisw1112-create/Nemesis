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

import { app, BrowserWindow, ipcMain, globalShortcut, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer, WebSocket as WsSocket, type RawData } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { validateBridgeMessage, type BridgeStatus, type ExitRecommendation, type NemesisBridgeMessage, type NemesisStateMirror, type RecommendationPacket } from '@nemesis/bridge-contracts';
import {
  DEFAULT_GUARDRAILS,
  DEFAULT_AUTO_CLOSE_SETTINGS,
  DEFAULT_OPPORTUNITY_THROUGHPUT,
  DEFAULT_STRICT_PROFIT_MODE,
  DEFAULT_PAPER_CASH,
  fetchOrderbook,
  fetchMarket,
  isExecutablePrice,
  normalizeMarketPrice,
  sanitizeExecutableBook,
  evaluateGates,
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
  hasRealExecutableDepth,
  scoreOpportunityForCard,
  HotOpportunityIndex,
  evaluateLiveUnlock,
  type AutoCloseDecision,
  type AutoCloseSettings,
  type AutoCloseState,
  type DiscoverySettings,
  type GuardrailSettings,
  type ThesisCard,
  type KalshiMarket,
  type KalshiOrderbook,
  type OpportunityRadarRow,
  type PriceTick,
  type PaperPortfolio,
  type PaperPosition,
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
  evaluateAutoClosePosition,
  updateAutoCloseState,
  resolveSettlement,
  ProfitabilityBenchmark,
  OpportunityThroughputQueue,
  annotateCardsWithCertification,
  entryEligibilityBlockReason,
  isEntryEligible,
  isResearchSimulationEligible,
  type AutoCloseExitSignal,
  type LiveCredentials,
  type PaperBuyResult,
} from '@nemesis/execution';
import { StrategyQuarantine } from '@nemesis/capital';
import { tradeToThesis, weatherToThesis, macroToThesis, cryptoToThesis, globalToThesis, infraToThesis, sportsToThesis, releaseRadarWarning, scanMarketTheses } from '@nemesis/pods';
import { DiscoveryOrchestrator } from './discovery.js';
import { upsertRecommendationMarket, upsertRecommendationThesis } from './bridgeRecommendations.js';
import { createGeaBridgeUrl, createGeaChildEnv, createGeaSpawnPlan } from './geaSpawn.js';
import { createSingleFlight, withAbortTimeout } from './singleFlight.js';
import { startupTrace } from './startupTrace.js';
import { createBridgeAuth, isBridgeRequestAuthenticated, resolveBridgeHost } from './bridgeSecurity.js';
import { resolveNemesisUserDataPath } from './userDataPath.js';

if (process.env.NEMESIS_E2E_USER_DATA) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}
app.setPath('userData', resolveNemesisUserDataPath(process.env, app.getPath('appData')));

const DATA_DIR = path.join(app.getPath('userData'), 'nemesis-data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const JOURNAL_PATH = path.join(DATA_DIR, 'journal.json');
const PAPER_PATH = path.join(DATA_DIR, 'paper-portfolio.json');
const EQUITY_HISTORY_PATH = path.join(DATA_DIR, 'equity-history.json');
const SESSION_STATS_PATH = path.join(DATA_DIR, 'session-stats.json');
const PAPER_ORDERS_PATH = path.join(DATA_DIR, 'paper-orders.json');
const AUDIT_PATH = path.join(DATA_DIR, 'audit-log.json');
const DISCOVERY_SETTINGS_PATH = path.join(DATA_DIR, 'discovery-settings.json');
const AUTO_CLOSE_PATH = path.join(DATA_DIR, 'auto-close-state.json');
const KALSHI_CREDENTIALS_PATH = path.join(DATA_DIR, 'kalshi-credentials.v1.json');

const MAX_TICKS = 120;
const LIQUIDITY_PREFILTER_MAX_AGE_MS = 45_000;
const MARKET_REFRESH_MS = 15_000;
const WATCHED_TICK_MS = 1_000;
const FEED_WAIT_MS = 2_000;
const BOOK_CACHE_TTL_MS = 600;
const MARKET_BROADCAST_THROTTLE_MS = 750;
const PAPER_BROADCAST_THROTTLE_MS = 1_000;
const EQUITY_SNAPSHOT_MIN_MS = 5_000;
const UNIVERSE_FETCH_TIMEOUT_MS = 20_000;

app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');

startupTrace('module-loaded');

let mainWindow: BrowserWindow | null = null;
const widgetWindows = new Set<BrowserWindow>();
const registry = new ConnectorRegistry();
const discovery = new DiscoveryOrchestrator(registry);
const feedHub = new FeedHub(registry);
const kalshiStream = new KalshiStream(registry);
const hotOpportunityIndex = new HotOpportunityIndex({ maxRows: 25, targetDecisionMs: 3 });
const journal = new JournalStore();
const quarantine = new StrategyQuarantine();
let settings: GuardrailSettings = { ...DEFAULT_GUARDRAILS };
let theses: ThesisCard[] = [];
let geaTheses: ThesisCard[] = [];
let reviewOnly = false;
let marketsCache: KalshiMarket[] = [];
let marketFeedReady = false;
let geaMarkets: KalshiMarket[] = [];
const paperDesk = new PaperDesk(DEFAULT_PAPER_CASH);
const paperOrderBook = new PaperOrderBook();
const auditLog = new AuditLog();
const profitabilityBenchmark = new ProfitabilityBenchmark({ targetLiftPct: 80 });
const opportunityQueue = new OpportunityThroughputQueue(DEFAULT_OPPORTUNITY_THROUGHPUT);
const tickHistory = new Map<string, PriceTick[]>();
const autoCloseStates = new Map<string, AutoCloseState>();
const latestExitSignals = new Map<string, AutoCloseExitSignal>();
const bookCache = new Map<string, { book: KalshiOrderbook; fetchedAt: number }>();
let opportunityRadarRows: OpportunityRadarRow[] = [];
let watchedTicker: string | null = null;
let activeRegimes: string[] = [];
let autoCloseDecisions: AutoCloseDecision[] = [];
let autoCloseRunning = false;
let autoCloseQueued = false;
let throughputRunning = false;
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
let lastEquitySnapshotAt = 0;
let marketBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let paperBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

interface StoredKalshiCredentials {
  storage: 'electron-safeStorage-v1';
  kalshiApiKeyId?: string;
  encryptedPrivateKey?: string;
  updatedAt: number;
}

interface KalshiCredentialStatus {
  apiKeyId: string | null;
  hasPrivateKey: boolean;
  privateKeyStorage: 'env' | 'electron-safeStorage' | 'none';
  encryptionAvailable: boolean;
  updatedAt: number | null;
}

// Bridge WebSocket server (port 7430)
const bridgeClients = new Set<WsSocket>();
let bridgeSeq = 0;
let geaProcess: ChildProcess | null = null;
const bridgeAuth = createBridgeAuth(process.env);
const bridgeStatus: BridgeStatus = {
  connected: false,
  brainRole: null,
  lastSeenAt: null,
  clientCount: 0,
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readStoredKalshiCredentials(): StoredKalshiCredentials | null {
  ensureDataDir();
  if (!fs.existsSync(KALSHI_CREDENTIALS_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(KALSHI_CREDENTIALS_PATH, 'utf8')) as Partial<StoredKalshiCredentials>;
    if (raw.storage !== 'electron-safeStorage-v1') return null;
    return {
      storage: 'electron-safeStorage-v1',
      kalshiApiKeyId: typeof raw.kalshiApiKeyId === 'string' ? raw.kalshiApiKeyId : undefined,
      encryptedPrivateKey: typeof raw.encryptedPrivateKey === 'string' ? raw.encryptedPrivateKey : undefined,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeStoredKalshiCredentials(credentials: StoredKalshiCredentials) {
  ensureDataDir();
  fs.writeFileSync(KALSHI_CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

function decryptStoredPrivateKey(stored: StoredKalshiCredentials | null): string {
  if (!stored?.encryptedPrivateKey || !encryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(stored.encryptedPrivateKey, 'base64'));
  } catch {
    return '';
  }
}

function currentKalshiApiKeyId(): string {
  const stored = readStoredKalshiCredentials();
  return process.env.NEMESIS_KALSHI_API_KEY_ID
    ?? stored?.kalshiApiKeyId
    ?? settings.kalshiApiKeyId
    ?? '';
}

function kalshiCredentialStatus(): KalshiCredentialStatus {
  const stored = readStoredKalshiCredentials();
  const envPrivateKey = Boolean(process.env.NEMESIS_KALSHI_PRIVATE_KEY);
  const hasStoredPrivateKey = Boolean(stored?.encryptedPrivateKey);
  return {
    apiKeyId: currentKalshiApiKeyId() || null,
    hasPrivateKey: envPrivateKey || hasStoredPrivateKey,
    privateKeyStorage: envPrivateKey ? 'env' : hasStoredPrivateKey ? 'electron-safeStorage' : 'none',
    encryptionAvailable: encryptionAvailable(),
    updatedAt: stored?.updatedAt ?? null,
  };
}

function persistKalshiCredentials(input: { kalshiApiKeyId?: string; privateKeyPem?: string }) {
  const stored = readStoredKalshiCredentials();
  const apiKeyId = input.kalshiApiKeyId?.trim() || stored?.kalshiApiKeyId || settings.kalshiApiKeyId;
  let encryptedPrivateKey = stored?.encryptedPrivateKey;
  const privateKeyPem = input.privateKeyPem?.trim();

  if (privateKeyPem) {
    if (!encryptionAvailable()) {
      return { ok: false, error: 'Electron safeStorage is unavailable; use NEMESIS_KALSHI_PRIVATE_KEY for this session' };
    }
    encryptedPrivateKey = safeStorage.encryptString(privateKeyPem).toString('base64');
  }

  if (!apiKeyId && !encryptedPrivateKey) {
    return { ok: false, error: 'API key ID or private key is required' };
  }

  writeStoredKalshiCredentials({
    storage: 'electron-safeStorage-v1',
    kalshiApiKeyId: apiKeyId,
    encryptedPrivateKey,
    updatedAt: Date.now(),
  });

  settings = normalizeGuardrailSettings({ ...settings, kalshiApiKeyId: apiKeyId });
  feedHub.setKalshiApiKey(currentKalshiApiKeyId());
  saveSettings();
  return { ok: true, status: kalshiCredentialStatus() };
}

function clearStoredKalshiCredentials() {
  if (fs.existsSync(KALSHI_CREDENTIALS_PATH)) fs.rmSync(KALSHI_CREDENTIALS_PATH, { force: true });
  settings = normalizeGuardrailSettings({ ...settings, kalshiApiKeyId: undefined });
  feedHub.setKalshiApiKey(undefined);
  saveSettings();
  return kalshiCredentialStatus();
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

function isAbnormalExecutionCode(code?: string): boolean {
  return code === 'invalid_price' || code === 'synthetic_liquidity_block';
}

function isRetryableExecutionCode(code?: string): boolean {
  return code === 'book_unavailable' || code === 'fill_aborted';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordPaperBlock(input: {
  thesisId?: string;
  ticker?: string;
  detail: string;
  code?: string;
  severity?: 'info' | 'warning' | 'error';
  blocksLiveUnlock?: boolean;
}) {
  if (isAbnormalExecutionCode(input.code)) recordDryRunAbnormalExecution();
  auditLog.append({
    action: 'paper_abort',
    thesisId: input.thesisId,
    ticker: input.ticker,
    detail: input.detail,
    ok: false,
    code: input.code,
    severity: input.severity ?? (isAbnormalExecutionCode(input.code) ? 'error' : 'info'),
    blocksLiveUnlock: input.blocksLiveUnlock ?? isAbnormalExecutionCode(input.code),
  });
  saveAuditLog();
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

function normalizeGuardrailSettings(raw: Partial<GuardrailSettings> = {}): GuardrailSettings {
  const autoClose = {
    ...DEFAULT_AUTO_CLOSE_SETTINGS,
    ...(settings.autoClose ?? {}),
    ...(raw.autoClose ?? {}),
  };
  const strictProfitMode = {
    ...DEFAULT_STRICT_PROFIT_MODE,
    ...(settings.strictProfitMode ?? {}),
    ...(raw.strictProfitMode ?? {}),
  };
  const opportunityThroughput = {
    ...DEFAULT_OPPORTUNITY_THROUGHPUT,
    ...(settings.opportunityThroughput ?? {}),
    ...(raw.opportunityThroughput ?? {}),
  };
  return {
    ...DEFAULT_GUARDRAILS,
    ...raw,
    autoClose,
    strictProfitMode,
    opportunityThroughput,
  };
}

function autoCloseSettings(): AutoCloseSettings {
  return { ...DEFAULT_AUTO_CLOSE_SETTINGS, ...(settings.autoClose ?? {}) };
}

function loadSettings() {
  ensureDataDir();
  if (fs.existsSync(SETTINGS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Partial<GuardrailSettings> & {
      kalshiPrivateKey?: unknown;
    };
    const legacyPrivateKey = typeof raw.kalshiPrivateKey === 'string' ? raw.kalshiPrivateKey.trim() : '';
    delete raw.kalshiPrivateKey;
    settings = normalizeGuardrailSettings(raw);
    if (legacyPrivateKey) {
      const migrated = persistKalshiCredentials({
        kalshiApiKeyId: settings.kalshiApiKeyId,
        privateKeyPem: legacyPrivateKey,
      });
      if (!migrated.ok) {
        settings = normalizeGuardrailSettings({
          ...settings,
          liveEnabled: false,
          liveStage: 'paper',
          autoLiveEnabled: false,
          demoMode: true,
          dryRun: true,
        });
        console.warn(`[nemesis] Removed legacy plaintext Kalshi private key from settings; encrypted migration failed: ${migrated.error}`);
      }
      saveSettings();
    }
  } else {
    settings = normalizeGuardrailSettings(settings);
  }
}

function saveSettings() {
  ensureDataDir();
  const safeSettings = { ...settings } as Record<string, unknown>;
  delete safeSettings.kalshiPrivateKey;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(safeSettings, null, 2));
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

function loadAutoCloseState() {
  ensureDataDir();
  if (!fs.existsSync(AUTO_CLOSE_PATH)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(AUTO_CLOSE_PATH, 'utf8')) as {
      states?: AutoCloseState[];
      decisions?: AutoCloseDecision[];
    };
    autoCloseStates.clear();
    for (const state of saved.states ?? []) {
      if (state.positionId) autoCloseStates.set(state.positionId, state);
    }
    autoCloseDecisions = (saved.decisions ?? []).slice(0, 40);
  } catch {
    autoCloseStates.clear();
    autoCloseDecisions = [];
  }
}

function saveAutoCloseState() {
  ensureDataDir();
  fs.writeFileSync(AUTO_CLOSE_PATH, JSON.stringify({
    states: [...autoCloseStates.values()],
    decisions: autoCloseDecisions.slice(0, 40),
  }, null, 2));
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

function snapshotEquity(force = false) {
  const now = Date.now();
  if (!force && now - lastEquitySnapshotAt < EQUITY_SNAPSHOT_MIN_MS) {
    refreshDailyPnl();
    return;
  }
  lastEquitySnapshotAt = now;
  const marks = getMarkPrices();
  const { equity, deployed } = paperDesk.markToMarket(marks);
  const port = paperDesk.snapshot();
  equityHistory.push({ t: now, equity, deployed, cash: port.cash });
  if (equityHistory.length > 2000) equityHistory.shift();
  saveEquityHistory();
  refreshDailyPnl();
  saveSessionStats();
}

async function fetchBookForCard(card: ThesisCard) {
  const raw = await fetchOrderbook(card.ticker);
  const book = sanitizeExecutableBook(raw);
  const hasAnyExecutableSurface =
    isExecutablePrice(book.yesAsk) ||
    isExecutablePrice(book.noAsk) ||
    book.yes.length > 0 ||
    book.no.length > 0;
  if (!hasAnyExecutableSurface) {
    throw new Error('book unavailable: no executable depth');
  }
  bookCache.set(card.ticker, { book, fetchedAt: Date.now() });
  return book;
}

function cachedBookForTicker(ticker: string): KalshiOrderbook | null {
  const cached = bookCache.get(ticker);
  if (!cached || Date.now() - cached.fetchedAt > BOOK_CACHE_TTL_MS) return null;
  return cached.book;
}

function prefetchBookForCard(card: ThesisCard) {
  void fetchBookForCard(card).catch(() => undefined);
}

function opportunityKey(card: Pick<ThesisCard, 'ticker' | 'side'>): string {
  return `${card.ticker}:${card.side}`;
}

function retryableFromResult(result: PaperBuyResult): boolean {
  return result.queueState === 'blocked_retryable' || isRetryableExecutionCode(result.abortCode);
}

async function executeStrictPaperBuyForCard(
  card: ThesisCard,
  contracts?: number,
  source: 'manual' | 'working-order' | 'throughput' = 'manual',
): Promise<PaperBuyResult> {
  const eligibilityBlock = entryEligibilityBlockReason(card);
  if (eligibilityBlock) {
    return {
      ok: false,
      aborted: true,
      abortReason: eligibilityBlock,
      error: eligibilityBlock,
      abortCode: 'signal_eligibility_block',
      queueState: 'blocked_final',
      wouldMutate: false,
    };
  }
  const thesisId = card.id;
  opportunityQueue.discover([card]);
  const key = opportunityKey(card);
  const risk = checkPaperRisk(card, paperDesk.snapshot(), settings, getDailyPnl());
  if (!risk.ok) {
    auditLog.append({
      action: 'gate_block',
      thesisId,
      ticker: card.ticker,
      detail: risk.error ?? 'blocked',
      ok: false,
      code: 'risk_gate_block',
      severity: 'warning',
      blocksLiveUnlock: true,
    });
    opportunityQueue.markBlocked(key, risk.error ?? 'risk gate blocked', false);
    saveAuditLog();
    return { ok: false, error: risk.error, abortCode: 'risk_gate_block', queueState: 'blocked_final', wouldMutate: false };
  }

  let book: KalshiOrderbook;
  try {
    book = await fetchBookForCard(card);
    opportunityQueue.markBookFetched(key);
  } catch (error) {
    const reason = describeError(error);
    sessionStatsData.abortCount += 1;
    opportunityQueue.markBlocked(key, `book unavailable: ${reason}`, true);
    recordPaperBlock({
      thesisId,
      ticker: card.ticker,
      detail: `${source} paper buy blocked: book unavailable (${reason})`,
      code: 'book_unavailable',
      severity: 'warning',
      blocksLiveUnlock: false,
    });
    saveSessionStats();
    return {
      ok: false,
      aborted: true,
      abortReason: `book unavailable: ${reason}`,
      error: `book unavailable: ${reason}`,
      abortCode: 'book_unavailable',
      queueState: 'blocked_retryable',
      wouldMutate: false,
    };
  }

  const startedAt = Date.now();
  const result = simulatePaperBuy(paperDesk, card, book, settings, contracts);
  if (!result.ok) {
    sessionStatsData.abortCount += 1;
    const blockReason = result.abortReason ?? result.error ?? result.abortCode ?? 'paper buy blocked';
    opportunityQueue.markBlocked(
      key,
      blockReason,
      retryableFromResult(result),
    );
    recordPaperBlock({
      thesisId,
      ticker: card.ticker,
      detail: result.abortReason ?? result.error ?? 'aborted',
      code: result.abortCode,
      severity: result.abortCode === 'strict_profit_block' ? 'info' : 'warning',
      blocksLiveUnlock: isAbnormalExecutionCode(result.abortCode),
    });
    saveSessionStats();
    return result;
  }

  if (result.profitCertificate) {
    opportunityQueue.markCertified(key, result.profitCertificate, Date.now(), Date.now() - startedAt);
  }
  opportunityQueue.markExecuted(key);
  sessionStatsData.tradeCount += 1;
  auditLog.append({
    action: 'paper_buy',
    thesisId,
    ticker: card.ticker,
    detail: `${source} filled ${result.fill?.filled}; certified pnl ${result.profitCertificate?.netPnlUsd.toFixed(2) ?? 'n/a'}`,
    ok: true,
    code: 'strict_profit_certified',
    severity: 'info',
    blocksLiveUnlock: false,
  });
  savePaperPortfolio();
  saveAuditLog();
  saveSessionStats();
  void evaluateAutoClosePositions(`${source}-paper-buy`);
  broadcastPaperUpdate(true);
  return result;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function fallbackCardForPosition(pos: PaperPosition, mark = pos.entryPrice): ThesisCard {
  return {
    id: pos.thesisId,
    ticker: pos.ticker,
    title: pos.title,
    category: pos.category ?? 'paper',
    playbook: pos.playbook as ThesisCard['playbook'],
    status: 'tradeable',
    side: pos.side,
    marketPrice: mark,
    impliedPrice: mark,
    grossEdge: 0,
    netEdge: 0,
    spread: 0.02,
    depthUsd: 100,
    predictability: 0.5,
    feeEstimate: 0,
    signalReason: 'paper position fallback',
    externalSummary: '',
    createdAt: pos.openedAt,
    updatedAt: Date.now(),
    freshnessMs: Date.now() - pos.openedAt,
    edgeHistory: [],
    drivers: [],
    invalidations: [],
  };
}

function cardForPosition(pos: PaperPosition): ThesisCard | undefined {
  return theses.find((t) => t.ticker === pos.ticker) ?? geaTheses.find((t) => t.ticker === pos.ticker);
}

function positionMark(pos: PaperPosition, card = cardForPosition(pos)): number {
  if (!card) return getMarkPrices().get(pos.ticker) ?? pos.entryPrice;
  return card.side === pos.side ? card.marketPrice : 1 - card.marketPrice;
}

function autoCloseSnapshot() {
  const openIds = new Set(paperDesk.snapshot().positions.map((p) => p.id));
  let changed = false;
  for (const id of [...autoCloseStates.keys()]) {
    if (!openIds.has(id)) {
      autoCloseStates.delete(id);
      changed = true;
    }
  }
  if (changed) saveAutoCloseState();

  const autoCloseStateByPosition: Record<string, AutoCloseState> = {};
  for (const [id, state] of autoCloseStates) autoCloseStateByPosition[id] = state;
  return {
    autoCloseStateByPosition,
    autoCloseDecisions: autoCloseDecisions.slice(0, 20),
    profitabilityBenchmark: profitabilityBenchmark.report(),
  };
}

function exitSignalFromRecommendation(packet: ExitRecommendation): AutoCloseExitSignal {
  const baseConfidence =
    packet.action === 'exit' ? 0.9 :
    packet.action === 'trim' ? 0.86 :
    packet.action === 'add-only-on-pullback' ? 0.55 :
    0.35;
  const edgePressure = packet.current_edge <= 0 ? 0.08 : packet.captured_edge > packet.current_edge ? 0.03 : 0;
  return {
    ticker: packet.ticker,
    action: packet.action,
    confidence: clamp01(baseConfidence + edgePressure),
    currentEdge: packet.current_edge,
    capturedEdge: packet.captured_edge,
    executableClosePrice: packet.executable_close_price,
    bookTimestamp: packet.book_timestamp,
    bookDepth: packet.book_depth,
    priceSource: packet.price_source,
    expiresAt: packet.expires_at,
    reason: packet.reason,
    issuedAt: packet.issued_at,
  };
}

function recordBenchmarkSample(
  strategy: 'baseline' | 'upgraded',
  pos: PaperPosition,
  contracts: number,
  pnl = 0,
  slippageUsd = 0,
  closeRegretUsd = 0,
) {
  const feePortion = pos.contracts > 0 ? (pos.fees * contracts) / pos.contracts : 0;
  profitabilityBenchmark.record(strategy, {
    id: `${strategy}:${pos.id}:${Date.now()}`,
    riskUsd: pos.entryPrice * contracts + feePortion,
    netPnlUsd: pnl,
    maxDrawdownUsd: Math.max(0, -pnl),
    closeRegretUsd,
    slippageUsd,
    falseExit: strategy === 'upgraded' && pnl < 0,
  });
}

async function executeAutoCloseDecision(pos: PaperPosition, decision: AutoCloseDecision): Promise<boolean> {
  if (decision.action === 'hold' || decision.contracts < 1) return false;
  if (settings.killSwitchActive) return false;
  const card = cardForPosition(pos);
  const mark = positionMark(pos, card);
  const closeCard = card ?? fallbackCardForPosition(pos, mark);
  const qty = Math.min(pos.contracts, decision.contracts);
  let book: KalshiOrderbook;
  try {
    book = cachedBookForTicker(pos.ticker) ?? await fetchBookForCard(closeCard);
  } catch (error) {
    const reason = describeError(error);
    recordPaperBlock({
      ticker: pos.ticker,
      detail: `auto-${decision.action} blocked: book unavailable (${reason})`,
      code: 'book_unavailable',
      severity: 'warning',
      blocksLiveUnlock: false,
    });
    saveAutoCloseState();
    return false;
  }
  const result = simulatePaperClose(
    paperDesk,
    pos.id,
    book,
    pos.side,
    mark,
    qty,
    settings,
    {
      autoCloseDecisionId: decision.id,
      autoCloseReason: decision.reason,
      autoCloseAction: decision.action,
    },
  );
  const state = autoCloseStates.get(pos.id);
  if (state) {
    state.lastDecisionAt = decision.triggeredAt;
    if (result.ok && decision.action === 'trim') {
      state.trimmedContracts += qty;
      if (/quick-profit|velocity|predictive/i.test(decision.reason)) state.earlyTrimContracts += qty;
    }
  }

  if (!result.ok) {
    recordPaperBlock({
      ticker: pos.ticker,
      detail: `auto-${decision.action} failed: ${result.error ?? 'unknown'}`,
      code: result.abortCode,
      severity: result.abortCode === 'strict_profit_block' ? 'info' : 'warning',
      blocksLiveUnlock: isAbnormalExecutionCode(result.abortCode),
    });
    saveAutoCloseState();
    return false;
  }

  autoCloseDecisions = [{ ...decision, contracts: qty }, ...autoCloseDecisions].slice(0, 40);
  recordBenchmarkSample(
    'upgraded',
    pos,
    qty,
    result.pnl ?? 0,
    result.fillQuality?.implementationShortfall ?? 0,
    Math.max(0, decision.peakPnlUsd - decision.currentPnlUsd),
  );
  sessionStatsData.tradeCount += 1;
  auditLog.append({
    action: 'paper_close',
    ticker: pos.ticker,
    detail: `auto-${decision.action}: ${decision.reason}; pnl ${result.pnl?.toFixed(2)}`,
    ok: true,
  });
  broadcastToGea({
    type: 'nemesis:close-result',
    payload: {
      ticker: pos.ticker,
      action: decision.action === 'close' ? 'close' : 'trim',
      contracts: qty,
      pnl: result.pnl ?? 0,
      was_profit: (result.pnl ?? 0) > 0,
      peak_pnl_usd: decision.peakPnlUsd,
      close_regret_usd: Math.max(0, decision.peakPnlUsd - decision.currentPnlUsd),
      closed_at: Date.now(),
      reason: decision.reason,
      tier: decision.tier ?? state?.tier ?? 'scalp',
    },
  });
  savePaperPortfolio();
  saveAutoCloseState();
  saveAuditLog();
  saveSessionStats();
  return true;
}

// Settlement sweep: resolves paper positions whose market has settled while
// the book-certified close path can no longer run (a resolved market has no
// orderbook). Without this, positions held through resolution sit open
// forever while the auto-close engine spams "book unavailable" blocks.
const settlementCheckAt = new Map<string, number>();
const SETTLEMENT_SWEEP_MS = 5 * 60_000;
const SETTLEMENT_TICKER_COOLDOWN_MS = 10 * 60_000;
let settlementSweepRunning = false;

async function sweepSettledPositions() {
  if (settlementSweepRunning) return;
  settlementSweepRunning = true;
  let settledCount = 0;
  try {
    const now = Date.now();
    const tickers = [...new Set(paperDesk.snapshot().positions.map((p) => p.ticker))]
      .filter((t) => now - (settlementCheckAt.get(t) ?? 0) >= SETTLEMENT_TICKER_COOLDOWN_MS);
    for (const ticker of tickers) {
      let market: KalshiMarket;
      try {
        market = await fetchMarket(ticker);
      } catch {
        continue; // API/network failure; retry on a later sweep
      }
      settlementCheckAt.set(ticker, now);
      for (const pos of paperDesk.snapshot().positions.filter((p) => p.ticker === ticker)) {
        const decision = resolveSettlement(market.status, market.result, pos.side);
        if (!decision) continue;
        const closed = paperDesk.closePosition(pos.id, decision.exitPrice, pos.contracts, {
          mode: 'paper',
          expectedPrice: decision.exitPrice,
          slippage: 0,
          implementationShortfall: 0,
          autoCloseReason: `settlement: market resolved ${decision.result.toUpperCase()}`,
        });
        if (!closed.ok) continue;
        settledCount += 1;
        autoCloseStates.delete(pos.id);
        sessionStatsData.tradeCount += 1;
        auditLog.append({
          action: 'paper_close',
          ticker,
          detail: `settlement: resolved ${decision.result.toUpperCase()} at $${decision.exitPrice}; pnl ${closed.pnl?.toFixed(2)}`,
          ok: true,
        });
        broadcastToGea({
          type: 'nemesis:close-result',
          payload: {
            ticker,
            action: 'close',
            contracts: pos.contracts,
            pnl: closed.pnl ?? 0,
            was_profit: (closed.pnl ?? 0) > 0,
            peak_pnl_usd: 0,
            close_regret_usd: 0,
            closed_at: Date.now(),
            reason: 'settlement',
            tier: 'scalp',
          },
        });
      }
    }
    if (settledCount > 0) {
      refreshDailyPnl();
      savePaperPortfolio();
      saveAutoCloseState();
      saveAuditLog();
      saveSessionStats();
      broadcastPaperUpdate(true);
    }
  } finally {
    settlementSweepRunning = false;
  }
}

async function evaluateAutoClosePositions(_trigger: string) {
  if (autoCloseRunning) {
    autoCloseQueued = true;
    return;
  }
  autoCloseRunning = true;
  let executed = false;
  try {
    const now = Date.now();
    const openIds = new Set<string>();
    const closable: Array<{ pos: PaperPosition; decision: AutoCloseDecision }> = [];
    const acSettings = autoCloseSettings();

    for (const pos of paperDesk.snapshot().positions) {
      openIds.add(pos.id);
      const card = cardForPosition(pos);
      if (card) prefetchBookForCard(card);
      const mark = positionMark(pos, card);
      const tickCount = Math.max(tickHistory.get(pos.ticker)?.length ?? 0, autoCloseStates.get(pos.id)?.tickCount ?? 0);
      const currentEdge = card?.netEdge ?? latestExitSignals.get(pos.ticker)?.currentEdge ?? 0;
      const nextState = updateAutoCloseState({
        position: pos,
        mark,
        currentEdge,
        tickCount,
        now,
        prior: autoCloseStates.get(pos.id),
        tier: pos.tier,
      });
      autoCloseStates.set(pos.id, nextState);

      const decision = evaluateAutoClosePosition({
        position: pos,
        mark,
        currentEdge,
        tickCount,
        now,
        state: nextState,
        settings: acSettings,
        exitSignal: latestExitSignals.get(pos.ticker),
        freshnessMs: card?.freshnessMs,
        slippagePp: card?.slippagePp ?? card?.spread,
      });

      if (decision.action === 'hold') continue;
      const cooldownMs = decision.confidence >= 0.85
        ? acSettings.highConfidenceCooldownMs
        : acSettings.minDecisionCooldownMs;
      if (nextState.lastDecisionAt && now - nextState.lastDecisionAt < cooldownMs) continue;
      nextState.lastDecisionAt = now;
      autoCloseStates.set(pos.id, nextState);
      closable.push({ pos, decision });
    }

    const results = await Promise.all(closable.map(({ pos, decision }) => executeAutoCloseDecision(pos, decision)));
    executed = results.some(Boolean);

    let pruned = false;
    for (const id of [...autoCloseStates.keys()]) {
      if (!openIds.has(id)) {
        autoCloseStates.delete(id);
        pruned = true;
      }
    }
    if (pruned || paperDesk.snapshot().positions.length > 0) saveAutoCloseState();
  } finally {
    autoCloseRunning = false;
  }
  if (executed) broadcastPaperUpdate(true);
  if (autoCloseQueued) {
    autoCloseQueued = false;
    void evaluateAutoClosePositions('queued');
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
    const promoted = { ...card, status: 'tradeable' as const };
    return isEntryEligible(promoted) ? promoted : card;
  }
  return card;
}

function applyKalshiQuote(ticker: string, yesPrice: number, spread: number) {
  let changed = false;
  const updateCard = (t: ThesisCard) => {
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
  };
  theses = theses.map(updateCard);
  geaTheses = geaTheses.map(updateCard);
  if (changed) {
    const card = theses.find((t) => t.ticker === ticker);
    if (card) {
      hotOpportunityIndex.upsert(card, {
        bridgeLatencyByTicker: new Map([[card.ticker, card.id.startsWith('gea-') && bridgeStatus.lastSeenAt ? Date.now() - bridgeStatus.lastSeenAt : 0]]),
        playbookPerformance: new Map(),
        maxRows: 25,
        targetDecisionMs: 3,
      });
      opportunityRadarRows = hotOpportunityIndex.top(25);
    }
    recordTick(ticker, yesPrice, spread, card?.netEdge ?? 0);
    const openPos = paperDesk.snapshot().positions.find((p) => p.ticker === ticker);
    const closeCard = openPos ? cardForPosition(openPos) : undefined;
    if (closeCard) prefetchBookForCard(closeCard);
    scheduleMarketStatePublish();
    void evaluateAutoClosePositions('quote');
    schedulePaperUpdate();
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
      const result = await executeStrictPaperBuyForCard(card, order.contracts, 'working-order');
      if (result.ok) {
        paperOrderBook.fill(order.id);
        savePaperOrders();
        broadcastPaperUpdate(true);
      }
    })();
  }
}

async function runThroughputCertification(trigger: string) {
  const throughput = { ...DEFAULT_OPPORTUNITY_THROUGHPUT, ...(settings.opportunityThroughput ?? {}) };
  if (!throughput.enabled || throughputRunning || settings.killSwitchActive) return;
  throughputRunning = true;
  try {
    const openKeys = new Set(paperDesk.snapshot().positions.map((p) => `${p.ticker}:${p.side}`));
    const executed = opportunityQueue.snapshot().telemetry.executedTrades;
    const remaining = throughput.maxDailyCertifiedTrades == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, throughput.maxDailyCertifiedTrades - executed);
    if (remaining <= 0) return;

    const candidates = theses
      .filter((card) => isEntryEligible(card)
        && hasRealExecutableDepth(card)
        && !openKeys.has(opportunityKey(card)))
      .sort((a, b) => {
        const edgeDelta = b.netEdge - a.netEdge;
        if (edgeDelta !== 0) return edgeDelta;
        return (a.freshnessMs ?? 0) - (b.freshnessMs ?? 0);
      })
      .slice(0, Math.min(theses.length, remaining));

    opportunityQueue.discover(candidates);
    const concurrency = Math.max(1, throughput.maxConcurrentBookFetches);
    for (let i = 0; i < candidates.length; i += concurrency) {
      const batch = candidates.slice(i, i + concurrency);
      await Promise.all(batch.map(async (card) => {
        if (paperDesk.snapshot().positions.some((p) => p.ticker === card.ticker && p.side === card.side)) return;
        await executeStrictPaperBuyForCard(card, undefined, 'throughput');
      }));
    }
    if (candidates.length > 0) {
      publishMarketState();
      broadcastToGea({
        type: 'nemesis:state',
        payload: { ...buildNemesisStateMirror(), throughputTrigger: trigger },
      });
    }
  } finally {
    throughputRunning = false;
  }
}

function broadcastPaperUpdate(forceSnapshot = false) {
  const marks = getMarkPrices();
  const mtm = paperDesk.markToMarket(marks);
  const portfolio = paperDesk.snapshot();
  const marksObj: Record<string, number> = {};
  for (const [k, v] of marks) marksObj[k] = v;
  snapshotEquity(forceSnapshot);
  broadcast('paper:update', {
    portfolio,
    marks: marksObj,
    equity: mtm.equity,
    unrealized: mtm.unrealized,
    equityHistory,
    workingOrders: paperOrderBook.working(),
    dailyPnl: sessionStatsData.dailyPnl,
    activeRegimes,
    opportunityRadar: opportunityRadarRows,
    opportunityThroughput: opportunityQueue.snapshot(),
    ...autoCloseSnapshot(),
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
    void evaluateAutoClosePositions('watched-ticker');
    schedulePaperUpdate();
  } catch {
    const jitter = (Math.random() - 0.5) * 0.02;
    const yesPrice = Math.max(0.01, Math.min(0.99, card.marketPrice + jitter));
    recordTick(watchedTicker, yesPrice, card.spread, card.netEdge);
    void evaluateAutoClosePositions('watched-ticker-fallback');
    schedulePaperUpdate();
  }
}

function broadcast(channel: string, data: unknown) {
  for (const w of [mainWindow, ...widgetWindows]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, data);
  }
}

function mergeGeaMarkets(markets: KalshiMarket[]): KalshiMarket[] {
  let merged = markets;
  for (const market of geaMarkets) {
    if (!merged.some((m) => m.ticker === market.ticker)) {
      merged = [market, ...merged];
    }
  }
  return merged;
}

function replaceGeaTheses(base: ThesisCard[]): ThesisCard[] {
  const withoutGea = base.filter((card) => !card.id.startsWith('gea-'));
  return rankThesesForUi([...geaTheses.map(applyDepthToCard), ...withoutGea]);
}

function publishMarketState(extra: Record<string, unknown> = {}) {
  broadcast('markets:update', {
    markets: marketsCache,
    theses: thesesForUi(),
    connectors: registry.getAll(),
    tradeFeed: feedHub.getTradeFeedState(),
    discovery: discovery.getState(),
    gates: evaluateGates(settings, journal.count(), settings.backtestPassed ?? false, registry.isHealthy('kalshi-rest'), settings.humanQuizPassed ?? false),
    ...extra,
  });
  broadcastDiscovery();
  broadcastWorldEvents();
}

function scheduleMarketStatePublish() {
  if (marketBroadcastTimer) return;
  marketBroadcastTimer = setTimeout(() => {
    marketBroadcastTimer = null;
    publishMarketState();
  }, MARKET_BROADCAST_THROTTLE_MS);
}

function schedulePaperUpdate() {
  if (paperBroadcastTimer) return;
  paperBroadcastTimer = setTimeout(() => {
    paperBroadcastTimer = null;
    broadcastPaperUpdate();
  }, PAPER_BROADCAST_THROTTLE_MS);
}

function applyBridgeRecommendation(packet: RecommendationPacket) {
  const market = marketsCache.find((m) => m.ticker === packet.ticker)
    ?? geaMarkets.find((m) => m.ticker === packet.ticker);
  geaMarkets = upsertRecommendationMarket(geaMarkets, packet, market);
  marketsCache = mergeGeaMarkets(marketsCache);
  geaTheses = upsertRecommendationThesis(geaTheses, packet, market).map(applyDepthToCard);
  theses = replaceGeaTheses(theses);
  opportunityQueue.discover(geaTheses.filter((c) => isEntryEligible(c)
    && hasRealExecutableDepth(c)));
  kalshiStream.track([...new Set(theses.map((t) => t.ticker))]);
  publishMarketState();
  void evaluateAutoClosePositions('bridge-entry');
  void runThroughputCertification('bridge-entry');
  broadcastPaperUpdate();
  broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });
}

function applyBridgeExitRecommendation(packet: ExitRecommendation) {
  latestExitSignals.set(packet.ticker, exitSignalFromRecommendation(packet));
  void evaluateAutoClosePositions('bridge-exit');
  broadcastPaperUpdate();
}

function withoutExecutableDepth(card: ThesisCard): ThesisCard {
  const next = { ...card };
  delete next.executableTier;
  delete next.fillableUsd;
  delete next.slippagePp;
  delete next.depthLevels;
  return next;
}

function applyDepthToCard(card: ThesisCard): ThesisCard {
  const d = discovery.getDepth(card.ticker);
  if (!d) return withoutExecutableDepth(card);
  if (Date.now() - d.verifiedAt > LIQUIDITY_PREFILTER_MAX_AGE_MS) return withoutExecutableDepth(card);
  const sideResult = card.side === 'yes' ? d.yes : d.no;
  if (!sideResult?.executableTier) return withoutExecutableDepth(card);
  return {
    ...card,
    executableTier: sideResult.executableTier,
    fillableUsd: sideResult.fillableUsd,
    slippagePp: sideResult.slippagePp,
    depthLevels: sideResult.depthLevels,
  };
}

function rankThesesForUi(cards: ThesisCard[]): ThesisCard[] {
  const base = discovery.settings.depthVerifyEnabled ? rankThesesWithTiers(cards) : rankTheses(cards);
  hotOpportunityIndex.replaceAll(base, {
    bridgeLatencyByTicker: new Map(base.map((card) => [
      card.ticker,
      card.id.startsWith('gea-') && bridgeStatus.lastSeenAt ? Date.now() - bridgeStatus.lastSeenAt : 0,
    ])),
    playbookPerformance: new Map(),
    maxRows: 25,
    targetDecisionMs: 3,
  });
  opportunityRadarRows = hotOpportunityIndex.top(25);
  return base
    .map((card, index) => ({
      card,
      index,
      score: opportunityRadarRows.find((row) => row.id === card.id)?.rankScore
        ?? scoreOpportunityForCard(card, {
          bridgeLatencyMs: card.id.startsWith('gea-') && bridgeStatus.lastSeenAt
            ? Date.now() - bridgeStatus.lastSeenAt
            : undefined,
        }).score,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.card);
}

function thesesForUi(): ThesisCard[] {
  return annotateCardsWithCertification(
    rankThesesForUi(theses),
    opportunityQueue.snapshot(),
    Date.now(),
  );
}

function certifiedQueueItemForCard(card: Pick<ThesisCard, 'ticker' | 'side'>) {
  const key = opportunityKey(card);
  const item = opportunityQueue.snapshot().items.find((candidate) => candidate.key === key);
  if (!item?.profitCertificate) return null;
  if (item.state !== 'certified') return null;
  if (item.profitCertificate.expiresAt < Date.now()) return null;
  return item;
}

function certificationBlockForCard(card: Pick<ThesisCard, 'ticker' | 'side'>): string {
  const key = opportunityKey(card);
  const item = opportunityQueue.snapshot().items.find((candidate) => candidate.key === key);
  if (item?.blockReason) return item.blockReason;
  if (item?.state === 'executed') return 'already executed';
  if (item?.state === 'book_pending') return 'awaiting executable book certification';
  return 'awaiting strict profit certification';
}

interface RefreshMarketsOptions {
  retryLiveUniverse?: boolean;
}

const runUniverseDiscovery = createSingleFlight(() => withAbortTimeout(
  (signal) => discovery.refreshUniverse(signal),
  UNIVERSE_FETCH_TIMEOUT_MS,
  'universe fetch timed out',
));

async function refreshMarkets(options: RefreshMarketsOptions = {}) {
  try {
    // Fixture data keeps the UI usable, but it must never suppress live retries.
    if (options.retryLiveUniverse !== false && !discovery.hasLiveUniverse()) {
      await runUniverseDiscovery();
    }
    // Prefer live universe; fall back to whatever marketsCache holds (fixtures or
    // a stale snapshot) so tickets are never held hostage by a slow API.
    if (discovery.getUniverse().length > 0) {
      marketsCache = mergeGeaMarkets(discovery.getUniverse());
    }
    const signalMarkets = discovery.getUniverse().length > 0
      ? discovery.getMarketsForSignals()
      : marketsCache;
    await buildThesesFromMarkets(signalMarkets);
    publishMarketState();
    broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });
    void evaluateAutoClosePositions('market-refresh');
    // Depth pass runs in background after tickets are shown; next refresh() uses results
    void discovery.runDepthPass();
  } catch (e) {
    registry.recordError('kalshi-rest', e instanceof Error ? e.message : String(e));
    if (marketsCache.length === 0) {
      marketsCache = FIXTURE_MARKETS;
      discovery.seedFixtureDepth(FIXTURE_MARKETS);
    }
    marketsCache = mergeGeaMarkets(marketsCache);
    await buildThesesFromMarkets(marketsCache);
    publishMarketState({ offline: true });
    void evaluateAutoClosePositions('market-refresh-offline');
  }
}

async function refreshUniverseLoop() {
  try {
    await runUniverseDiscovery();
    marketsCache = mergeGeaMarkets(discovery.getUniverse());
    broadcastDiscovery();
  } catch {
    /* keep cached universe — next cycle will retry */
  }
}

const runMarketRefresh = createSingleFlight(refreshMarkets);
const runUniverseRefresh = createSingleFlight(refreshUniverseLoop);

async function buildThesesFromMarkets(markets: KalshiMarket[]) {
  const feedRefresh = feedHub.refreshForMarkets(markets);
  const feedTimedOut = await Promise.race([
    feedRefresh.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), FEED_WAIT_MS)),
  ]);
  if (feedTimedOut) feedHub.kickRefresh(markets);

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
  theses = replaceGeaTheses(built);
  opportunityQueue.discover(theses.filter((c) => isEntryEligible(c)
    && hasRealExecutableDepth(c)));
  kalshiStream.track([...new Set(theses.map((t) => t.ticker))]);

  for (const c of theses) {
    recordTick(c.ticker, c.marketPrice, c.spread, c.netEdge);
  }
  broadcastPaperUpdate();
  void runThroughputCertification('market-refresh');
}

const FIXTURE_MARKETS: KalshiMarket[] = [
  { ticker: 'DEMO-WX-1', title: 'NYC High Temp > 90°F', status: 'open', yes_ask: 34, category: 'weather' },
  { ticker: 'DEMO-CRYPTO-1', title: 'BTC above $98k', status: 'open', yes_ask: 52, category: 'crypto' },
  { ticker: 'DEMO-MACRO-1', title: 'CPI above 3.2%', status: 'open', yes_ask: 41, category: 'economics' },
];

function getLiveCreds(): LiveCredentials | null {
  const apiKeyId = currentKalshiApiKeyId();
  if (!apiKeyId) return null;
  const privateKeyPem = process.env.NEMESIS_KALSHI_PRIVATE_KEY ?? decryptStoredPrivateKey(readStoredKalshiCredentials());
  if (!privateKeyPem) return null;
  return { apiKeyId, privateKeyPem };
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

function buildNemesisStateMirror(): NemesisStateMirror {
  const marks = getMarkPrices();
  const mtm = paperDesk.markToMarket(marks);
  const throughputTelemetry = opportunityQueue.snapshot().telemetry;
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
    opportunityThroughput: { ...throughputTelemetry },
    gates: gates.map((g) => g.id),
    activeRegimes,
    marketFeedReady,
    timestamp: Date.now(),
  };
}

function setupBridgeServer() {
  const port = parseInt(process.env.NEMESIS_BRIDGE_PORT ?? '7430', 10);
  let host: string;
  try {
    host = resolveBridgeHost(process.env);
  } catch (err) {
    console.warn(`[nemesis] ${err instanceof Error ? err.message : String(err)}`);
    bridgeStatus.connected = false;
    bridgeStatus.clientCount = 0;
    broadcastBridgeStatus();
    return;
  }
  const wss = new WebSocketServer({ port, host });
  wss.on('error', (err: Error) => {
    console.warn('[nemesis] Bridge server unavailable on port ' + port + ': ' + err.message);
    bridgeStatus.connected = false;
    bridgeStatus.clientCount = 0;
    broadcastBridgeStatus();
  });

  wss.on('connection', (ws: WsSocket, req) => {
    if (!isBridgeRequestAuthenticated(req.url, bridgeAuth.token)) {
      ws.close(1008, 'bridge auth required');
      return;
    }

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

        const validation = validateBridgeMessage(msg, {
          now: Date.now(),
          maxExitBookAgeMs: autoCloseSettings().maxBridgeLatencyMs,
        });
        if (!validation.ok) {
          auditLog.append({ action: 'gate_block', detail: `bridge packet rejected: ${validation.reason}`, ok: false });
          saveAuditLog();
          return;
        }

        const valid = validation.value;
        if (valid.type === 'brain:recommendation') {
          bridgeStatus.brainRole = (valid.payload as { brain_role: BridgeStatus['brainRole'] }).brain_role;
          broadcastBridgeStatus();
          applyBridgeRecommendation(valid.payload as RecommendationPacket);
          broadcast('bridge:recommendation', valid.payload);
        } else if (valid.type === 'brain:exit') {
          applyBridgeExitRecommendation(valid.payload as ExitRecommendation);
          broadcast('bridge:recommendation', valid.payload);
        } else if (valid.type === 'brain:no-trade') {
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
  let bridgeHost = '127.0.0.1';
  try {
    bridgeHost = resolveBridgeHost(process.env);
  } catch {
    // setupBridgeServer already reports the operator-facing error.
  }
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const geaRoot = path.resolve(__dirname, '..', '..', 'global-event-alpha');
  const builtMain = path.join(geaRoot, 'dist-electron', 'main.js');
  // In a packaged install, GEA ships as a bundled self-contained exe inside
  // resources/gea-app. Fall back to NEMESIS_GEA_PATH for custom overrides.
  const packedGeaExe = app.isPackaged
    ? path.join(process.resourcesPath, 'gea-app', 'Global Event Alpha.exe')
    : undefined;
  const geaPath = process.env.NEMESIS_GEA_PATH ?? packedGeaExe;
  const plan = createGeaSpawnPlan({
    platform: process.platform,
    env: process.env,
    repoRoot,
    geaRoot,
    builtMain,
    builtMainExists: fs.existsSync(builtMain),
    geaPath,
    geaPathExists: Boolean(geaPath && fs.existsSync(geaPath)),
    execPath: process.execPath,
  });
  const childEnv = createGeaChildEnv(
    process.env,
    createGeaBridgeUrl(bridgeHost, bridgePort),
    bridgeAuth.token,
  );

  if (!plan) return;
  geaProcess = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: childEnv,
    windowsHide: plan.windowsHide,
  });
  geaProcess.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[gea] ${d.toString()}`);
  });
  geaProcess.once('error', (err) => {
    console.warn(`[gea] spawn failed: ${err.message}`);
    geaProcess = null;
    setTimeout(spawnGlobalEventAlpha, 3_000);
  });
  geaProcess.once('exit', (code) => {
    console.log(`[gea] exited (code=${code ?? 'null'})`);
    geaProcess = null;
    if (code !== 0) setTimeout(spawnGlobalEventAlpha, 3_000); // auto-retry once on crash
  });
}

function buildLiveUnlockReadiness(targetStage: 'manual-live' | 'auto-live', confirmationText: string) {
  const gates = evaluateGates(settings, journal.count(), settings.backtestPassed ?? false, registry.isHealthy('kalshi-rest'), settings.humanQuizPassed ?? false);
  const port = paperDesk.snapshot();
  const closeTrades = port.trades.filter((t) => t.type === 'close');
  const wins = closeTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const riskUsd = closeTrades.reduce((sum, trade) => sum + Math.max(0, trade.price * trade.contracts), 0);
  const pnl = closeTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const slippageRows = port.trades.filter((t) => t.slippage !== undefined);
  const benchmark = profitabilityBenchmark.report();
  const shutdown = getShutdownCounters();
  return evaluateLiveUnlock({
    now: Date.now(),
    targetStage,
    currentStage: settings.liveStage ?? 'paper',
    hasCredentials: Boolean(getLiveCreds()),
    gates,
    confirmationText,
    paper: {
      tradeCount: port.trades.length,
      autoCloseDecisionCount: autoCloseDecisions.length,
      realizedPnlUsd: port.realizedPnl,
      equityAboveStart: paperDesk.markToMarket(getMarkPrices()).equity > port.startingCash,
      pnlPerRiskDollar: riskUsd > 0 ? pnl / riskUsd : 0,
      winRate: closeTrades.length > 0 ? wins / closeTrades.length : 0,
      falseExitRate: benchmark.upgraded.falseExitRate,
      avgCloseRegretUsd: benchmark.upgraded.closeRegretUsd,
      avgSlippagePp: slippageRows.length > 0
        ? slippageRows.reduce((sum, trade) => sum + Math.abs(trade.slippage ?? 0), 0) / slippageRows.length
        : 0,
      maxDrawdownUsd: Math.max(0, -sessionStatsData.dailyPnl),
      dailyLossCapUsd: settings.dailyLossCapUsd,
      shutdownTriggered: shouldShutdownSession(shutdown),
      killSwitchActive: settings.killSwitchActive,
      apiHealthy: registry.isHealthy('kalshi-rest'),
      cleanAudit: auditLog.list().slice(-100).every((entry) => entry.ok || entry.blocksLiveUnlock === false),
    },
    manualLive: { orderCount: 0, reconciled: false, riskBreaches: 0, unresolvedRejects: 0, avgSlippagePp: 0, modeledSlippagePp: settings.maxSlippagePp },
    shadowAuto: { decisions: 0, expectancy: 0, manualExpectancy: 0, falseExitRate: 0, missedTicketReduction: 0 },
    tinyAutoPilot: { trades: 0, expectancy: 0, riskBreaches: 0 },
  });
}

function invalidateLiveCertificate(reason: string) {
  if (!settings.liveUnlockCertificate && (settings.liveStage ?? 'paper') === 'paper') return;
  settings = { ...settings, liveUnlockCertificate: undefined, liveStage: 'paper', liveEnabled: false, autoLiveEnabled: false, demoMode: true, dryRun: true };
  auditLog.append({ action: 'gate_block', detail: `live certificate invalidated: ${reason}`, ok: false });
}
function setupIpc() {
  ipcMain.handle('nemesis:getState', () => {
    const targetStage = settings.liveStage === 'manual-live' ? 'auto-live' : 'manual-live';
    const confirmText = targetStage === 'auto-live' ? 'ENABLE LIVE AUTO' : 'ENABLE LIVE MANUAL';
    const liveUnlock = buildLiveUnlockReadiness(targetStage, confirmText);
    return {
      settings,
      theses: thesesForUi(),
      gates: evaluateGates(settings, journal.count(), settings.backtestPassed ?? false, registry.isHealthy('kalshi-rest'), settings.humanQuizPassed ?? false),
      connectors: registry.getAll(),
      tradeFeed: feedHub.getTradeFeedState(),
      credentialStatus: kalshiCredentialStatus(),
      journalCount: journal.count(),
      reviewOnly,
      canLive: liveUnlock.passed,
      liveUnlock,
      opportunityRadar: opportunityRadarRows,
      activeRegimes,
      dailyPnl: sessionStatsData.dailyPnl,
      humanQuizPassed: settings.humanQuizPassed ?? false,
      backtestPassed: settings.backtestPassed ?? false,
      shutdown: getShutdownCounters(),
    };
  });

  ipcMain.handle('nemesis:getMarkets', () => marketsCache);

  ipcMain.handle('nemesis:updateSettings', (_e, partial: Partial<GuardrailSettings>) => {
    if (partial.liveEnabled) {
      return { ok: false, error: 'Use the staged live unlock wizard; credentials alone cannot enable live trading' };
    }
    const legacyCredentialPayload = partial as Partial<GuardrailSettings> & { kalshiPrivateKey?: unknown };
    if (legacyCredentialPayload.kalshiPrivateKey !== undefined) {
      return { ok: false, error: 'Private keys must be saved through encrypted credential storage' };
    }
    const riskOverride = settings.liveEnabled && isRiskSettingOverride(partial);
    const credentialChange = partial.kalshiApiKeyId !== undefined;
    if ((riskOverride || credentialChange) && (settings.liveStage ?? 'paper') !== 'paper') {
      invalidateLiveCertificate(riskOverride ? 'risk setting override' : 'credential change');
    }
    settings = normalizeGuardrailSettings({
      ...settings,
      ...partial,
      liveEnabled: partial.liveEnabled === false ? false : settings.liveEnabled,
      liveStage: partial.liveEnabled === false ? 'paper' : settings.liveStage,
      autoLiveEnabled: partial.liveEnabled === false ? false : settings.autoLiveEnabled,
      autoClose: partial.autoClose
        ? { ...autoCloseSettings(), ...partial.autoClose }
        : autoCloseSettings(),
    });
    if (riskOverride) recordSettingsManualOverride();
    feedHub.setKalshiApiKey(currentKalshiApiKeyId());
    saveSettings();
    broadcast('settings:update', settings);
    void evaluateAutoClosePositions('settings');
    broadcastPaperUpdate();
    return { ok: true, settings };
  });

  ipcMain.handle('nemesis:getKalshiCredentialStatus', () => kalshiCredentialStatus());

  ipcMain.handle('nemesis:saveKalshiCredentials', (_e, input: { kalshiApiKeyId?: string; privateKeyPem?: string }) => {
    const result = persistKalshiCredentials(input ?? {});
    if (result.ok && (settings.liveStage ?? 'paper') !== 'paper') {
      invalidateLiveCertificate('credential change');
      saveSettings();
    }
    broadcast('settings:update', settings);
    return result;
  });

  ipcMain.handle('nemesis:clearKalshiCredentials', () => {
    if ((settings.liveStage ?? 'paper') !== 'paper') {
      invalidateLiveCertificate('credential change');
    }
    const status = clearStoredKalshiCredentials();
    broadcast('settings:update', settings);
    return { ok: true, status };
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
    if (!card || !isResearchSimulationEligible(card)) {
      recordDryRunInvalidation();
      return { aborted: true, abortReason: 'not tradeable' };
    }
    try {
      const book = sanitizeExecutableBook(await fetchOrderbook(card.ticker));
      const result = dryRunFill(book, card.side, 10, card.impliedPrice);
      if (result.aborted) {
        recordDryRunAbnormalExecution();
      } else {
        resetDryRunInvalidationStreak();
      }
      return result;
    } catch (error) {
      const reason = describeError(error);
      return { aborted: true, abortReason: `book unavailable: ${reason}`, abortCode: 'book_unavailable' };
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
    const targetStage = confirmText === 'ENABLE LIVE AUTO' ? 'auto-live' : 'manual-live';
    const evaluation = buildLiveUnlockReadiness(targetStage, confirmText);
    if (!evaluation.passed || !evaluation.certificate) {
      return { ok: false, error: evaluation.blockers.join('; ') || 'live unlock blocked' };
    }
    settings = normalizeGuardrailSettings({
      ...settings,
      liveEnabled: true,
      liveStage: targetStage,
      autoLiveEnabled: targetStage === 'auto-live',
      liveUnlockCertificate: evaluation.certificate,
      demoMode: false,
      dryRun: false,
      killSwitchActive: false,
    });
    recordSettingsManualOverride();
    saveSettings();
    auditLog.append({ action: 'live_order', detail: `${targetStage} enabled`, ok: true });
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
      autoClose: autoCloseSnapshot(),
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

  ipcMain.handle('nemesis:refresh', () => runMarketRefresh());

  ipcMain.handle('nemesis:liveBuy', async (_e, thesisId: string, contracts?: number, limitPrice?: number) => {
    if (!settings.liveEnabled) return { ok: false, error: 'live trading not enabled' };
    if (settings.killSwitchActive) return { ok: false, error: 'kill switch active' };
    const creds = getLiveCreds();
    if (!creds) return { ok: false, error: 'Kalshi credentials not configured' };
    const card = theses.find((t) => t.id === thesisId);
    if (!card || !isEntryEligible(card)) {
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
    const eligibilityBlock = card ? entryEligibilityBlockReason(card) : 'thesis not found';
    if (!card || eligibilityBlock) {
      return { ok: false, error: `thesis not eligible for paper trading: ${eligibilityBlock}` };
    }
    const certified = certifiedQueueItemForCard(card);
    if (!certified) {
      const reason = certificationBlockForCard(card);
      return {
        ok: false,
        aborted: true,
        error: `not strict-profit certified: ${reason}`,
        abortReason: `not strict-profit certified: ${reason}`,
        abortCode: 'not_certified',
        queueState: 'blocked_final',
        wouldMutate: false,
      };
    }
    return executeStrictPaperBuyForCard(card, contracts, 'manual');
  });

  ipcMain.handle('nemesis:paperClose', async (_e, positionId: string, contracts?: number) => {
    const pos = paperDesk.snapshot().positions.find((p) => p.id === positionId);
    if (!pos) return { ok: false, error: 'position not found' };
    const card = cardForPosition(pos);
    const expectedPrice = positionMark(pos, card);
    const qty = contracts ?? pos.contracts;
    const closeCard = card ?? fallbackCardForPosition(pos, expectedPrice);
    let book: KalshiOrderbook;
    try {
      book = cachedBookForTicker(pos.ticker) ?? await fetchBookForCard(closeCard);
    } catch (error) {
      const reason = describeError(error);
      recordPaperBlock({
        ticker: pos.ticker,
        detail: `manual close blocked: book unavailable (${reason})`,
        code: 'book_unavailable',
        severity: 'warning',
        blocksLiveUnlock: false,
      });
      return { ok: false, error: `book unavailable: ${reason}`, abortCode: 'book_unavailable', wouldMutate: false };
    }
    const result = simulatePaperClose(paperDesk, positionId, book, pos.side, expectedPrice, qty, settings);
    if (result.ok) {
      recordBenchmarkSample('baseline', pos, qty, result.pnl ?? 0, result.fillQuality?.implementationShortfall ?? 0);
      sessionStatsData.tradeCount += 1;
      auditLog.append({
        action: 'paper_close',
        ticker: pos.ticker,
        detail: `pnl ${result.pnl?.toFixed(2)}; certified ${result.profitCertificate?.netPnlUsd.toFixed(2) ?? 'n/a'}`,
        ok: true,
        code: 'strict_profit_certified',
        severity: 'info',
        blocksLiveUnlock: false,
      });
      savePaperPortfolio();
      saveAuditLog();
      saveSessionStats();
      broadcastPaperUpdate(true);
    } else {
      recordPaperBlock({
        ticker: pos.ticker,
        detail: result.error ?? 'manual close blocked',
        code: result.abortCode,
        severity: result.abortCode === 'strict_profit_block' ? 'info' : 'warning',
        blocksLiveUnlock: isAbnormalExecutionCode(result.abortCode),
      });
    }
    return result;
  });

  ipcMain.handle('nemesis:paperPreview', async (_e, thesisId: string, contracts?: number) => {
    const card = theses.find((t) => t.id === thesisId);
    if (!card) return { aborted: true, abortReason: 'thesis not found' };
    const qty = resolveContractCount(card, paperDesk.snapshot(), settings, contracts);
    try {
      const book = await fetchBookForCard(card);
      return dryRunFill(book, card.side, qty, card.impliedPrice, settings.maxSlippagePp);
    } catch (error) {
      const reason = describeError(error);
      return { aborted: true, abortReason: `book unavailable: ${reason}`, abortCode: 'book_unavailable' };
    }
  });

  ipcMain.handle('nemesis:paperPlaceLimit', (_e, thesisId: string, contracts: number, limitPrice: number) => {
    const card = theses.find((t) => t.id === thesisId);
    if (!card) return { ok: false, error: 'thesis not found' };
    const eligibilityBlock = entryEligibilityBlockReason(card);
    if (eligibilityBlock) return { ok: false, error: `thesis not eligible for paper trading: ${eligibilityBlock}` };
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
      ...autoCloseSnapshot(),
    };
  });

  ipcMain.handle('nemesis:resetPaper', (_e, startingCash?: number) => {
    const cash = (startingCash && startingCash > 0) ? startingCash : DEFAULT_PAPER_CASH;
    paperDesk.reset(cash);
    autoCloseStates.clear();
    autoCloseDecisions = [];
    latestExitSignals.clear();
    equityHistory = [{ t: Date.now(), equity: cash, deployed: 0, cash }];
    resetDailySession();
    savePaperPortfolio();
    saveEquityHistory();
    saveAutoCloseState();
    broadcastPaperUpdate(true);
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
    await runUniverseRefresh();
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
    await runMarketRefresh();
    return discovery.getState();
  });
}

function createWindow() {
  startupTrace('window-before-create');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'NEMESIS',
    show: true,
    backgroundColor: '#0a0b0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  startupTrace('window-after-create');

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
    const indexPath = path.join(__dirname, '../dist/index.html');
    startupTrace(`window-load-file:${indexPath}`);
    mainWindow.loadFile(indexPath)
      .then(() => startupTrace('window-load-file-ok'))
      .catch((err) => {
        startupTrace(`window-load-file-failed:${err instanceof Error ? err.message : String(err)}`);
        console.error('[nemesis] loadFile failed', err);
      });
  }
  startupTrace('window-create-return');
}

app.whenReady().then(() => {
  startupTrace('ready');
  loadSettings();
  startupTrace('settings');
  feedHub.setKalshiApiKey(currentKalshiApiKeyId());
  loadDiscoverySettings();
  startupTrace('discovery-settings');
  loadJournal();
  startupTrace('journal');
  loadPaperPortfolio();
  startupTrace('paper');
  loadAutoCloseState();
  startupTrace('auto-close');
  loadEquityHistory();
  startupTrace('equity-history');
  loadSessionStats();
  startupTrace('session-stats');
  loadPaperOrders();
  startupTrace('paper-orders');
  loadAuditLog();
  startupTrace('audit-log');
  kalshiStream.onQuote((q) => applyKalshiQuote(q.ticker, q.yesPrice, q.spread));
  setupIpc();
  startupTrace('ipc');
  setupBridgeServer();
  startupTrace('bridge');

  // Health broadcast starts before the window opens so the first connectors:update
  // arrives within 5 s of the renderer mounting its listener.
  setInterval(() => {
    tickApiHealthDegraded();
    processWorkingOrders();
    void evaluateAutoClosePositions('health-tick');
    broadcast('connectors:update', registry.getAll());
    if (paperDesk.snapshot().positions.length > 0) {
      broadcastPaperUpdate();
    }
  }, 5_000);

  createWindow();
  startupTrace('window-created');
  spawnGlobalEventAlpha();
  startupTrace('gea-spawned-feed-held');
  kalshiStream.start();
  startupTrace('kalshi-stream');
  feedHub.startBackgroundPolling(8_000);
  void feedHub.refreshForMarkets(FIXTURE_MARKETS);
  startupTrace('feedhub-started');

  marketsCache = mergeGeaMarkets(FIXTURE_MARKETS);
  discovery.seedFixtureDepth(FIXTURE_MARKETS);
  void buildThesesFromMarkets(marketsCache)
    .then(() => {
      publishMarketState({ offline: true });
      broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });
      void evaluateAutoClosePositions('startup-fixtures');
    })
    .catch((err) => registry.recordError('kalshi-rest', err instanceof Error ? err.message : String(err)));

  // GEA opens immediately, but its tape waits on marketFeedReady. The initial
  // NEMESIS discovery is truly aborted at the timeout so the two processes never
  // leave overlapping cold-start /markets requests behind.
  void (async () => {
    try {
      await runUniverseDiscovery();
      const universe = discovery.getUniverse();
      if (universe.length > 0) marketsCache = mergeGeaMarkets(universe);
    } catch (startupErr) {
      const cr = registry.get('kalshi-rest');
      if (cr && cr.lastSuccess === null && cr.lastError === null) {
        registry.recordError(
          'kalshi-rest',
          startupErr instanceof Error ? startupErr.message : 'startup timeout',
        );
      }
    }
    broadcast('connectors:update', registry.getAll());
    try {
      await refreshMarkets({ retryLiveUniverse: false });
    } finally {
      marketFeedReady = true;
      broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });
      startupTrace('market-feed-ready');
      setInterval(() => { void runMarketRefresh(); }, MARKET_REFRESH_MS);
      setInterval(() => { void runUniverseRefresh(); }, 60_000);
    }
  })();
  setInterval(() => { void refreshWatchedTicker(); }, WATCHED_TICK_MS);
  setTimeout(() => { void sweepSettledPositions(); }, 20_000);
  setInterval(() => { void sweepSettledPositions(); }, SETTLEMENT_SWEEP_MS);

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
