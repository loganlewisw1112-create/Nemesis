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
  DEFAULT_ENTRY_QUALIFICATION,
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
  kalshiFeeForOrder,
  isKnownKalshiFeePolicy,
  positionUnrealizedPnl,
  type AutoCloseDecision,
  type AutoCloseSettings,
  type AutoCloseState,
  type DiscoverySettings,
  type GuardrailSettings,
  type StrategyValidationStage,
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
import { ActiveTradeMarketResolver, ConnectorRegistry, FeedHub, KalshiStream, KalshiOrderbookStream, isCryptoMarket, isMacroMarket, isSportsMarket, isWeatherMarket, inferMarketGeo } from '@nemesis/connectors';
import { JournalStore } from '@nemesis/journal';
import {
  dryRunFill,
  dryRunCloseFill,
  PaperDesk,
  simulatePaperBuy,
  previewPaperBuy,
  simulatePaperClose,
  previewPaperClose,
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
  archiveAndResetPaper,
  detectRunningNemesisApplications,
  entryEligibilityBlockReason,
  isEntryEligible,
  isResearchSimulationEligible,
  type AutoCloseExitSignal,
  type LiveCredentials,
  type PaperBuyResult,
  type PaperCloseResult,
  type PaperQualificationEvent,
  type PaperQualificationSnapshot,
  EntryConfirmationEngine,
  authHeaders,
  calculateEntryEconomics,
  candidateEconomicIdentity,
  type CampaignCandidateRecord,
  type StrategyValidationEvent,
  type StrategyValidationSnapshot,
} from '@nemesis/execution';
import { StrategyQuarantine } from '@nemesis/capital';
import { tradeToThesis, weatherToThesis, macroToThesis, cryptoToThesis, globalToThesis, infraToThesis, sportsToThesis, releaseRadarWarning, scanMarketTheses } from '@nemesis/pods';
import { DiscoveryOrchestrator } from './discovery.js';
import { BookFetchCoordinator, isBookFetchBackoffError } from './bookFetchCoordinator.js';
import { dedupeByExecutionKey } from './executionConcurrency.js';
import { PaperExecutionCoordinator } from './paperExecutionCoordinator.js';
import { PaperQualificationStore } from './paperQualificationStore.js';
import { StrategyValidationStore } from './strategyValidationStore.js';
import { SevenHourCampaignStore } from './sevenHourCampaignStore.js';
import { campaignPendingCapacity, isEvidenceOnlyCampaignExecution } from './campaignRuntime.js';
import { KalshiFeePolicyResolver } from './kalshiFeePolicyResolver.js';
import { buildStrategyConfigHash, PAPER_STRATEGY_ENGINE_VERSION } from './qualificationConfig.js';
import { upsertRecommendationMarket, upsertRecommendationThesis } from './bridgeRecommendations.js';
import { createGeaBridgeUrl, createGeaChildEnv, createGeaSpawnPlan } from './geaSpawn.js';
import { createSingleFlight, withAbortTimeout } from './singleFlight.js';
import { startupTrace } from './startupTrace.js';
import { createBridgeAuth, isBridgeRequestAuthenticated, resolveBridgeHost } from './bridgeSecurity.js';
import { resolveNemesisUserDataPath } from './userDataPath.js';
import { RendererMemoryMonitor } from './rendererMemoryMonitor.js';

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
const PAPER_QUALIFICATION_PATH = path.join(DATA_DIR, 'paper-qualification-events.jsonl');
const STRATEGY_VALIDATION_PATH = path.join(DATA_DIR, 'paper-strategy-validation-events.jsonl');
const CAMPAIGN_DIR = path.join(DATA_DIR, 'evidence-campaigns');
const ACTIVE_CAMPAIGN_PATH = path.join(CAMPAIGN_DIR, 'active-campaign.json');
const BRIDGE_TELEMETRY_PATH = path.join(DATA_DIR, 'bridge-telemetry.jsonl');

const MAX_TICKS = 120;
const LIQUIDITY_PREFILTER_MAX_AGE_MS = 45_000;
const MARKET_REFRESH_MS = 15_000;
const WATCHED_TICK_MS = 1_000;
const FEED_WAIT_MS = 2_000;
const BOOK_CACHE_TTL_MS = 600;
const MARKET_BROADCAST_THROTTLE_MS = 750;
const DEGRADED_MARKET_BROADCAST_THROTTLE_MS = 3_000;
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
const activeTradeMarketResolver = new ActiveTradeMarketResolver();
const kalshiStream = new KalshiStream(registry);
const hotOpportunityIndex = new HotOpportunityIndex({ maxRows: 25, targetDecisionMs: 3 });
const journal = new JournalStore();
const quarantine = new StrategyQuarantine();
let settings: GuardrailSettings = { ...DEFAULT_GUARDRAILS };
const kalshiFeePolicyResolver = new KalshiFeePolicyResolver(
  () => settings.kalshiAccountPrecision ?? 'unknown',
);
const kalshiOrderbookStream = new KalshiOrderbookStream(registry, () => {
  const credentials = getLiveCreds();
  return credentials
    ? authHeaders(credentials.apiKeyId, credentials.privateKeyPem, 'GET', '/trade-api/ws/v2')
    : null;
});
let theses: ThesisCard[] = [];
let geaTheses: ThesisCard[] = [];
let reviewOnly = false;
let marketsCache: KalshiMarket[] = [];
let marketFeedReady = false;
let geaMarkets: KalshiMarket[] = [];
const paperDesk = new PaperDesk(DEFAULT_PAPER_CASH);
const paperBuyExecutionCoordinator = new PaperExecutionCoordinator();
const paperOrderBook = new PaperOrderBook();
const auditLog = new AuditLog();
const profitabilityBenchmark = new ProfitabilityBenchmark({ targetLiftPct: 80 });
const opportunityQueue = new OpportunityThroughputQueue(DEFAULT_OPPORTUNITY_THROUGHPUT);
let entryConfirmationEngine = new EntryConfirmationEngine(DEFAULT_ENTRY_QUALIFICATION);
let campaignEntryConfirmationEngine = new EntryConfirmationEngine(DEFAULT_ENTRY_QUALIFICATION);
const lastTickerSideExecutionAt = new Map<string, number>();
const tickHistory = new Map<string, PriceTick[]>();
const autoCloseStates = new Map<string, AutoCloseState>();
const latestExitSignals = new Map<string, AutoCloseExitSignal>();
const worstUnrealizedLossByPosition = new Map<string, number>();
const bookFetchCoordinator = new BookFetchCoordinator<KalshiOrderbook>(
  async (ticker) => {
    const streamed = kalshiOrderbookStream.getBook(ticker);
    const raw = streamed ?? await fetchOrderbook(ticker);
    const feePolicy = await kalshiFeePolicyResolver.resolve(ticker);
    const book = sanitizeExecutableBook({ ...raw, feePolicy });
    const hasAnyExecutableSurface =
      isExecutablePrice(book.yesAsk) ||
      isExecutablePrice(book.noAsk) ||
      book.yes.length > 0 ||
      book.no.length > 0;
    if (!hasAnyExecutableSurface) {
      throw new Error('book unavailable: no executable depth');
    }
    return book;
  },
  { successTtlMs: BOOK_CACHE_TTL_MS },
);
let opportunityRadarRows: OpportunityRadarRow[] = [];
let watchedTicker: string | null = null;
let activeRegimes: string[] = [];
let autoCloseDecisions: AutoCloseDecision[] = [];
let autoCloseRunning = false;
let autoCloseQueued = false;
let throughputRunning = false;
let qualificationStore: PaperQualificationStore | null = null;
let strategyValidationStore: StrategyValidationStore | null = null;
let campaignStore: SevenHourCampaignStore | null = null;
let qualificationFollowUpRunning = false;
let strategyValidationFollowUpRunning = false;
let campaignConfirmationWorkerRunning = false;
let campaignDiagnosticWorkerRunning = false;
let shutdownEvidenceRecorded = false;
let lastQualificationEquity: number | null = null;
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
let marketBroadcastThrottleMs = MARKET_BROADCAST_THROTTLE_MS;
const rendererMemoryMonitor = new RendererMemoryMonitor();

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
  lastInboundAt: null,
  lastOutboundAt: null,
  lastPongAt: null,
  lastSequenceIn: null,
  lastSequenceOut: null,
  reconnects: 0,
  disconnects: 0,
  failovers: 0,
  tapeFreshnessMs: null,
};
let bridgeConnectionCount = 0;

function refreshBridgeConnectivity(now = Date.now()): void {
  const stream = kalshiOrderbookStream.telemetry();
  bridgeStatus.tapeFreshnessMs = stream.lastExchangeTimestamp == null
    ? null
    : Math.max(0, now - stream.lastExchangeTimestamp);
  const inboundRecent = bridgeStatus.lastInboundAt != null && now - bridgeStatus.lastInboundAt <= 15_000;
  const outboundRecent = bridgeStatus.lastOutboundAt != null && now - bridgeStatus.lastOutboundAt <= 15_000;
  bridgeStatus.connected = bridgeStatus.clientCount > 0 && inboundRecent && outboundRecent;
}

function persistBridgeTelemetry(event: string, detail: Record<string, unknown> = {}): void {
  try {
    ensureDataDir();
    refreshBridgeConnectivity();
    fs.appendFileSync(BRIDGE_TELEMETRY_PATH, `${JSON.stringify({
      at: Date.now(),
      event,
      ...bridgeStatus,
      ...detail,
    })}\n`, 'utf8');
  } catch (error) {
    console.error('[nemesis] bridge telemetry persistence failed', error);
  }
}

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
  return code === 'book_unavailable' || code === 'fill_aborted' || code === 'entry_confirmation_pending';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeBookFetchError(error: unknown): string {
  return isBookFetchBackoffError(error) ? error.reason : describeError(error);
}

function strategyConfigHash(): string {
  return buildStrategyConfigHash(settings, discovery.settings);
}

function initializePaperQualification(): void {
  const existed = fs.existsSync(PAPER_QUALIFICATION_PATH);
  const portfolio = paperDesk.snapshot();
  qualificationStore = PaperQualificationStore.open(PAPER_QUALIFICATION_PATH, {
    startingCash: portfolio.startingCash,
    strategyConfigHash: strategyConfigHash(),
  });
  const initialQualification = qualificationStore.snapshot();
  lastQualificationEquity = initialQualification.endingEquity;
  worstUnrealizedLossByPosition.clear();
  for (const position of portfolio.positions) {
    worstUnrealizedLossByPosition.set(
      position.id,
      qualificationStore.tracker.worstLossForPosition(position.id),
    );
  }
  if (!initialQualification.integrityError) {
    const portfolioTradeIds = new Set(portfolio.trades.map((trade) => trade.id));
    const evidenceTradeIds = new Set(qualificationStore.tracker.allEvents().flatMap((event) =>
      event.type === 'paper_open' || event.type === 'paper_close' ? [event.trade.id] : []));
    const evidenceMismatch = portfolioTradeIds.size !== evidenceTradeIds.size
      || [...portfolioTradeIds].some((tradeId) => !evidenceTradeIds.has(tradeId));
    if (evidenceMismatch) {
      qualificationStore.record((tracker) => tracker.recordSafetyBlock(
        'qualification_evidence_incomplete',
        'paper portfolio mutations do not match the append-only qualification ledger',
      ));
    }
    if (!existed && (portfolio.trades.length > 0 || portfolio.positions.length > 0)) {
      qualificationStore.record((tracker) => tracker.recordSafetyBlock(
        'incomplete_pre_upgrade_evidence',
        'pre-upgrade portfolio is excluded; archive and reset before qualification',
      ));
    }
  }
}

function initializeStrategyValidation(): void {
  strategyValidationStore = StrategyValidationStore.open(STRATEGY_VALIDATION_PATH, {
    stage: 'shadow',
    strategyConfigHash: strategyConfigHash(),
    strategyEngineVersion: PAPER_STRATEGY_ENGINE_VERSION,
  });
  entryConfirmationEngine = new EntryConfirmationEngine({
    ...DEFAULT_ENTRY_QUALIFICATION,
    ...(settings.entryQualification ?? {}),
  });
  for (const event of strategyValidationStore.tracker.allEvents()) {
    if (event.type === 'shadow_candidate_started') entryConfirmationEngine.markSourceUsed(event.candidate.sourceSignalId);
  }
  for (const trade of paperDesk.snapshot().trades) {
    if (trade.type !== 'open' || !trade.profitCertificate?.sourceSignalId) continue;
    entryConfirmationEngine.markSourceUsed(trade.profitCertificate.sourceSignalId);
    lastTickerSideExecutionAt.set(`${trade.ticker}:${trade.side}`, trade.timestamp);
  }
}

interface ActiveCampaignPointer {
  evidenceNamespace: string;
  stage: 'instrumentation' | 'seven-hour';
  filePath: string;
}

function readActiveCampaignPointer(): ActiveCampaignPointer | null {
  if (!fs.existsSync(ACTIVE_CAMPAIGN_PATH)) return null;
  try {
    const pointer = JSON.parse(fs.readFileSync(ACTIVE_CAMPAIGN_PATH, 'utf8')) as ActiveCampaignPointer;
    if (!pointer.evidenceNamespace || !['instrumentation', 'seven-hour'].includes(pointer.stage)) return null;
    const expected = path.resolve(CAMPAIGN_DIR, `${pointer.evidenceNamespace}.jsonl`);
    if (path.resolve(pointer.filePath) !== expected) return null;
    return pointer;
  } catch {
    return null;
  }
}

function writeActiveCampaignPointer(pointer: ActiveCampaignPointer): void {
  fs.mkdirSync(CAMPAIGN_DIR, { recursive: true });
  fs.writeFileSync(ACTIVE_CAMPAIGN_PATH, JSON.stringify(pointer, null, 2), 'utf8');
}

function campaignNamespace(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('campaign evidence namespace is empty after normalization');
  return normalized;
}

function initializeEvidenceCampaign(): void {
  const requestedStage = process.env.NEMESIS_EVIDENCE_CAMPAIGN_STAGE;
  const stage = requestedStage === 'instrumentation' || requestedStage === 'seven-hour'
    ? requestedStage
    : undefined;
  const requestedNamespace = process.env.NEMESIS_EVIDENCE_NAMESPACE;
  let pointer: ActiveCampaignPointer | null = requestedNamespace && stage
    ? {
        evidenceNamespace: campaignNamespace(requestedNamespace),
        stage,
        filePath: path.join(CAMPAIGN_DIR, `${campaignNamespace(requestedNamespace)}.jsonl`),
      }
    : readActiveCampaignPointer();
  if (!pointer && stage) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const evidenceNamespace = campaignNamespace(`${stage}-${stamp}`);
    pointer = { evidenceNamespace, stage, filePath: path.join(CAMPAIGN_DIR, `${evidenceNamespace}.jsonl`) };
  }
  if (!pointer) return;

  const config = entryQualificationSettings();
  campaignEntryConfirmationEngine = new EntryConfirmationEngine(config);
  const isNewLedger = !fs.existsSync(pointer.filePath);
  const frozenCommit = process.env.NEMESIS_GIT_COMMIT;
  if (isNewLedger && !frozenCommit) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: NEMESIS_GIT_COMMIT is required');
    return;
  }
  if (isNewLedger && (settings.kalshiAccountPrecision ?? 'unknown') === 'unknown') {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: account balance precision must be explicit');
    return;
  }
  if (isNewLedger && paperDesk.snapshot().positions.length > 0) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: close all paper positions first');
    return;
  }
  campaignStore = SevenHourCampaignStore.open(pointer.filePath, {
    runId: pointer.evidenceNamespace,
    evidenceNamespace: pointer.evidenceNamespace,
    configurationHash: strategyConfigHash(),
    gitCommit: frozenCommit ?? 'resume-from-ledger',
    stage: pointer.stage,
    settings: config,
  }, config);
  writeActiveCampaignPointer(pointer);
  const snapshot = campaignStore.snapshot();
  if (!snapshot.integrityError) {
    campaignStore.record((tracker) => tracker.ensureConfiguration(strategyConfigHash()));
    for (const candidate of campaignStore.snapshot().candidates) {
      if (candidate.terminalState) continue;
      campaignEntryConfirmationEngine.restoreCandidateState({
        candidateId: candidate.candidateId,
        sourceSignalId: candidate.originalCardId,
        ticker: candidate.ticker,
        side: candidate.side,
        samples: candidate.samples,
      });
    }
  }
}

function campaignSnapshot() {
  if (!campaignStore) return null;
  try {
    campaignStore.record((tracker) => tracker.ensureConfiguration(strategyConfigHash()));
    return campaignStore.snapshot();
  } catch (error) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign failed closed', error);
    return campaignStore.snapshot();
  }
}

function sampleRendererMemory(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !campaignStore) return;
  const snapshot = campaignSnapshot();
  if (!snapshot || snapshot.manifest.status !== 'active') return;
  if (snapshot.operationalChecks.some((check) => check.name === 'renderer_memory_stable')) return;
  const devToolsClosed = !mainWindow.webContents.isDevToolsOpened();
  if (!devToolsClosed) {
    campaignStore.record((tracker) => tracker.recordOperationalCheck(
      'renderer_memory_stable',
      false,
      'DevTools must remain closed during production memory evidence',
    ));
    return;
  }
  const rendererPid = mainWindow.webContents.getOSProcessId();
  const metric = app.getAppMetrics().find((item) => item.pid === rendererPid);
  const workingSetKb = metric?.memory.workingSetSize;
  if (!workingSetKb) return;
  const assessment = rendererMemoryMonitor.add({ at: Date.now(), workingSetKb });
  if (assessment.status === 'warming') return;
  const stable = assessment.status === 'stable';
  marketBroadcastThrottleMs = stable
    ? MARKET_BROADCAST_THROTTLE_MS
    : DEGRADED_MARKET_BROADCAST_THROTTLE_MS;
  campaignStore.record((tracker) => tracker.recordOperationalCheck(
    'renderer_memory_stable',
    stable,
    stable
      ? assessment.detail
      : `${assessment.detail}; full-state broadcast throttle raised to ${marketBroadcastThrottleMs}ms`,
  ));
}

function recordCampaignOperationalTelemetry(): void {
  if (!campaignStore) return;
  const snapshot = campaignSnapshot();
  if (!snapshot || snapshot.manifest.status !== 'active') return;
  refreshBridgeConnectivity();
  if (
    bridgeStatus.connected
    && !snapshot.operationalChecks.some((check) => check.name === 'bridge_bidirectional_traffic')
  ) {
    campaignStore.record((tracker) => tracker.recordOperationalCheck(
      'bridge_bidirectional_traffic',
      true,
      `recent inbound seq ${bridgeStatus.lastSequenceIn} and outbound seq ${bridgeStatus.lastSequenceOut}`,
    ));
  }
  const orderbookTelemetry = kalshiOrderbookStream.telemetry();
  if (
    orderbookTelemetry.sequenceRegressions > 0
    && !snapshot.safetyFailures.some((failure) => failure.includes('order-book sequence regression'))
  ) {
    campaignStore.record((tracker) => tracker.recordSafetyFailure(
      `${orderbookTelemetry.sequenceRegressions} order-book sequence regression(s) detected`,
    ));
  }
}

function entryQualificationSettings() {
  return { ...DEFAULT_ENTRY_QUALIFICATION, ...(settings.entryQualification ?? {}) };
}

function strategyValidationSnapshot(): StrategyValidationSnapshot | null {
  if (!strategyValidationStore) return null;
  const snapshot = strategyValidationStore.snapshot(entryQualificationSettings());
  if (snapshot.integrityError) return snapshot;
  if (
    !snapshot.paused
    && (snapshot.strategyConfigHash !== strategyConfigHash() || snapshot.strategyEngineVersion !== PAPER_STRATEGY_ENGINE_VERSION)
  ) {
    try {
      strategyValidationStore.record((tracker) => tracker.pause('strategy configuration or engine version changed'));
    } catch (error) {
      console.error('[nemesis] strategy validation invalidation could not be persisted', error);
    }
    return strategyValidationStore.snapshot(entryQualificationSettings());
  }
  return snapshot;
}

function pilotValidationSnapshot() {
  const validation = strategyValidationSnapshot();
  const qualification = qualificationSnapshot();
  const config = entryQualificationSettings();
  const completedPositionCount = qualification?.completedPositionCount ?? 0;
  const realizedPnlUsd = qualification?.realizedPnlUsd ?? 0;
  const profitFactor = qualification?.profitFactor ?? 0;
  const winRate = qualification?.winRate ?? 0;
  const maxDrawdownUsd = qualification?.maxDrawdownUsd ?? 0;
  const falseExitRate = qualification?.automaticFalseExitRate ?? 0;
  const averageRegretUsd = qualification?.automaticAvgCloseRegretUsd ?? 0;
  const stressedNetPnlUsd = qualification?.stressedNetPnlUsd ?? 0;
  const passed = validation?.stage === 'pilot'
    && !validation.paused
    && completedPositionCount >= config.pilotMinCompleted
    && realizedPnlUsd > 0
    && profitFactor >= config.pilotMinProfitFactor
    && winRate >= config.pilotMinWinRate
    && stressedNetPnlUsd > 0
    && maxDrawdownUsd <= config.pilotMaxDrawdownUsd
    && falseExitRate <= config.pilotMaxFalseExitRate
    && averageRegretUsd <= config.pilotMaxAverageRegretUsd
    && (qualification?.blockingSafetyEventCount ?? 1) === 0
    && qualification?.configurationValid === true;
  return {
    completedPositionCount,
    realizedPnlUsd,
    profitFactor,
    winRate,
    stressedNetPnlUsd,
    maxDrawdownUsd,
    falseExitRate,
    averageRegretUsd,
    lossBudgetRemainingUsd: Math.max(0, config.pilotLossBudgetUsd + Math.min(0, realizedPnlUsd)),
    passed,
  };
}

function recordStrategyValidation(
  mutation: (tracker: StrategyValidationStore['tracker']) => StrategyValidationEvent | StrategyValidationEvent[],
): boolean {
  if (!strategyValidationStore) return false;
  try {
    strategyValidationStore.record(mutation);
    return true;
  } catch (error) {
    console.error('[nemesis] strategy validation evidence append failed', error);
    return false;
  }
}

function qualificationSnapshot(now = Date.now()): PaperQualificationSnapshot | null {
  if (!qualificationStore) return null;
  const snapshot = qualificationStore.snapshot(now);
  if (snapshot.integrityError) return snapshot;
  const actualHash = strategyConfigHash();
  if (snapshot.configurationValid && snapshot.strategyConfigHash !== actualHash) {
    try {
      qualificationStore.record((tracker) => tracker.invalidateConfiguration(actualHash, now));
    } catch (error) {
      console.error('[nemesis] qualification configuration invalidation could not be persisted', error);
    }
    return qualificationStore.snapshot(now);
  }
  return snapshot;
}

function recordQualification(
  mutation: (tracker: PaperQualificationStore['tracker']) => PaperQualificationEvent | PaperQualificationEvent[],
): void {
  if (!qualificationStore) return;
  try {
    qualificationStore.record(mutation);
  } catch (error) {
    console.error('[nemesis] qualification evidence append failed', error);
  }
}

function recordQualificationSafety(code: string, detail: string): void {
  recordQualification((tracker) => tracker.recordSafetyBlock(code, detail));
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
  const blocksLiveUnlock = input.blocksLiveUnlock ?? isAbnormalExecutionCode(input.code);
  auditLog.append({
    action: 'paper_abort',
    thesisId: input.thesisId,
    ticker: input.ticker,
    detail: input.detail,
    ok: false,
    code: input.code,
    severity: input.severity ?? (isAbnormalExecutionCode(input.code) ? 'error' : 'info'),
    blocksLiveUnlock,
  });
  recordQualification((tracker) => tracker.recordAbort(
    input.code ?? 'paper_abort',
    input.detail,
    blocksLiveUnlock,
  ));
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
  const entryQualification = {
    ...DEFAULT_ENTRY_QUALIFICATION,
    ...(settings.entryQualification ?? {}),
    ...(raw.entryQualification ?? {}),
  };
  return {
    ...DEFAULT_GUARDRAILS,
    ...raw,
    autoClose,
    strictProfitMode,
    opportunityThroughput,
    entryQualification,
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
  const campaignPrecision = process.env.NEMESIS_KALSHI_ACCOUNT_PRECISION;
  if (campaignPrecision === 'direct' || campaignPrecision === 'non_direct') {
    settings = normalizeGuardrailSettings({ ...settings, kalshiAccountPrecision: campaignPrecision });
  }
  if (process.env.NEMESIS_EVIDENCE_CAMPAIGN_STAGE) {
    settings = normalizeGuardrailSettings({
      ...settings,
      liveEnabled: false,
      liveStage: 'paper',
      autoLiveEnabled: false,
      dryRun: true,
    });
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
    marks.set(opportunityKey(t), t.marketPrice);
    if (t.side === 'yes' || !marks.has(t.ticker)) marks.set(t.ticker, t.marketPrice);
  }
  for (const position of paperDesk.snapshot().positions) {
    const book = cachedBookForTicker(position.ticker);
    const preview = book
      ? previewPaperClose(book, position.side, position.contracts, { ...settings, maxSlippagePp: 1 })
      : null;
    marks.set(
      opportunityKey(position),
      preview?.ok && preview.fill && !preview.fill.aborted ? preview.fill.fillPrice : position.entryPrice,
    );
  }
  return marks;
}

function recordQualificationEquity(at = Date.now()): number {
  const equity = paperDesk.markToMarket(getMarkPrices()).equity;
  if (lastQualificationEquity === null || Math.abs(equity - lastQualificationEquity) > 0.000001) {
    recordQualification((tracker) => tracker.recordEquity(equity, at));
    lastQualificationEquity = equity;
  }
  return equity;
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
  if (lastQualificationEquity === null || Math.abs(equity - lastQualificationEquity) > 0.000001) {
    recordQualification((tracker) => tracker.recordEquity(equity, now));
    lastQualificationEquity = equity;
  }
  saveEquityHistory();
  refreshDailyPnl();
  saveSessionStats();
}

async function fetchBookForCard(card: ThesisCard) {
  return bookFetchCoordinator.fetch(card.ticker, { allowCachedSuccess: false });
}

function cachedBookForTicker(ticker: string): KalshiOrderbook | null {
  return bookFetchCoordinator.peek(ticker);
}

function opportunityKey(card: Pick<ThesisCard, 'ticker' | 'side'>): string {
  return `${card.ticker}:${card.side}`;
}

function findCampaignCandidate(card: ThesisCard): CampaignCandidateRecord | null {
  const snapshot = campaignSnapshot();
  if (!snapshot || snapshot.manifest.status !== 'active') return null;
  const identity = candidateEconomicIdentity(card);
  return snapshot.candidates.find((candidate) => candidate.economicIdentity === identity) ?? null;
}

function enrollCampaignCandidate(card: ThesisCard, preview: PaperBuyResult, book: KalshiOrderbook, at: number): CampaignCandidateRecord | null {
  if (!campaignStore || !preview.fill || !preview.profitCertificate) return null;
  const existing = findCampaignCandidate(card);
  if (existing) return existing;
  const economics = calculateEntryEconomics({
    entryPrice: preview.fill.fillPrice,
    entryFeesUsd: preview.fill.fees,
    contracts: preview.fill.filled,
    sideFairPrice: card.impliedPrice,
    marketPrice: card.marketPrice,
    grossEdge: card.grossEdge,
    screeningNetEdge: card.netEdge,
    executableEntryNetEdge: preview.fill.netEdge,
    spread: card.spread,
    fillSlippage: preview.fill.slippage,
    feePolicy: book.feePolicy,
  });
  campaignStore.record((tracker) => tracker.enroll({
    card,
    initialFill: preview.fill!,
    economics,
    enrolledAt: at,
    diagnosticDueAt: at + entryQualificationSettings().shadowFollowUpMs,
  }));
  return findCampaignCandidate(card);
}

function retryableFromResult(result: PaperBuyResult): boolean {
  return result.queueState === 'blocked_retryable' || isRetryableExecutionCode(result.abortCode);
}

async function executeStrictPaperBuyForCard(
  card: ThesisCard,
  contracts?: number,
  source: 'manual' | 'working-order' | 'throughput' = 'manual',
): Promise<PaperBuyResult> {
  return paperBuyExecutionCoordinator.execute(
    opportunityKey(card),
    () => executeReservedStrictPaperBuyForCard(card, contracts, source),
    () => {
      const reason = 'execution already in flight for ticker-side';
      recordPaperBlock({
        thesisId: card.id,
        ticker: card.ticker,
        detail: reason,
        code: 'execution_in_flight',
        severity: 'info',
        blocksLiveUnlock: false,
      });
      return {
        ok: false,
        aborted: true,
        abortReason: reason,
        error: reason,
        abortCode: 'execution_in_flight',
        queueState: 'blocked_retryable',
        wouldMutate: false,
      };
    },
  );
}

async function executeReservedStrictPaperBuyForCard(
  card: ThesisCard,
  contracts: number | undefined,
  source: 'manual' | 'working-order' | 'throughput',
): Promise<PaperBuyResult> {
  if (source !== 'manual' && qualificationSnapshot()?.rollingLossPaused) {
    const reason = 'automatic entries paused by the rolling 20-position loss rule';
    recordPaperBlock({
      thesisId: card.id,
      ticker: card.ticker,
      detail: reason,
      code: 'rolling_loss_pause',
      severity: 'warning',
      blocksLiveUnlock: false,
    });
    return { ok: false, error: reason, abortCode: 'rolling_loss_pause', queueState: 'blocked_final', wouldMutate: false };
  }
  const activeCampaign = source === 'throughput' ? campaignSnapshot() : null;
  const evidenceOnlyCampaign = isEvidenceOnlyCampaignExecution(source, activeCampaign);
  const validation = evidenceOnlyCampaign ? null : strategyValidationSnapshot();
  if (!evidenceOnlyCampaign && (!validation || validation.integrityError)) {
    const reason = `strategy validation evidence is unavailable or corrupt: ${validation?.integrityError ?? 'store unavailable'}`;
    return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'strategy_validation_evidence_invalid', queueState: 'blocked_final', wouldMutate: false };
  }
  if (!evidenceOnlyCampaign && validation?.paused) {
    const reason = `strategy validation paused: ${validation.pauseReason ?? 'manual review required'}`;
    opportunityQueue.markBlocked(opportunityKey(card), reason, false);
    return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'strategy_validation_paused', queueState: 'blocked_final', wouldMutate: false };
  }
  const validationStage: StrategyValidationStage = evidenceOnlyCampaign ? 'shadow' : validation!.stage;
  const eligibilityBlock = entryEligibilityBlockReason(card);
  if (eligibilityBlock) {
    recordPaperBlock({
      thesisId: card.id,
      ticker: card.ticker,
      detail: eligibilityBlock,
      code: 'signal_eligibility_block',
      severity: 'info',
      blocksLiveUnlock: false,
    });
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
    recordPaperBlock({
      thesisId,
      ticker: card.ticker,
      detail: risk.error ?? 'blocked',
      code: 'risk_gate_block',
      severity: 'warning',
      blocksLiveUnlock: false,
    });
    opportunityQueue.markBlocked(key, risk.error ?? 'risk gate blocked', false);
    return { ok: false, error: risk.error, abortCode: 'risk_gate_block', queueState: 'blocked_final', wouldMutate: false };
  }

  let book: KalshiOrderbook;
  try {
    book = await fetchBookForCard(card);
    opportunityQueue.markBookFetched(key);
    if (source === 'throughput') recordQualification((tracker) => tracker.recordFunnel('books_fetched'));
  } catch (error) {
    const reason = describeBookFetchError(error);
    const backoffActive = isBookFetchBackoffError(error);
    opportunityQueue.markBlocked(key, `book unavailable: ${reason}`, true);
    if (source === 'throughput') recordQualification((tracker) => tracker.recordFunnel('books_unavailable', 1, 'book_unavailable'));
    if (!backoffActive) {
      sessionStatsData.abortCount += 1;
      recordPaperBlock({
        thesisId,
        ticker: card.ticker,
        detail: `${source} paper buy blocked: book unavailable (${reason})`,
        code: 'book_unavailable',
        severity: 'warning',
        blocksLiveUnlock: false,
      });
      saveSessionStats();
    }
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
  if (
    validationStage === 'pilot'
    && (qualificationSnapshot()?.realizedPnlUsd ?? 0) <= -entryQualificationSettings().pilotLossBudgetUsd
  ) {
    const reason = 'pilot loss budget reached';
    if (!recordStrategyValidation((tracker) => tracker.pause(reason))) {
      const evidenceReason = 'pilot loss pause could not be persisted';
      reviewOnly = true;
      return { ok: false, aborted: true, abortReason: evidenceReason, error: evidenceReason, abortCode: 'strategy_validation_evidence_invalid', queueState: 'blocked_final', wouldMutate: false };
    }
    reviewOnly = true;
    return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'pilot_loss_budget', queueState: 'blocked_final', wouldMutate: false };
  }
  if (
    validationStage === 'pilot'
    && (qualificationSnapshot()?.completedPositionCount ?? 0) >= entryQualificationSettings().pilotMinCompleted
  ) {
    const reason = 'pilot sample complete; manual stage review required';
    opportunityQueue.markBlocked(key, reason, false);
    return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'pilot_review_required', queueState: 'blocked_final', wouldMutate: false };
  }
  const entryConfig = entryQualificationSettings();
  let effectiveContracts = contracts;
  if (validationStage === 'shadow' || validationStage === 'pilot') {
    const rawAsk = card.side === 'yes' ? book.yesAsk : book.noAsk;
    if (!isExecutablePrice(rawAsk)) {
      return { ok: false, aborted: true, abortReason: 'pilot entry ask is not executable', error: 'pilot entry ask is not executable', abortCode: 'invalid_price', queueState: 'blocked_final', wouldMutate: false };
    }
    const maxPilotContracts = Math.max(1, Math.floor(entryConfig.pilotMaxEntryRiskUsd / (rawAsk + kalshiFeeForOrder(rawAsk, 1))));
    const desiredContracts = contracts ?? resolveContractCount(card, paperDesk.snapshot(), settings);
    effectiveContracts = Math.max(1, Math.min(maxPilotContracts, desiredContracts));
  }

  const beforeTradeCount = paperDesk.snapshot().trades.length;
  const preview = previewPaperBuy(paperDesk.snapshot(), card, book, settings, effectiveContracts);
  if (!preview.ok || !preview.fill || !preview.profitCertificate) {
    const blockReason = preview.abortReason ?? preview.error ?? preview.abortCode ?? 'paper buy preview blocked';
    opportunityQueue.markBlocked(key, blockReason, retryableFromResult(preview));
    recordPaperBlock({
      thesisId,
      ticker: card.ticker,
      detail: blockReason,
      code: preview.abortCode,
      severity: preview.abortCode === 'strict_profit_block' ? 'info' : 'warning',
      blocksLiveUnlock: isAbnormalExecutionCode(preview.abortCode),
    });
    sessionStatsData.abortCount += 1;
    saveSessionStats();
    return preview;
  }

  const observedAt = Date.now();
  const campaignCandidate = enrollCampaignCandidate(card, preview, book, observedAt);
  if (evidenceOnlyCampaign && !campaignCandidate) {
    const reason = 'campaign candidate evidence could not be persisted';
    opportunityQueue.markBlocked(key, reason, false);
    return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'campaign_evidence_invalid', queueState: 'blocked_final', wouldMutate: false };
  }
  if (campaignCandidate?.terminalState) {
    const reason = `campaign candidate already terminal: ${campaignCandidate.terminalState}`;
    return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'campaign_candidate_terminal', queueState: 'blocked_final', wouldMutate: false };
  }
  const priorCampaignSamples = campaignCandidate?.samples.length ?? 0;
  const confirmationCard = campaignCandidate?.card ?? card;
  const confirmationEngine = evidenceOnlyCampaign
    ? campaignEntryConfirmationEngine
    : entryConfirmationEngine;
  const confirmation = confirmationEngine.observe({
    candidateId: campaignCandidate?.candidateId,
    card: confirmationCard,
    fill: preview.fill,
    baseCertificate: preview.profitCertificate,
    bookTimestamp: book.sourceTimestamp ?? Number.NaN,
    bookSequence: book.sequence,
    feePolicy: book.feePolicy,
    observedAt,
    sourceAlreadyUsed: evidenceOnlyCampaign
      ? false
      : strategyValidationStore?.tracker.hasUsedSource(confirmationCard.id),
    lastTickerExecutionAt: lastTickerSideExecutionAt.get(key),
  });
  if (campaignCandidate && campaignStore && confirmation.samples > priorCampaignSamples && book.sequence != null && book.sourceTimestamp != null) {
    const operationalChecks = campaignStore.snapshot().operationalChecks;
    if (!operationalChecks.some((check) => check.name === 'exchange_book_time_available' && check.passed)) {
      campaignStore.record((tracker) => tracker.recordOperationalCheck(
        'exchange_book_time_available',
        true,
        `exchange sequence ${book.sequence} observed ${Math.max(0, observedAt - book.sourceTimestamp!)}ms after matching-engine timestamp`,
        observedAt,
      ));
    }
    campaignStore.record((tracker) => tracker.recordSample(campaignCandidate.candidateId, {
      at: observedAt,
      observedAt,
      netEdge: preview.fill!.netEdge,
      spread: card.spread,
      bookTimestamp: book.sourceTimestamp!,
      bookSequence: book.sequence!,
      exchangeTimestamp: book.sourceTimestamp!,
      exchangeSequence: book.sequence!,
      fillPrice: preview.fill!.fillPrice,
      filled: preview.fill!.filled,
      fees: preview.fill!.fees,
      feePolicyKnown: isKnownKalshiFeePolicy(book.feePolicy),
    }));
  }
  if (campaignCandidate && campaignStore && confirmation.status !== 'pending') {
    campaignStore.record((tracker) => tracker.terminalize(
      campaignCandidate.candidateId,
      confirmation.status === 'ready' ? 'ready' : 'rejected',
      confirmation.reason,
      observedAt,
    ));
  }
  const confirmationRecorded = evidenceOnlyCampaign || recordStrategyValidation((tracker) => tracker.recordEntryConfirmation({
    sourceSignalId: card.id,
    ticker: card.ticker,
    side: card.side,
    status: confirmation.status,
    reason: confirmation.reason,
    samples: confirmation.samples,
    windowMs: confirmation.windowMs,
    edgeRetention: confirmation.edgeRetention,
    targetRewardUsd: confirmation.targetRewardUsd,
    expectedRewardUsd: confirmation.expectedRewardUsd,
    plannedLossUsd: confirmation.plannedLossUsd,
    rewardRiskRatio: confirmation.rewardRiskRatio,
    stressedNetPnlUsd: confirmation.stressedNetPnlUsd,
    economics: confirmation.economics,
  }));
  if (!confirmationRecorded) {
    const reason = 'entry confirmation evidence could not be persisted';
    opportunityQueue.markBlocked(key, reason, false);
    return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'strategy_validation_evidence_invalid', queueState: 'blocked_final', wouldMutate: false };
  }
  if (confirmation.status !== 'ready' || !confirmation.certificate) {
    const retryable = confirmation.status === 'pending';
    const code = retryable ? 'entry_confirmation_pending' : 'entry_confirmation_rejected';
    opportunityQueue.markBlocked(key, confirmation.reason, retryable);
    recordPaperBlock({
      thesisId,
      ticker: card.ticker,
      detail: confirmation.reason,
      code,
      severity: 'info',
      blocksLiveUnlock: false,
    });
    return {
      ok: false,
      aborted: true,
      abortReason: confirmation.reason,
      error: confirmation.reason,
      abortCode: code,
      queueState: retryable ? 'blocked_retryable' : 'blocked_final',
      wouldMutate: false,
    };
  }

  if (campaignCandidate) {
    opportunityQueue.markBlocked(key, 'campaign candidate ready without paper mutation', false);
    return {
      ok: false,
      aborted: true,
      abortReason: 'campaign candidate ready without paper mutation',
      abortCode: 'campaign_candidate_ready',
      queueState: 'blocked_final',
      wouldMutate: false,
      fill: preview.fill,
      fillQuality: preview.fillQuality,
      profitCertificate: confirmation.certificate,
    };
  }

  if (validationStage === 'shadow') {
    const candidateId = `shadow-${card.id}`;
    const candidateRecorded = recordStrategyValidation((tracker) => tracker.startShadowCandidate({
      id: candidateId,
      sourceSignalId: card.id,
      ticker: card.ticker,
      side: card.side,
      playbook: card.playbook,
      startedAt: Date.now(),
      dueAt: Date.now() + entryConfig.shadowFollowUpMs,
      contracts: preview.fill!.filled,
      entryPrice: preview.fill!.fillPrice,
      entryFeesUsd: preview.fill!.fees,
      initialNetEdge: confirmation.certificate!.initialNetEdge ?? preview.fill!.netEdge,
      targetRewardUsd: confirmation.targetRewardUsd,
      expectedRewardUsd: confirmation.expectedRewardUsd,
      plannedLossUsd: confirmation.plannedLossUsd,
      rewardRiskRatio: confirmation.rewardRiskRatio,
      stressedTargetNetPnlUsd: confirmation.stressedNetPnlUsd,
      stressedExpectedNetPnlUsd: confirmation.stressedNetPnlUsd,
    }));
    if (!candidateRecorded) {
      const reason = 'shadow candidate evidence could not be persisted';
      opportunityQueue.markBlocked(key, reason, false);
      return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'strategy_validation_evidence_invalid', queueState: 'blocked_final', wouldMutate: false };
    }
    entryConfirmationEngine.markSourceUsed(card.id);
    opportunityQueue.markBlocked(key, 'shadow candidate started without paper mutation', false);
    auditLog.append({
      action: 'gate_block',
      thesisId,
      ticker: card.ticker,
      detail: 'shadow candidate started without paper mutation',
      ok: false,
      code: 'shadow_candidate_started',
      severity: 'info',
      blocksLiveUnlock: false,
    });
    saveAuditLog();
    return {
      ok: false,
      aborted: true,
      abortReason: 'shadow candidate started without paper mutation',
      abortCode: 'shadow_candidate_started',
      queueState: 'blocked_final',
      wouldMutate: false,
      fill: preview.fill,
      fillQuality: preview.fillQuality,
      profitCertificate: confirmation.certificate,
    };
  }

  const result = simulatePaperBuy(
    paperDesk,
    card,
    book,
    settings,
    effectiveContracts,
    confirmation.certificate,
  );
  const afterPortfolio = paperDesk.snapshot();
  if (!result.ok) {
    if (afterPortfolio.trades.length !== beforeTradeCount) {
      recordQualificationSafety('mutation_after_failed_gate', `${card.ticker}:${card.side} changed paper trades after a failed buy`);
    }
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
    if (source === 'throughput') recordQualification((tracker) => tracker.recordFunnel('certified'));
  }
  entryConfirmationEngine.markSourceUsed(card.id);
  lastTickerSideExecutionAt.set(key, Date.now());
  opportunityQueue.markExecuted(key);
  if (source === 'throughput') recordQualification((tracker) => tracker.recordFunnel('executed'));
  if (afterPortfolio.trades.length > beforeTradeCount + 1) {
    recordQualificationSafety('duplicate_paper_mutation', `${card.ticker}:${card.side} paper buy created more than one trade`);
  } else if (afterPortfolio.trades.length !== beforeTradeCount + 1) {
    recordQualificationSafety('accounting_mismatch', `${card.ticker}:${card.side} paper buy did not create exactly one trade`);
  }
  const openedTrade = afterPortfolio.trades[0];
  if (openedTrade?.type === 'open' && openedTrade.ticker === card.ticker && openedTrade.side === card.side) {
    recordQualification((tracker) => tracker.recordOpen(openedTrade));
    worstUnrealizedLossByPosition.set(openedTrade.positionId, worstUnrealizedLossByPosition.get(openedTrade.positionId) ?? 0);
  } else {
    recordQualificationSafety('accounting_mismatch', `${card.ticker}:${card.side} paper buy trade evidence is missing or inconsistent`);
  }
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

function cardForTickerSide(ticker: string, side: 'yes' | 'no'): ThesisCard | undefined {
  return theses.find((card) => card.ticker === ticker && card.side === side)
    ?? geaTheses.find((card) => card.ticker === ticker && card.side === side);
}

function cardForPosition(pos: PaperPosition): ThesisCard | undefined {
  return cardForTickerSide(pos.ticker, pos.side);
}

function positionMark(pos: PaperPosition, card = cardForPosition(pos)): number {
  const marks = getMarkPrices();
  return marks.get(opportunityKey(pos)) ?? (card ? card.marketPrice : pos.entryPrice);
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
    side: packet.side,
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

function recordQualificationClose(
  strategy: 'baseline' | 'upgraded' | 'settlement',
  pos: PaperPosition,
  contracts: number,
  result: PaperCloseResult,
): void {
  const portfolio = paperDesk.snapshot();
  const trade = portfolio.trades[0];
  const remainingContracts = portfolio.positions.find((row) => row.id === pos.id)?.contracts ?? 0;
  if (!trade || trade.type !== 'close' || trade.positionId !== pos.id || trade.contracts !== contracts) {
    recordQualificationSafety('accounting_mismatch', `${pos.ticker}:${pos.side} close trade evidence is missing or inconsistent`);
    return;
  }

  const feePortion = pos.contracts > 0 ? (pos.fees * contracts) / pos.contracts : 0;
  const entryRiskUsd = pos.entryPrice * contracts + feePortion;
  const maxDrawdownUsd = Math.max(
    worstUnrealizedLossByPosition.get(pos.id) ?? 0,
    qualificationStore?.tracker.worstLossForPosition(pos.id) ?? 0,
  );
  recordQualification((tracker) => tracker.recordClose({
    trade,
    strategy,
    entryRiskUsd,
    maxDrawdownUsd,
    remainingContracts,
  }));

  if (strategy !== 'settlement') {
    const sequence = qualificationStore?.snapshot().lastSequence ?? trade.timestamp;
    recordQualification((tracker) => tracker.startCloseFollowUp({
      id: `qfu-${trade.id}-${strategy}-${sequence}`,
      strategy,
      positionId: pos.id,
      ticker: pos.ticker,
      side: pos.side,
      contracts,
      actualNetProceedsUsd: trade.price * contracts - trade.fees,
      entryRiskUsd,
      netPnlUsd: trade.pnl ?? result.pnl ?? 0,
      maxDrawdownUsd,
      slippageUsd: result.fillQuality?.implementationShortfall
        ?? Math.abs(trade.slippage ?? 0) * contracts,
      startedAt: trade.timestamp,
    }));
  }

  recordQualificationEquity(trade.timestamp);
  const snapshot = qualificationSnapshot(trade.timestamp);
  if (
    snapshot
    && snapshot.completedPositionCount >= 20
    && !snapshot.rollingLossPaused
    && (snapshot.rollingTwentyPnlUsd <= 0 || snapshot.rollingTwentyProfitFactor <= 1)
  ) {
    recordQualification((tracker) => tracker.recordRollingLossPause(
      `latest 20 positions: net $${snapshot.rollingTwentyPnlUsd.toFixed(2)}, profit factor ${snapshot.rollingTwentyProfitFactor.toFixed(3)}`,
      trade.timestamp,
    ));
    reviewOnly = true;
  }
  const validation = strategyValidationSnapshot();
  if (validation?.stage === 'pilot' && snapshot) {
    const pilotConfig = entryQualificationSettings();
    const budgetFailed = snapshot.realizedPnlUsd <= -pilotConfig.pilotLossBudgetUsd;
    const earlyFailed = snapshot.completedPositionCount >= 10
      && snapshot.realizedPnlUsd <= 0
      && snapshot.profitFactor < 0.75;
    if ((budgetFailed || earlyFailed) && !validation.paused) {
      const reason = budgetFailed
        ? 'pilot loss budget reached'
        : 'pilot first 10 positions have non-positive P&L and profit factor below 0.75';
      recordStrategyValidation((tracker) => tracker.pause(reason, trade.timestamp));
      reviewOnly = true;
    }
  }
  if (remainingContracts === 0) worstUnrealizedLossByPosition.delete(pos.id);
  void evaluateQualificationFollowUps();
}

async function evaluateQualificationFollowUps(): Promise<void> {
  if (!qualificationStore || qualificationFollowUpRunning) return;
  qualificationFollowUpRunning = true;
  try {
    const now = Date.now();
    for (const followUp of qualificationStore.tracker.pendingFollowUps()) {
      try {
        const book = await bookFetchCoordinator.fetch(followUp.ticker, { allowCachedSuccess: false });
        const fill = dryRunCloseFill(book, followUp.side, followUp.contracts, 0, 1);
        if (!fill.aborted && fill.filled === followUp.contracts && isExecutablePrice(fill.fillPrice)) {
          const hypotheticalNetProceedsUsd = fill.fillPrice * fill.filled - kalshiFeeForOrder(fill.fillPrice, fill.filled);
          recordQualification((tracker) => tracker.observeCloseFollowUp(followUp.id, hypotheticalNetProceedsUsd, now));
        }
      } catch {
        // Missing executable follow-up books remain pending until the 15-minute scoring deadline.
      }
    }
    recordQualification((tracker) => tracker.scoreDueFollowUps(now));
  } finally {
    qualificationFollowUpRunning = false;
  }
}

async function evaluateStrategyValidationFollowUps(): Promise<void> {
  if (!strategyValidationStore || strategyValidationFollowUpRunning) return;
  const snapshot = strategyValidationSnapshot();
  if (!snapshot || snapshot.stage !== 'shadow' || snapshot.paused) return;
  strategyValidationFollowUpRunning = true;
  try {
    const now = Date.now();
    for (const candidate of strategyValidationStore.tracker.pendingCandidates()) {
      try {
        const book = await bookFetchCoordinator.fetch(candidate.ticker, { allowCachedSuccess: false });
        const fill = dryRunCloseFill(book, candidate.side, candidate.contracts, candidate.entryPrice, settings.maxSlippagePp);
        if (fill.aborted || fill.filled !== candidate.contracts || !isExecutablePrice(fill.fillPrice)) continue;
        const entryCost = candidate.entryPrice * candidate.contracts + candidate.entryFeesUsd;
        const executableNetPnlUsd = fill.fillPrice * fill.filled - fill.fees - entryCost;
        const stressedPrice = Math.max(0.01, fill.fillPrice - 0.01);
        const stressedNetPnlUsd = stressedPrice * fill.filled
          - kalshiFeeForOrder(stressedPrice, fill.filled)
          - entryCost;
        const currentEdge = cardForTickerSide(candidate.ticker, candidate.side)?.netEdge ?? 0;
        recordStrategyValidation((tracker) => tracker.observeShadowCandidate(
          candidate.id,
          executableNetPnlUsd,
          stressedNetPnlUsd,
          currentEdge,
          now,
        ));
        const observations = strategyValidationStore.tracker.recentObservations(candidate.id, 3);
        const edgeGone = observations.length >= 3 && observations.every((observation) => observation.netEdge <= 0);
        const targetRewardUsd = candidate.targetRewardUsd ?? candidate.expectedRewardUsd;
        const hitTarget = Number.isFinite(targetRewardUsd) && executableNetPnlUsd >= targetRewardUsd!;
        const hitLoss = executableNetPnlUsd <= -candidate.plannedLossUsd;
        const due = now >= candidate.dueAt;
        if (hitTarget || hitLoss || edgeGone || due) {
          const closeReason = hitTarget
            ? 'shadow target reached'
            : hitLoss
              ? 'shadow planned-loss limit reached'
              : edgeGone
                ? 'shadow edge gone for three executable observations'
                : 'shadow 15-minute follow-up complete';
          recordStrategyValidation((tracker) => tracker.scoreShadowCandidate(
            candidate.id,
            executableNetPnlUsd,
            stressedNetPnlUsd,
            closeReason,
            now,
          ));
        }
      } catch {
        // Missing executable books remain pending and never count as scored evidence.
      }
    }
  } finally {
    strategyValidationFollowUpRunning = false;
  }
}

async function executeAutoCloseDecision(
  pos: PaperPosition,
  decision: AutoCloseDecision,
  prepared?: { book: KalshiOrderbook; mark: number },
): Promise<boolean> {
  if (decision.action === 'hold' || decision.contracts < 1) return false;
  if (settings.killSwitchActive) return false;
  const card = cardForPosition(pos);
  const mark = prepared?.mark ?? positionMark(pos, card);
  const closeCard = card ?? fallbackCardForPosition(pos, mark);
  const qty = Math.min(pos.contracts, decision.contracts);
  let book: KalshiOrderbook;
  try {
    book = prepared?.book ?? cachedBookForTicker(pos.ticker) ?? await fetchBookForCard(closeCard);
  } catch (error) {
    if (!isBookFetchBackoffError(error)) {
      const reason = describeBookFetchError(error);
      recordPaperBlock({
        ticker: pos.ticker,
        detail: `auto-${decision.action} blocked: book unavailable (${reason})`,
        code: 'book_unavailable',
        severity: 'warning',
        blocksLiveUnlock: false,
      });
      saveAutoCloseState();
    }
    return false;
  }
  const closeSettings = /^emergency close:/i.test(decision.reason)
    ? {
      ...settings,
      maxSlippagePp: 1,
      strictProfitMode: {
        ...DEFAULT_STRICT_PROFIT_MODE,
        ...(settings.strictProfitMode ?? {}),
        allowEmergencyLossClose: true,
      },
    }
    : settings;
  const result = simulatePaperClose(
    paperDesk,
    pos.id,
    book,
    pos.side,
    mark,
    qty,
    closeSettings,
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
  recordQualificationClose('upgraded', pos, qty, result);
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
        recordQualificationClose('settlement', pos, pos.contracts, closed);
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
    const closable: Array<{ pos: PaperPosition; decision: AutoCloseDecision; book: KalshiOrderbook; mark: number }> = [];
    const acSettings = autoCloseSettings();
    const bookByTicker = new Map<string, Promise<KalshiOrderbook>>();

    for (const pos of paperDesk.snapshot().positions) {
      openIds.add(pos.id);
      const card = cardForPosition(pos);
      const closeCard = card ?? fallbackCardForPosition(pos);
      let bookPromise = bookByTicker.get(pos.ticker);
      if (!bookPromise) {
        bookPromise = fetchBookForCard(closeCard);
        bookByTicker.set(pos.ticker, bookPromise);
      }
      let book: KalshiOrderbook;
      try {
        book = await bookPromise;
      } catch {
        continue;
      }
      const closePreview = previewPaperClose(book, pos.side, pos.contracts, { ...settings, maxSlippagePp: 1 });
      if (!closePreview.ok || !closePreview.fill || closePreview.fill.aborted) continue;
      const mark = closePreview.fill.fillPrice;
      const tickCount = Math.max(tickHistory.get(pos.ticker)?.length ?? 0, autoCloseStates.get(pos.id)?.tickCount ?? 0);
      const exitSignal = latestExitSignals.get(opportunityKey(pos));
      const currentEdge = card?.netEdge ?? exitSignal?.currentEdge ?? 0;
      const unrealizedPnl = positionUnrealizedPnl(pos, mark);
      const priorWorstLoss = Math.max(
        worstUnrealizedLossByPosition.get(pos.id) ?? 0,
        qualificationStore?.tracker.worstLossForPosition(pos.id) ?? 0,
      );
      const nextWorstLoss = Math.max(priorWorstLoss, Math.max(0, -unrealizedPnl));
      worstUnrealizedLossByPosition.set(pos.id, nextWorstLoss);
      if (nextWorstLoss > priorWorstLoss) {
        recordQualification((tracker) => tracker.recordPositionWorstLoss(pos.id, nextWorstLoss, now));
      }
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
        exitSignal,
        freshnessMs: card?.freshnessMs,
        slippagePp: closePreview.fill.slippage,
      });

      if (decision.action === 'hold') continue;
      const cooldownMs = decision.confidence >= 0.85
        ? acSettings.highConfidenceCooldownMs
        : acSettings.minDecisionCooldownMs;
      if (nextState.lastDecisionAt && now - nextState.lastDecisionAt < cooldownMs) continue;
      nextState.lastDecisionAt = now;
      autoCloseStates.set(pos.id, nextState);
      closable.push({ pos, decision, book, mark });
    }

    recordQualificationEquity(now);
    const results = await Promise.all(closable.map(({ pos, decision, book, mark }) =>
      executeAutoCloseDecision(pos, decision, { book, mark })));
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
  if (shutdown && !shutdownEvidenceRecorded) {
    shutdownEvidenceRecorded = true;
    recordQualificationSafety('shutdown_event', 'session shutdown counters triggered');
  }
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
    recordQualificationEquity();
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
  if (
    !throughput.enabled
    || throughputRunning
    || settings.killSwitchActive
    || qualificationSnapshot()?.rollingLossPaused
  ) return;
  throughputRunning = true;
  try {
    const openKeys = new Set(paperDesk.snapshot().positions.map((p) => `${p.ticker}:${p.side}`));
    const executed = opportunityQueue.snapshot().telemetry.executedTrades;
    const remaining = throughput.maxDailyCertifiedTrades == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, throughput.maxDailyCertifiedTrades - executed);
    if (remaining <= 0) return;

    recordQualification((tracker) => tracker.recordFunnel('raw_candidates', theses.length));
    const rankedCandidates = theses
      .filter((card) => isEntryEligible(card)
        && hasRealExecutableDepth(card)
        && !openKeys.has(opportunityKey(card)))
      .sort((a, b) => {
        const edgeDelta = b.netEdge - a.netEdge;
        if (edgeDelta !== 0) return edgeDelta;
        return (a.freshnessMs ?? 0) - (b.freshnessMs ?? 0);
      });
    recordQualification((tracker) => tracker.recordFunnel('entry_eligible', rankedCandidates.length));
    const deduplicatedCandidates = dedupeByExecutionKey(rankedCandidates, opportunityKey);
    const duplicateCount = rankedCandidates.length - deduplicatedCandidates.length;
    if (duplicateCount > 0) {
      recordQualification((tracker) => tracker.recordFunnel('duplicates_removed', duplicateCount, 'duplicate_execution_key'));
    }
    const throughputCampaign = campaignSnapshot();
    const validation = strategyValidationSnapshot();
    const pendingCapacity = throughputCampaign?.manifest.status === 'active'
      ? campaignPendingCapacity(throughputCampaign, entryQualificationSettings().maxPendingCandidates)
      : validation?.stage === 'shadow'
        ? Math.max(0, entryQualificationSettings().maxPendingCandidates - validation.shadowPendingCount)
        : entryQualificationSettings().maxPendingCandidates;
    const candidates = deduplicatedCandidates
      .slice(0, Math.min(
        rankedCandidates.length,
        remaining,
        pendingCapacity,
      ));

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

async function evaluateCampaignConfirmations(): Promise<void> {
  if (campaignConfirmationWorkerRunning || !campaignStore) return;
  const snapshot = campaignSnapshot();
  if (!snapshot || snapshot.manifest.status !== 'active') return;
  const now = Date.now();
  if (now >= snapshot.manifest.cutoffAt) {
    campaignStore.record((tracker) => tracker.finalize(now));
    return;
  }
  const pending = snapshot.candidates.filter((candidate) => !candidate.terminalState).slice(0, 4);
  if (pending.length === 0) return;
  campaignConfirmationWorkerRunning = true;
  try {
    await Promise.all(pending.map(async (candidate) => {
      const result = await executeStrictPaperBuyForCard(
        candidate.card,
        candidate.initialFill.contracts,
        'throughput',
      );
      if (
        campaignStore
        && !['book_unavailable', 'entry_confirmation_pending', 'execution_in_flight'].includes(result.abortCode ?? '')
        && !['campaign_candidate_ready', 'campaign_candidate_terminal'].includes(result.abortCode ?? '')
      ) {
        campaignStore.record((tracker) => tracker.terminalize(
          candidate.candidateId,
          'rejected',
          result.abortReason ?? result.error ?? 'campaign confirmation failed closed',
        ));
      }
    }));
  } finally {
    campaignConfirmationWorkerRunning = false;
  }
}

async function evaluateCampaignDiagnostics(): Promise<void> {
  if (campaignDiagnosticWorkerRunning || !campaignStore) return;
  const snapshot = campaignSnapshot();
  if (!snapshot || snapshot.manifest.status !== 'active') return;
  const now = Date.now();
  if (now >= snapshot.manifest.cutoffAt) {
    campaignStore.record((tracker) => tracker.finalize(now));
    return;
  }
  const due = snapshot.diagnostics.filter((diagnostic) =>
    diagnostic.status === 'scheduled'
    && diagnostic.dueAt <= now
    && (diagnostic.lastAttemptAt == null || now - diagnostic.lastAttemptAt >= 30_000)).slice(0, 4);
  if (due.length === 0) return;
  campaignDiagnosticWorkerRunning = true;
  try {
    await Promise.all(due.map(async (diagnostic) => {
      const candidate = snapshot.candidates.find((item) => item.candidateId === diagnostic.candidateId);
      if (!candidate || !campaignStore) return;
      campaignStore.record((tracker) => tracker.recordDiagnosticAttempt(
        diagnostic.diagnosticId,
        'executable 15-minute follow-up requested',
        now,
      ));
      try {
        const book = await fetchBookForCard(candidate.card);
        const fill = dryRunCloseFill(
          book,
          candidate.side,
          candidate.initialFill.filled,
          candidate.initialFill.fillPrice,
          settings.maxSlippagePp,
        );
        const fresh = book.sourceTimestamp != null
          && book.sequence != null
          && now - book.sourceTimestamp <= entryQualificationSettings().maxBookAgeMs;
        const valid = !fill.aborted
          && fill.filled === candidate.initialFill.filled
          && fill.feePolicyKnown
          && fresh;
        if (!valid) return;
        const entryCost = candidate.initialFill.fillPrice * candidate.initialFill.filled + candidate.initialFill.fees;
        const netPnl = fill.fillPrice * fill.filled - fill.fees - entryCost;
        campaignStore.record((tracker) => tracker.completeDiagnostic({
          diagnosticId: diagnostic.diagnosticId,
          validExecutableObservation: true,
          exchangeTimestamp: book.sourceTimestamp,
          exchangeSequence: book.sequence,
          executableFollowUpMark: fill.fillPrice,
          reconstructedExitFill: fill,
          executableNetPnlUsd: Number(netPnl.toFixed(6)),
          targetAt: netPnl >= candidate.economics.targetRewardUsd ? now : undefined,
          lossAt: netPnl <= -candidate.economics.plannedLossUsd ? now : undefined,
          edgeGoneAt: netPnl <= 0 ? now : undefined,
          reason: 'valid executable follow-up reconstructed from exchange-sequenced depth and resolved fees',
          completedAt: now,
        }));
      } catch {
        // The scheduled diagnostic remains retryable until the fixed campaign cutoff.
      }
    }));
  } finally {
    campaignDiagnosticWorkerRunning = false;
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
    paperQualification: qualificationSnapshot(),
    strategyValidation: strategyValidationSnapshot(),
    evidenceCampaign: campaignSnapshot(),
    orderbookStream: kalshiOrderbookStream.telemetry(),
    pilotValidation: pilotValidationSnapshot(),
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
  }, marketBroadcastThrottleMs);
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
  kalshiOrderbookStream.track([...new Set(theses.map((t) => t.ticker))]);
  publishMarketState();
  void evaluateAutoClosePositions('bridge-entry');
  void runThroughputCertification('bridge-entry');
  broadcastPaperUpdate();
  broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });
}

function applyBridgeExitRecommendation(packet: ExitRecommendation) {
  latestExitSignals.set(opportunityKey(packet), exitSignalFromRecommendation(packet));
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

  const activeTradeMarkets = await activeTradeMarketResolver.resolve(feedHub.getTradeTape(), markets);
  if (activeTradeMarkets.length > 0) {
    discovery.prioritizeMarkets(activeTradeMarkets);
    const activeTickers = new Set(activeTradeMarkets.map((market) => market.ticker));
    markets = [...activeTradeMarkets, ...markets.filter((market) => !activeTickers.has(market.ticker))];
    marketsCache = mergeGeaMarkets([
      ...activeTradeMarkets,
      ...marketsCache.filter((market) => !activeTickers.has(market.ticker)),
    ]);
  }

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
  kalshiOrderbookStream.track([...new Set(theses.map((t) => t.ticker))]);

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
  refreshBridgeConnectivity();
  broadcast('bridge:status', { ...bridgeStatus });
}

function broadcastToGea(msg: Omit<NemesisBridgeMessage, 'seq'>) {
  const full: NemesisBridgeMessage = { ...msg, seq: ++bridgeSeq };
  const json = JSON.stringify(full);
  let sent = false;
  for (const client of bridgeClients) {
    if (client.readyState === WsSocket.OPEN) {
      client.send(json);
      sent = true;
    }
  }
  if (sent) {
    bridgeStatus.lastOutboundAt = Date.now();
    bridgeStatus.lastSequenceOut = full.seq;
    refreshBridgeConnectivity();
    persistBridgeTelemetry('outbound', { messageType: full.type });
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
    paperPositions: paperDesk.snapshot().positions.map((position) => ({
      ticker: position.ticker,
      side: position.side,
      contracts: position.contracts,
      entryPrice: position.entryPrice,
    })),
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
    bridgeConnectionCount += 1;
    if (bridgeConnectionCount > 1) bridgeStatus.reconnects += 1;
    bridgeStatus.clientCount = bridgeClients.size;
    refreshBridgeConnectivity();
    persistBridgeTelemetry('client_connected');
    broadcastBridgeStatus();

    const hello: NemesisBridgeMessage = {
      type: 'bridge:hello',
      payload: { version: '0.1.0', role: 'nemesis', timestamp: Date.now() },
      seq: ++bridgeSeq,
    };
    ws.send(JSON.stringify(hello));
    bridgeStatus.lastOutboundAt = Date.now();
    bridgeStatus.lastSequenceOut = hello.seq;
    persistBridgeTelemetry('outbound', { messageType: hello.type });
    broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });

    ws.on('message', (raw: RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as NemesisBridgeMessage;
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
        const receivedAt = Date.now();
        bridgeStatus.lastSeenAt = receivedAt;
        bridgeStatus.lastInboundAt = receivedAt;
        bridgeStatus.lastSequenceIn = valid.seq;
        refreshBridgeConnectivity(receivedAt);
        persistBridgeTelemetry('inbound', { messageType: valid.type });
        if (valid.type === 'brain:recommendation') {
          const nextRole = (valid.payload as { brain_role: BridgeStatus['brainRole'] }).brain_role;
          if (bridgeStatus.brainRole && nextRole && bridgeStatus.brainRole !== nextRole) bridgeStatus.failovers += 1;
          bridgeStatus.brainRole = nextRole;
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
          bridgeStatus.lastOutboundAt = Date.now();
          bridgeStatus.lastPongAt = bridgeStatus.lastOutboundAt;
          bridgeStatus.lastSequenceOut = pong.seq;
          refreshBridgeConnectivity();
          persistBridgeTelemetry('outbound', { messageType: pong.type });
        }
      } catch {
        auditLog.append({ action: 'gate_block', detail: 'bridge packet rejected: malformed json', ok: false });
        saveAuditLog();
      }
    });

    ws.on('close', () => {
      bridgeClients.delete(ws);
      bridgeStatus.clientCount = bridgeClients.size;
      bridgeStatus.disconnects += 1;
      refreshBridgeConnectivity();
      persistBridgeTelemetry('client_disconnected');
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
  const qualification = qualificationSnapshot();
  const shutdown = getShutdownCounters();
  return evaluateLiveUnlock({
    now: Date.now(),
    targetStage,
    currentStage: settings.liveStage ?? 'paper',
    hasCredentials: Boolean(getLiveCreds()),
    gates,
    confirmationText,
    paper: {
      validationStage: strategyValidationSnapshot()?.stage ?? 'shadow',
      completedPositionCount: qualification?.completedPositionCount ?? 0,
      profitableWeekCount: qualification?.profitableWeekCount ?? 0,
      profitFactor: qualification?.profitFactor ?? 0,
      averageNetPnlUsd: qualification?.averageNetPnlUsd ?? 0,
      realizedPnlUsd: qualification?.realizedPnlUsd ?? 0,
      equityAboveStart: Boolean(qualification && qualification.endingEquity > qualification.startingCash),
      pnlPerRiskDollar: qualification?.pnlPerRiskDollar ?? 0,
      winRate: qualification?.winRate ?? 0,
      largestWinShare: qualification?.largestWinShare ?? 1,
      profitConfidenceRate: qualification?.profitConfidenceRate ?? 0,
      stressedNetPnlUsd: qualification?.stressedNetPnlUsd ?? 0,
      stressedProfitFactor: qualification?.stressedProfitFactor ?? 0,
      rollingLossPaused: qualification?.rollingLossPaused ?? true,
      configurationValid: qualification?.configurationValid ?? false,
      manualScoredCloseCount: qualification?.manualScoredCloseCount ?? 0,
      automaticScoredCloseCount: qualification?.automaticScoredCloseCount ?? 0,
      benchmarkPassed: qualification?.benchmarkPassed ?? false,
      falseExitRate: qualification?.automaticFalseExitRate ?? 1,
      avgCloseRegretUsd: qualification?.automaticAvgCloseRegretUsd ?? Number.POSITIVE_INFINITY,
      avgSlippagePp: qualification?.avgSlippagePp ?? Number.POSITIVE_INFINITY,
      maxDrawdownUsd: qualification?.maxDrawdownUsd ?? Number.POSITIVE_INFINITY,
      dailyLossCapUsd: Math.min(150, settings.dailyLossCapUsd),
      shutdownTriggered: shouldShutdownSession(shutdown),
      killSwitchActive: settings.killSwitchActive,
      apiHealthy: registry.isHealthy('kalshi-rest'),
      cleanAudit: qualification?.auditClean ?? false,
      blockingSafetyEventCount: qualification?.blockingSafetyEventCount ?? 1,
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
      paperQualification: qualificationSnapshot(),
      strategyValidation: strategyValidationSnapshot(),
      evidenceCampaign: campaignSnapshot(),
      orderbookStream: kalshiOrderbookStream.telemetry(),
      pilotValidation: pilotValidationSnapshot(),
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
    if (partial.kalshiAccountPrecision !== undefined) kalshiFeePolicyResolver.clear();
    qualificationSnapshot();
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
    if (result.ok) kalshiOrderbookStream.restart();
    return result;
  });

  ipcMain.handle('nemesis:clearKalshiCredentials', () => {
    if ((settings.liveStage ?? 'paper') !== 'paper') {
      invalidateLiveCertificate('credential change');
    }
    const status = clearStoredKalshiCredentials();
    broadcast('settings:update', settings);
    kalshiOrderbookStream.restart();
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
      paperQualification: qualificationSnapshot(),
      strategyValidation: strategyValidationSnapshot(),
      evidenceCampaign: campaignSnapshot(),
      orderbookStream: kalshiOrderbookStream.telemetry(),
      pilotValidation: pilotValidationSnapshot(),
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
      recordPaperBlock({
        thesisId,
        ticker: card?.ticker,
        detail: `manual paper buy rejected: ${eligibilityBlock}`,
        code: 'signal_eligibility_block',
        severity: 'info',
        blocksLiveUnlock: false,
      });
      return { ok: false, error: `thesis not eligible for paper trading: ${eligibilityBlock}` };
    }
    const certified = certifiedQueueItemForCard(card);
    if (!certified) {
      const reason = certificationBlockForCard(card);
      recordPaperBlock({
        thesisId,
        ticker: card.ticker,
        detail: `not strict-profit certified: ${reason}`,
        code: 'not_certified',
        severity: 'info',
        blocksLiveUnlock: false,
      });
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
    const qty = contracts ?? pos.contracts;
    const closeCard = card ?? fallbackCardForPosition(pos);
    let book: KalshiOrderbook;
    try {
      book = cachedBookForTicker(pos.ticker) ?? await fetchBookForCard(closeCard);
    } catch (error) {
      const reason = describeBookFetchError(error);
      if (!isBookFetchBackoffError(error)) {
        recordPaperBlock({
          ticker: pos.ticker,
          detail: `manual close blocked: book unavailable (${reason})`,
          code: 'book_unavailable',
          severity: 'warning',
          blocksLiveUnlock: false,
        });
      }
      return { ok: false, error: `book unavailable: ${reason}`, abortCode: 'book_unavailable', wouldMutate: false };
    }
    const closePreview = previewPaperClose(book, pos.side, qty, settings);
    if (!closePreview.ok || !closePreview.fill || closePreview.fill.aborted) {
      return { ok: false, error: closePreview.error ?? closePreview.fill?.abortReason ?? 'no executable close fill', abortCode: closePreview.abortCode, wouldMutate: false };
    }
    const result = simulatePaperClose(paperDesk, positionId, book, pos.side, closePreview.fill.fillPrice, qty, settings);
    if (result.ok) {
      recordBenchmarkSample('baseline', pos, qty, result.pnl ?? 0, result.fillQuality?.implementationShortfall ?? 0);
      recordQualificationClose('baseline', pos, qty, result);
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
      paperQualification: qualificationSnapshot(),
      strategyValidation: strategyValidationSnapshot(),
      pilotValidation: pilotValidationSnapshot(),
      ...autoCloseSnapshot(),
    };
  });

  ipcMain.handle('nemesis:advanceStrategyStage', (_e, stage: StrategyValidationStage, confirmation: string) => {
    try {
      if (!strategyValidationStore) throw new Error('strategy validation store is unavailable');
      const current = strategyValidationSnapshot();
      if (!current || current.integrityError || current.paused) throw new Error('strategy validation evidence is not eligible for advancement');
      if (paperDesk.snapshot().positions.length > 0) throw new Error('close all paper positions before advancing the stage');
      if (stage === 'pilot') {
        if (current.stage !== 'shadow') throw new Error('only a shadow run can advance to pilot');
        if (!current.shadowPassed) throw new Error('shadow thresholds have not passed');
      } else if (stage === 'qualification') {
        if (current.stage !== 'pilot') throw new Error('only a pilot run can advance to qualification');
        if (!pilotValidationSnapshot().passed) throw new Error('pilot thresholds have not passed');
      } else {
        throw new Error('shadow is created only by archive and reset');
      }
      strategyValidationStore.record((tracker) => tracker.changeStage(stage, confirmation));
      const strategyValidation = strategyValidationSnapshot();
      const pilotValidation = pilotValidationSnapshot();
      broadcastPaperUpdate(true);
      return { ok: true, strategyValidation, pilotValidation };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });

  ipcMain.handle('nemesis:resetPaper', (_e, confirmation: string) => {
    try {
      const result = archiveAndResetPaper({
        dataDir: DATA_DIR,
        confirmation,
        runningApplications: detectRunningNemesisApplications(process.pid),
        gitCommit: process.env.NEMESIS_GIT_COMMIT ?? 'unknown',
        appVersion: app.getVersion(),
        strategyConfigHash: strategyConfigHash(),
        strategyEngineVersion: PAPER_STRATEGY_ENGINE_VERSION,
      });
      paperDesk.load(result.portfolio);
      paperOrderBook.load([]);
      autoCloseStates.clear();
      autoCloseDecisions = [];
      latestExitSignals.clear();
      worstUnrealizedLossByPosition.clear();
      const now = Date.now();
      equityHistory = [{ t: now, equity: 5_000, deployed: 0, cash: 5_000 }];
      sessionStatsData = {
        dayStart: now,
        dailyPnl: 0,
        tradeCount: 0,
        abortCount: 0,
        startingEquity: 5_000,
        shutdown: { ...DEFAULT_SHUTDOWN_COUNTERS },
      };
      shutdownEvidenceRecorded = false;
      auditLog.load([]);
      qualificationStore = PaperQualificationStore.open(PAPER_QUALIFICATION_PATH, {
        startingCash: 5_000,
        strategyConfigHash: strategyConfigHash(),
      });
      strategyValidationStore = StrategyValidationStore.open(STRATEGY_VALIDATION_PATH, {
        stage: 'shadow',
        strategyConfigHash: strategyConfigHash(),
        strategyEngineVersion: PAPER_STRATEGY_ENGINE_VERSION,
      });
      entryConfirmationEngine = new EntryConfirmationEngine(entryQualificationSettings());
      lastTickerSideExecutionAt.clear();
      reviewOnly = false;
      lastQualificationEquity = 5_000;
      broadcastPaperUpdate(true);
      return {
        ok: true,
        archivePath: result.archivePath,
        newRunId: result.newRunId,
        portfolio: result.portfolio,
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
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
    qualificationSnapshot();
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

  ipcMain.handle('nemesis:getBridgeStatus', () => {
    refreshBridgeConnectivity();
    return { ...bridgeStatus };
  });

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
  initializePaperQualification();
  startupTrace('paper-qualification');
  initializeStrategyValidation();
  startupTrace('strategy-validation');
  initializeEvidenceCampaign();
  startupTrace('evidence-campaign');
  kalshiStream.onQuote((q) => applyKalshiQuote(q.ticker, q.yesPrice, q.spread));
  kalshiOrderbookStream.onBookUpdate((book) => {
    const observedAt = Date.now();
    if (
      !campaignStore
      || book.sourceTimestamp == null
      || observedAt - book.sourceTimestamp > entryQualificationSettings().maxBookAgeMs
    ) return;
    void runThroughputCertification('exchange-book-delta');
    void evaluateCampaignConfirmations();
  });
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
    void evaluateQualificationFollowUps();
    void evaluateStrategyValidationFollowUps();
    void runThroughputCertification('entry-confirmation-tick');
    void evaluateCampaignConfirmations();
    void evaluateCampaignDiagnostics();
    recordCampaignOperationalTelemetry();
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
  kalshiOrderbookStream.start();
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
  setInterval(() => sampleRendererMemory(), 30_000);
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
  kalshiStream.stop();
  kalshiOrderbookStream.stop();
  if (geaProcess && !geaProcess.killed) geaProcess.kill();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
