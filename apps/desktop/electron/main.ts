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
import { createHash } from 'node:crypto';
import { WebSocketServer, WebSocket as WsSocket, type RawData } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { validateBridgeMessage, type BridgeProcessTelemetry, type BridgeStatus, type ExitRecommendation, type NemesisBridgeMessage, type NemesisStateMirror, type RecommendationPacket } from '@nemesis/bridge-contracts';
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
  KalshiRequestFailure,
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
  kalshiProductionCircuitSnapshot,
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
  type KalshiFeePolicy,
  type KalshiResponseMetadata,
  type OpportunityRadarRow,
  type PriceTick,
  type PaperPortfolio,
  type PaperPosition,
  type SessionStats,
  type PaperOrder,
  type GeoMarket,
  type WorldEventsPayload,
} from '@nemesis/core';
import { ActiveTradeMarketResolver, ConnectorRegistry, FeedHub, KalshiStream, KalshiOrderbookStream, DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS, isCryptoMarket, isMacroMarket, isSportsMarket, isWeatherMarket, inferMarketGeo, type ProductionUniverseRecord } from '@nemesis/connectors';
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
  candidateEconomicIdentity,
  qualifyCampaignEnrollment,
  calculateEntryEconomics,
  type CampaignCandidateRecord,
  type CampaignScreenedOut,
  type CampaignScreeningReasonCode,
  type CampaignScreeningDecisionV2,
  type DryRunOrder,
  type DiagnosticAttemptOutcome,
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
import {
  CampaignBookTriggerScheduler,
  campaignBookUpdateWork,
  campaignEnrollmentReadiness,
  campaignPendingCapacity,
  isEvidenceOnlyCampaignExecution,
  shouldInvalidateSupervisedEvidence,
} from './campaignRuntime.js';
import { KalshiFeePolicyResolver } from './kalshiFeePolicyResolver.js';
import { buildStrategyConfigHash, PAPER_STRATEGY_ENGINE_VERSION } from './qualificationConfig.js';
import { upsertRecommendationMarket, upsertRecommendationThesis } from './bridgeRecommendations.js';
import { createGeaBridgeUrl, createGeaChildEnv, createGeaSpawnPlan } from './geaSpawn.js';
import { createSingleFlight, withAbortTimeout } from './singleFlight.js';
import { startupTrace } from './startupTrace.js';
import { createBridgeAuth, isBridgeRequestAuthenticated, resolveBridgeHost } from './bridgeSecurity.js';
import { resolveNemesisUserDataPath } from './userDataPath.js';
import { RendererMemoryMonitor } from './rendererMemoryMonitor.js';
import type { RendererMemoryAssessment } from './rendererMemoryMonitor.js';
import { RuntimeHealthController, type RuntimeComponentHealth, type RuntimeHealthDecision } from './runtimeHealthController.js';
import { RuntimeEvidenceSidecar } from './runtimeEvidenceSidecar.js';
import { EvidenceRunSupervisor } from './evidenceRunSupervisor.js';
import { VersionedStateStream } from './stateStreamCoalescer.js';
import { RuntimeStatusExporter, runtimeStatusPathFromEnvironment } from './runtimeStatusExport.js';
import { RendererHeartbeatMonitor } from './rendererHeartbeatMonitor.js';
import { selectBoundedOrderbookTracking } from './orderbookTrackingRotation.js';
import { assessProductionObservation, productionObservationStateHash } from './productionObservation.js';

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
const PRODUCTION_OBSERVATION_MODE = process.env.NEMESIS_PRODUCTION_OBSERVATION === 'true';

const MAX_TICKS = 120;
const LIQUIDITY_PREFILTER_MAX_AGE_MS = 45_000;
const MARKET_REFRESH_MS = 15_000;
const WATCHED_TICK_MS = 1_000;
const FEED_WAIT_MS = 2_000;
const BOOK_CACHE_TTL_MS = 600;
const MARKET_BROADCAST_THROTTLE_MS = 750;
const DEGRADED_MARKET_BROADCAST_THROTTLE_MS = 3_000;
const PAPER_BROADCAST_THROTTLE_MS = 1_000;
const PAPER_SUMMARY_BROADCAST_THROTTLE_MS = 5_000;
const CAMPAIGN_BOOK_TRIGGER_INTERVAL_MS = 500;
const EQUITY_SNAPSHOT_MIN_MS = 5_000;
// Sparse live-universe pages can require more than the old single-page
// timeout before 25 executable markets are found. The preflight still has its
// own 20-minute ceiling; this only prevents a valid paginated discovery from
// being aborted before the orderbook readiness minimum is reachable.
const UNIVERSE_FETCH_TIMEOUT_MS = 120_000;
const REST_HEALTH_POLL_MS = 20_000;
const UNIVERSE_REFRESH_MS = 5 * 60_000;
const BRIDGE_HEARTBEAT_MS = 5_000;
const BRIDGE_TRAFFIC_TTL_MS = 15_000;
const RUNTIME_SAMPLE_INTERVAL_MS = 5_000;
const RENDERER_MEMORY_SAMPLE_INTERVAL_MS = 30_000;
// Packaged Electron startup can be delayed by a cold profile or a busy
// desktop. Keep the renderer-load grace bounded, but long enough to cover the
// five-minute soak warm-up; the renderer must still finish loading and answer
// a fresh probe before feeds or evidence can start.
const RENDERER_LOAD_RETRY_GRACE_MS = 5 * 60_000;
// Discovery still evaluates 500 tickers. Live depth is a smaller, rotating
// working set so the authenticated socket carries only immediately useful
// markets; active campaign candidates preempt this set.
// Production qualification requires exactly 25 tracked markets. The target is
// overridable (1..25) only for reduced-bar validation rehearsals when the live
// universe is thin; offline evidence verifiers remain pinned at 25, so a
// reduced-bar run can never verify as a real qualification.
const ORDERBOOK_TRACKING_LIMIT = (() => {
  const raw = Number.parseInt(process.env.NEMESIS_ORDERBOOK_TRACKING_LIMIT ?? '', 10);
  return Number.isInteger(raw) && raw >= 1 && raw <= 25 ? raw : 25;
})();
const ORDERBOOK_ROTATION_INTERVAL_MS = 5 * 60_000;
const ORDERBOOK_ROTATION_BATCH_SIZE = 4;

app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');

startupTrace('module-loaded');

let mainWindow: BrowserWindow | null = null;
let rendererLoadReadyPromise: Promise<void> = Promise.resolve();
let resolveRendererLoadReady: (() => void) | null = null;
let rendererRetryInProgress = false;
let rendererProbePendingAfterPaint = false;
let rendererProbeGateInProgress = false;
const widgetWindows = new Set<BrowserWindow>();
const registry = new ConnectorRegistry();
const discovery = new DiscoveryOrchestrator(registry);
const feedHub = new FeedHub(registry);
const activeTradeMarketResolver = new ActiveTradeMarketResolver();
const kalshiStream = new KalshiStream(registry, () => {
  const credentials = getLiveCreds();
  return credentials
    ? authHeaders(credentials.apiKeyId, credentials.privateKeyPem, 'GET', '/trade-api/ws/v2')
    : null;
});
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
}, 'production', ORDERBOOK_TRACKING_LIMIT);
let theses: ThesisCard[] = [];
let geaTheses: ThesisCard[] = [];
let reviewOnly = false;
let marketsCache: KalshiMarket[] = [];
let marketFeedReady = false;
let geaMarkets: KalshiMarket[] = [];
const productionMarketRecords = new Map<string, ProductionUniverseRecord>();
const paperDesk = new PaperDesk(DEFAULT_PAPER_CASH);
const paperBuyExecutionCoordinator = new PaperExecutionCoordinator();
const paperOrderBook = new PaperOrderBook();
let productionObservationBaselineHash: string | null = null;
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
const pendingCampaignConfirmationTickers = new Set<string>();
const pendingCampaignThroughputTickers = new Set<string>();
const pendingCampaignDiagnosticTickers = new Set<string>();
interface CampaignBookObservation {
  ticker: string;
  sequence: number;
  observedAt: number;
  completedAt: number;
  book: KalshiOrderbook;
  feeResult:
    | { status: 'resolved'; policy: KalshiFeePolicy }
    | {
        status: 'failed';
        outcome: 'book_fetch_failed' | 'missing_provenance' | 'stale_book' | 'fee_unknown';
        detail: string;
      };
}
const latestCampaignObservationSequence = new Map<string, number>();
const pendingCampaignDiagnosticObservations = new Map<string, CampaignBookObservation>();
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
let latestRendererMemoryAssessment: RendererMemoryAssessment = rendererMemoryMonitor.snapshot();
let runtimeHealthController = new RuntimeHealthController();
let latestRuntimeDecision: RuntimeHealthDecision | null = null;
const rendererHeartbeatMonitor = new RendererHeartbeatMonitor();
let rendererProbeTimer: ReturnType<typeof setInterval> | null = null;
let rendererProbeSequence = 0;
let campaignEvidencePaused = true;
let pendingCampaignPointer: ActiveCampaignPointer | null = null;
let evidenceRunSupervisor: EvidenceRunSupervisor | null = null;
let runtimeEvidenceSidecar: RuntimeEvidenceSidecar | null = null;
let runtimeStatusState = 'idle';
let lastRuntimeStatusWriteAt = 0;
let lastRuntimeTransitionAction: RuntimeHealthDecision['action'] | null = null;
let runtimeObservedSamples = 0;
let runtimeHealthySamples = 0;
let preflightRestSuccessAt = 0;
let preflightTradeSuccessAt = 0;
let preflightRestCycles = 0;
let preflightTradeCycles = 0;
let lastRendererMemorySampleAt = 0;
let lastRuntimeSampleAt = 0;
let closeoutPrepared = false;
let campaignFinalizationState: 'idle' | 'waiting-gea' | 'running' | 'done' = 'idle';
let campaignFinalizationTimer: ReturnType<typeof setTimeout> | null = null;
let evidenceInvalidationInProgress = false;
// Export the expiring lease more often than the soak sampler so a boundary
// sample cannot reuse a stale feed/bridge state.
const unsupervisedRuntimeStatusExporter = new RuntimeStatusExporter(runtimeStatusPathFromEnvironment(), 5_000);
let lastDiscoveryRevision = '';
let lastWorldRevision = '';
let orderbookTrackedTickers: string[] = [];
let orderbookLastRotationAt = 0;
let orderbookRotationCursor = 0;
const campaignBookTriggerScheduler = new CampaignBookTriggerScheduler(
  CAMPAIGN_BOOK_TRIGGER_INTERVAL_MS,
  ({ throughputTickers, confirmationTickers, diagnosticTickers }) => {
    if (throughputTickers.length > 0) {
      void runThroughputCertification('exchange-book-delta', new Set(throughputTickers));
    }
    if (confirmationTickers.length > 0) {
      void evaluateCampaignConfirmations(new Set(confirmationTickers));
    }
    if (diagnosticTickers.length > 0) {
      void evaluateCampaignDiagnostics(new Set(diagnosticTickers), true);
    }
  },
);

type MarketStateStreamItem =
  | { key: string; kind: 'market'; value: KalshiMarket }
  | { key: string; kind: 'thesis'; value: ThesisCard };
type EquityHistoryPoint = { t: number; equity: number; deployed: number; cash: number };
const marketStreamItemCache = new Map<string, { fingerprint: string; item: MarketStateStreamItem }>();
const marketStateStream = new VersionedStateStream<MarketStateStreamItem>(
  'markets',
  (item) => item.key,
  (envelope) => broadcast('markets:state-v2', envelope),
  1_000,
);
const equityHistoryStream = new VersionedStateStream<EquityHistoryPoint>(
  'equity-history',
  (point) => String(point.t),
  (envelope) => broadcast('equity-history:state-v2', envelope),
);

function marketStreamItem(key: string, kind: MarketStateStreamItem['kind'], value: KalshiMarket | ThesisCard): MarketStateStreamItem {
  const fingerprint = JSON.stringify(value);
  const cached = marketStreamItemCache.get(key);
  if (cached?.fingerprint === fingerprint) return cached.item;
  const item = { key, kind, value } as MarketStateStreamItem;
  marketStreamItemCache.set(key, { fingerprint, item });
  return item;
}

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
let geaExitedDuringEvidence = false;
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
  const tradeFeed = feedHub.getTradeFeedState();
  bridgeStatus.tradeTapeFreshnessMs = tradeFeed.tapeAgeMs;
  bridgeStatus.orderbookObservationFreshnessMs = stream.lastMessageAt == null
    ? null
    : Math.max(0, now - stream.lastMessageAt);
  bridgeStatus.exchangeDeltaFreshnessMs = stream.lastExchangeTimestamp == null
    ? null
    : Math.max(0, now - stream.lastExchangeTimestamp);
  bridgeStatus.tapeFreshnessMs = bridgeStatus.tradeTapeFreshnessMs;
  const inboundRecent = bridgeStatus.lastInboundAt != null && now - bridgeStatus.lastInboundAt <= BRIDGE_TRAFFIC_TTL_MS;
  const outboundRecent = bridgeStatus.lastOutboundAt != null && now - bridgeStatus.lastOutboundAt <= BRIDGE_TRAFFIC_TTL_MS;
  bridgeStatus.socketConnected = bridgeStatus.clientCount > 0;
  bridgeStatus.connected = bridgeStatus.socketConnected && inboundRecent && outboundRecent;
  bridgeStatus.qualificationReady = bridgeStatus.connected && bridgeStatus.lastPongAt != null
    && now - bridgeStatus.lastPongAt <= BRIDGE_TRAFFIC_TTL_MS;
  bridgeStatus.trafficFreshnessMs = bridgeStatus.lastInboundAt == null || bridgeStatus.lastOutboundAt == null
    ? null
    : Math.max(now - bridgeStatus.lastInboundAt, now - bridgeStatus.lastOutboundAt);
}

function currentProcessTelemetry(now = Date.now()): Record<string, unknown> {
  const mainWorkingSetMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(3));
  bridgeStatus.mainPid = process.pid;
  bridgeStatus.mainWorkingSetMb = mainWorkingSetMb;
  bridgeStatus.mainProcessSampledAt = now;
  const geaSampledAt = bridgeStatus.geaProcessSampledAt ?? null;
  return {
    main: {
      pid: process.pid,
      workingSetMb: mainWorkingSetMb,
      sampledAt: now,
    },
    gea: bridgeStatus.geaPid != null && bridgeStatus.geaWorkingSetMb != null && geaSampledAt != null
      ? {
          pid: bridgeStatus.geaPid,
          workingSetMb: bridgeStatus.geaWorkingSetMb,
          sampledAt: geaSampledAt,
          sampleAgeMs: Math.max(0, now - geaSampledAt),
        }
      : null,
  };
}

function currentRendererRuntimeAssessment(now = Date.now()): RendererMemoryAssessment & Record<string, unknown> {
  const heartbeat = rendererHeartbeatMonitor.snapshot(now);
  const reasons = [...new Set([
    ...latestRendererMemoryAssessment.reasons,
    ...heartbeat.reasons,
  ])];
  const blocked = latestRendererMemoryAssessment.blocked || heartbeat.blocked;
  return {
    ...latestRendererMemoryAssessment,
    status: blocked ? 'unstable-growth' : latestRendererMemoryAssessment.status,
    blocked,
    reasons,
    detail: heartbeat.blocked
      ? reasons.join('; ')
      : latestRendererMemoryAssessment.detail,
    heartbeatAgeMs: heartbeat.heartbeatAgeMs,
    unresponsiveForMs: heartbeat.unresponsiveForMs,
    heartbeatReceived: heartbeat.lastHeartbeatAt != null,
    heartbeatPainted: heartbeat.painted,
    heartbeatLoadingGraceUntil: heartbeat.loadingGraceUntil,
    heartbeatLastReceivedAt: heartbeat.lastHeartbeatAt,
    heartbeatLastRendererReportedAt: heartbeat.lastRendererReportedAt,
    rendererLoadStartedAt: heartbeat.loadStartedAt,
    rendererLoadFinishedAt: heartbeat.loadFinishedAt,
    rendererMonitoringStartedAt: heartbeat.monitoringStartedAt,
    rendererFirstHeartbeatAt: heartbeat.firstHeartbeatAt,
    rendererFirstPaintedAt: heartbeat.firstPaintedAt,
    rendererLastHeartbeatSequence: heartbeat.lastHeartbeatSequence,
    rendererHeartbeatSendFailures: heartbeat.heartbeatSendFailures,
    rendererProbeSentAt: heartbeat.lastProbeSentAt,
    rendererProbeResponseAt: heartbeat.lastProbeResponseAt,
    rendererProbeSequence: heartbeat.lastProbeSequence,
    rendererProbeAgeMs: heartbeat.probeAgeMs,
    rendererProbeResponseReceived: heartbeat.probeResponseReceived,
  };
}

function stopRendererProbe(): void {
  if (rendererProbeTimer) clearInterval(rendererProbeTimer);
  rendererProbeTimer = null;
}

function sendRendererProbe(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const sentAt = Date.now();
  const sequence = ++rendererProbeSequence;
  rendererHeartbeatMonitor.recordProbeSent(sentAt, sequence);
  try {
    mainWindow.webContents.send('renderer:probe', { sentAt, sequence });
    startupTrace(`renderer-probe-sent:${sequence}`);
  } catch (error) {
    rendererHeartbeatMonitor.recordHeartbeatSendFailure();
    startupTrace(`renderer-probe-send-failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

function startRendererProbe(): void {
  stopRendererProbe();
  rendererProbePendingAfterPaint = false;
  rendererProbeSequence = 0;
  sendRendererProbe();
  rendererProbeTimer = setInterval(sendRendererProbe, 5_000);
}

async function waitForFreshRendererProbe(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const heartbeat = rendererHeartbeatMonitor.snapshot();
    if (heartbeat.probeResponseReceived && heartbeat.probeAgeMs <= 15_000 && !heartbeat.blocked) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return false;
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
  if (PRODUCTION_OBSERVATION_MODE) return;
  recordInvalidation(ensureShutdownCounters());
  saveSessionStats();
}

function recordDryRunAbnormalExecution() {
  if (PRODUCTION_OBSERVATION_MODE) return;
  recordAbnormalExecution(ensureShutdownCounters());
  saveSessionStats();
}

function resetDryRunInvalidationStreak() {
  if (PRODUCTION_OBSERVATION_MODE) return;
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
  schemaVersion: 2;
  evidenceNamespace: string;
  stage: 'instrumentation' | 'seven-hour';
  filePath: string;
  parentRunId: string | null;
  restartOrdinal: number;
  healthPolicyHash: string;
  productionArtifactHash: string;
  soakVerificationReceiptHash: string;
  runtimeSidecarPath: string;
  runtimeLedgerPath: string;
  controlPath: string;
  status: 'preflight' | 'active' | 'closeout';
}

function readActiveCampaignPointer(): ActiveCampaignPointer | null {
  if (!fs.existsSync(ACTIVE_CAMPAIGN_PATH)) return null;
  try {
    const pointer = JSON.parse(fs.readFileSync(ACTIVE_CAMPAIGN_PATH, 'utf8')) as ActiveCampaignPointer;
    return campaignPointerValidationError(pointer) == null ? pointer : null;
  } catch {
    return null;
  }
}

function writeActiveCampaignPointer(pointer: ActiveCampaignPointer): void {
  const validationError = campaignPointerValidationError(pointer);
  if (validationError) throw new Error(`refusing invalid active campaign pointer: ${validationError}`);
  fs.mkdirSync(CAMPAIGN_DIR, { recursive: true });
  writeAtomicJson(ACTIVE_CAMPAIGN_PATH, pointer);
}

function writeAtomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

function configuredCampaignPointer(stage: ActiveCampaignPointer['stage'], evidenceNamespace: string): ActiveCampaignPointer {
  const namespace = campaignNamespace(evidenceNamespace);
  const healthPolicyHash = process.env.NEMESIS_HEALTH_POLICY_HASH?.trim();
  const productionArtifactHash = process.env.NEMESIS_PRODUCTION_ARTIFACT_HASH?.trim();
  const soakVerificationReceiptHash = process.env.NEMESIS_SOAK_VERIFICATION_RECEIPT_HASH?.trim();
  const runtimeSidecarPath = process.env.NEMESIS_EVIDENCE_RUNTIME_SIDECAR?.trim();
  const runtimeLedgerPath = process.env.NEMESIS_EVIDENCE_RUNTIME_LEDGER?.trim();
  const controlPath = process.env.NEMESIS_EVIDENCE_CONTROL?.trim();
  if (process.env.NEMESIS_EVIDENCE_PREFLIGHT !== 'true') {
    throw new Error('supervised evidence must begin in preflight mode');
  }
  if (!healthPolicyHash || !productionArtifactHash || !soakVerificationReceiptHash || !runtimeSidecarPath || !runtimeLedgerPath || !controlPath) {
    throw new Error('supervised evidence requires explicit upstream hashes, health-policy, runtime, and control paths');
  }
  const pointer: ActiveCampaignPointer = {
    schemaVersion: 2,
    evidenceNamespace: namespace,
    stage,
    filePath: path.join(CAMPAIGN_DIR, `${namespace}.jsonl`),
    parentRunId: process.env.NEMESIS_EVIDENCE_PARENT_RUN_ID?.trim() || null,
    restartOrdinal: Number.parseInt(process.env.NEMESIS_EVIDENCE_RESTART_ORDINAL ?? '0', 10) || 0,
    healthPolicyHash,
    productionArtifactHash,
    soakVerificationReceiptHash,
    runtimeSidecarPath,
    runtimeLedgerPath,
    controlPath,
    status: 'preflight',
  };
  const validationError = campaignPointerValidationError(pointer);
  if (validationError) throw new Error(validationError);
  return pointer;
}

function campaignPointerValidationError(pointer: ActiveCampaignPointer): string | null {
  if (pointer.schemaVersion !== 2) return 'schema version must be 2';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pointer.evidenceNamespace)) return 'evidence namespace is invalid';
  if (!['instrumentation', 'seven-hour'].includes(pointer.stage)) return 'campaign stage is invalid';
  if (!['preflight', 'active', 'closeout'].includes(pointer.status)) return 'campaign status is invalid';
  if (!Number.isInteger(pointer.restartOrdinal) || pointer.restartOrdinal < 0 || pointer.restartOrdinal > 2) {
    return 'restart ordinal must be 0, 1, or 2';
  }
  if (!/^[a-f0-9]{64}$/i.test(pointer.healthPolicyHash)) return 'health policy hash is invalid';
  if (!/^[a-f0-9]{64}$/i.test(pointer.productionArtifactHash)) return 'production artifact hash is invalid';
  if (!/^[a-f0-9]{64}$/i.test(pointer.soakVerificationReceiptHash)) return 'soak verification receipt hash is invalid';
  if (pointer.parentRunId != null && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pointer.parentRunId)) {
    return 'parent run id is invalid';
  }
  const expectedPaths: ReadonlyArray<[string, string]> = [
    [pointer.filePath, path.join(CAMPAIGN_DIR, `${pointer.evidenceNamespace}.jsonl`)],
    [pointer.runtimeSidecarPath, path.join(CAMPAIGN_DIR, `${pointer.evidenceNamespace}.runtime.json`)],
    [pointer.runtimeLedgerPath, path.join(CAMPAIGN_DIR, `${pointer.evidenceNamespace}.runtime.jsonl`)],
    [pointer.controlPath, path.join(CAMPAIGN_DIR, `${pointer.evidenceNamespace}.control.json`)],
  ];
  return expectedPaths.some(([actual, expected]) => !actual || path.resolve(actual) !== path.resolve(expected))
    ? 'campaign artifact paths must match the isolated namespace'
    : null;
}

function currentOrderbookTrackingState(now = Date.now()) {
  // The stream owns the definitive OrderbookTrackingStateV2 projection so
  // runners and verifiers read one authoritative object.
  return kalshiOrderbookStream.trackingStateV2(now);
}

function currentFeedHealthSnapshot(now = Date.now()) {
  const base = feedHub.getFeedHealthSnapshot(now);
  const ticker = kalshiStream.telemetry(now);
  const orderbook = kalshiOrderbookStream.telemetry(now);
  const tickerWebSocket = { ...(base.tickerWebSocket ?? {}), ...ticker };
  const orderbookWebSocket = { ...(base.orderbookWebSocket ?? {}), ...orderbook };
  return {
    ...base,
    tickerWebSocket,
    orderbookWebSocket,
    transportCircuit: kalshiProductionCircuitSnapshot('production', now),
    qualificationReady: base.restMarkets?.qualificationReady === true
      && base.tradeTape?.qualificationReady === true
      && ticker.qualificationReady
      && orderbook.qualificationReady,
  };
}

function runtimeStatusPayload(
  state: string,
  detail: Record<string, unknown> = {},
  now = Date.now(),
): Record<string, unknown> {
  const pointer = pendingCampaignPointer ?? readActiveCampaignPointer();
  const processes = currentProcessTelemetry(now);
  return {
    schemaVersion: 2,
    runId: pointer?.evidenceNamespace ?? null,
    state,
    restartable: state === 'invalidated' && (pointer?.restartOrdinal ?? 2) < 2,
    updatedAt: now,
    campaign: campaignStore?.snapshot() ?? null,
    runtime: latestRuntimeDecision,
    renderer: currentRendererRuntimeAssessment(now),
    bridge: { ...bridgeStatus },
    processes,
    feeds: currentFeedHealthSnapshot(now),
    orderbookTracking: currentOrderbookTrackingState(now),
    productionObservation: currentProductionObservationState(),
    evidenceIdentity: pointer ? {
      gitCommit: process.env.NEMESIS_GIT_COMMIT?.trim() ?? null,
      healthPolicyHash: pointer.healthPolicyHash,
      productionArtifactHash: pointer.productionArtifactHash,
      soakVerificationReceiptHash: pointer.soakVerificationReceiptHash,
    } : null,
    ...detail,
  };
}

function writeRuntimeStatus(state: string, detail: Record<string, unknown> = {}, force = false): void {
  const pointer = pendingCampaignPointer ?? readActiveCampaignPointer();
  if (!pointer?.runtimeSidecarPath) return;
  const now = Date.now();
  if (!force && state === runtimeStatusState && now - lastRuntimeStatusWriteAt < RUNTIME_SAMPLE_INTERVAL_MS) return;
  writeAtomicJson(pointer.runtimeSidecarPath, runtimeStatusPayload(state, detail));
  runtimeStatusState = state;
  lastRuntimeStatusWriteAt = now;
}

function campaignNamespace(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('campaign evidence namespace is empty after normalization');
  return normalized;
}

function startEvidenceCampaign(pointer: ActiveCampaignPointer, startedAt: number): boolean {
  const config = entryQualificationSettings();
  campaignEntryConfirmationEngine = new EntryConfirmationEngine(config);
  const isNewLedger = !fs.existsSync(pointer.filePath);
  const frozenCommit = process.env.NEMESIS_GIT_COMMIT;
  if (
    pointer.status !== 'preflight'
    || pendingCampaignPointer !== pointer
    || !evidenceRunSupervisor
    || evidenceRunSupervisor.snapshot().status !== 'active'
    || !runtimeEvidenceSidecar
  ) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: successful supervised preflight authorization is required');
    return false;
  }
  if (!isNewLedger) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign restart refused: attempts require an isolated namespace and fresh clock');
    return false;
  }
  if (!frozenCommit) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: NEMESIS_GIT_COMMIT is required');
    return false;
  }
  if (!PRODUCTION_OBSERVATION_MODE || !currentProductionObservationState().qualificationReady) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: locked production observation state is required');
    return false;
  }
  if ((settings.kalshiAccountPrecision ?? 'unknown') === 'unknown') {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: account balance precision must be explicit');
    return false;
  }
  if (paperDesk.snapshot().positions.length > 0) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: close all paper positions first');
    return false;
  }
  campaignStore = SevenHourCampaignStore.open(pointer.filePath, {
    runId: pointer.evidenceNamespace,
    evidenceNamespace: pointer.evidenceNamespace,
    configurationHash: strategyConfigHash(),
    gitCommit: frozenCommit,
    stage: pointer.stage,
    startedAt,
    settings: config,
    parentRunId: pointer.parentRunId ?? undefined,
    restartOrdinal: pointer.restartOrdinal,
    healthPolicyHash: pointer.healthPolicyHash,
    productionArtifactHash: pointer.productionArtifactHash,
    soakVerificationReceiptHash: pointer.soakVerificationReceiptHash,
    runtimeSidecarPath: pointer.runtimeLedgerPath,
  }, config);
  pointer.status = 'active';
  pendingCampaignPointer = pointer;
  writeActiveCampaignPointer(pointer);
  const snapshot = campaignStore.snapshot();
  if (snapshot.integrityError || snapshot.manifest.schemaVersion !== 2) {
    reviewOnly = true;
    campaignStore = null;
    return false;
  }
  campaignEvidencePaused = latestRuntimeDecision?.state !== 'healthy';
  return true;
}

function initializeEvidenceCampaign(): void {
  const requestedStage = process.env.NEMESIS_EVIDENCE_CAMPAIGN_STAGE;
  const stage = requestedStage === 'instrumentation' || requestedStage === 'seven-hour'
    ? requestedStage
    : undefined;
  const requestedNamespace = process.env.NEMESIS_EVIDENCE_NAMESPACE;
  if (!requestedStage && !requestedNamespace) return;
  if (!stage || !requestedNamespace || process.env.NEMESIS_EVIDENCE_PREFLIGHT !== 'true') {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: explicit stage, namespace, and preflight mode are required');
    return;
  }
  if (fs.existsSync(ACTIVE_CAMPAIGN_PATH)) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: an active pointer already exists and attempts cannot resume');
    return;
  }
  let pointer: ActiveCampaignPointer;
  try {
    pointer = configuredCampaignPointer(stage, requestedNamespace);
  } catch (error) {
    reviewOnly = true;
    console.error(`[nemesis] evidence campaign not started: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const frozenCommit = process.env.NEMESIS_GIT_COMMIT;
  if (!frozenCommit) {
    reviewOnly = true;
    console.error('[nemesis] evidence campaign not started: NEMESIS_GIT_COMMIT is required');
    return;
  }
  pendingCampaignPointer = pointer;
  writeActiveCampaignPointer(pointer);
  if (fs.existsSync(pointer.filePath) || fs.existsSync(pointer.runtimeLedgerPath) || fs.existsSync(pointer.runtimeSidecarPath)) {
    reviewOnly = true;
    invalidateEvidenceAttempt(['preflight namespace is not clean'], Date.now(), false);
    return;
  }
  try {
    runtimeEvidenceSidecar = RuntimeEvidenceSidecar.create(pointer.runtimeLedgerPath, {
      runId: pointer.evidenceNamespace,
      gitCommit: frozenCommit,
      configurationHash: strategyConfigHash(),
      healthPolicyHash: pointer.healthPolicyHash,
      productionArtifactHash: pointer.productionArtifactHash,
      soakVerificationReceiptHash: pointer.soakVerificationReceiptHash,
    });
    evidenceRunSupervisor = new EvidenceRunSupervisor({
      at: Date.now(),
      runId: pointer.evidenceNamespace,
      parentRunId: pointer.parentRunId,
      restartOrdinal: pointer.restartOrdinal,
      evidenceNamespace: pointer.evidenceNamespace,
      gitCommit: frozenCommit,
      configurationHash: strategyConfigHash(),
      healthPolicyHash: pointer.healthPolicyHash,
      stage: pointer.stage,
      runtimeSidecarPath: pointer.runtimeLedgerPath,
    });
    campaignEvidencePaused = true;
    writeRuntimeStatus('preflight', {}, true);
  } catch (error) {
    reviewOnly = true;
    invalidateEvidenceAttempt([
      `runtime evidence startup failed: ${error instanceof Error ? error.message : String(error)}`,
    ], Date.now(), false);
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

function campaignMutationLockReason(): string | null {
  if (PRODUCTION_OBSERVATION_MODE && !pendingCampaignPointer) {
    return 'paper/live mutation locked during production observation';
  }
  if (!pendingCampaignPointer) return null;
  return `paper/live mutation locked during supervised evidence state ${pendingCampaignPointer.status}`;
}

function protectedArtifactDigest(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return 'missing';
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

function productionObservationInput() {
  const portfolio = paperDesk.snapshot();
  return {
    enabled: PRODUCTION_OBSERVATION_MODE,
    liveEnabled: settings.liveEnabled === true,
    autoLiveEnabled: settings.autoLiveEnabled === true,
    dryRun: settings.dryRun === true,
    demoMode: settings.demoMode === true,
    paperPositions: portfolio.positions,
    paperTrades: portfolio.trades,
    workingOrders: paperOrderBook.working(),
    paperPortfolio: portfolio,
    paperOrderState: paperOrderBook.snapshot(),
    protectedArtifacts: {
      settings: protectedArtifactDigest(SETTINGS_PATH),
      discoverySettings: protectedArtifactDigest(DISCOVERY_SETTINGS_PATH),
      credentials: protectedArtifactDigest(KALSHI_CREDENTIALS_PATH),
      paperPortfolio: protectedArtifactDigest(PAPER_PATH),
      paperOrders: protectedArtifactDigest(PAPER_ORDERS_PATH),
      equityHistory: protectedArtifactDigest(EQUITY_HISTORY_PATH),
      sessionStats: protectedArtifactDigest(SESSION_STATS_PATH),
      autoCloseState: protectedArtifactDigest(AUTO_CLOSE_PATH),
      paperQualification: protectedArtifactDigest(PAPER_QUALIFICATION_PATH),
      strategyValidation: protectedArtifactDigest(STRATEGY_VALIDATION_PATH),
    },
    configurationHash: strategyConfigHash(),
    protectedRuntimeState: {
      settings,
      discoverySettings: discovery.settings,
      sessionStats: sessionStatsData,
      equityHistory,
      autoCloseStates: [...autoCloseStates.entries()],
      autoCloseDecisions,
    },
  };
}

function captureProductionObservationBaseline(): void {
  productionObservationBaselineHash = productionObservationStateHash(productionObservationInput());
}

function currentProductionObservationState() {
  return assessProductionObservation(productionObservationInput(), productionObservationBaselineHash);
}

function sampleRendererMemory(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const devToolsClosed = !mainWindow.webContents.isDevToolsOpened();
  if (!devToolsClosed) {
    latestRendererMemoryAssessment = {
      ...rendererMemoryMonitor.snapshot(),
      status: 'unstable-growth',
      blocked: true,
      reasons: ['DevTools must remain closed during production memory evidence'],
      detail: 'DevTools must remain closed during production memory evidence',
    };
    return;
  }
  const rendererPid = mainWindow.webContents.getOSProcessId();
  const metric = app.getAppMetrics().find((item) => item.pid === rendererPid);
  const workingSetKb = metric?.memory.workingSetSize;
  if (!workingSetKb) return;
  const now = Date.now();
  const heartbeat = rendererHeartbeatMonitor.snapshot(now);
  lastRendererMemorySampleAt = now;
  latestRendererMemoryAssessment = rendererMemoryMonitor.add({
    at: now,
    workingSetKb,
    rendererPid,
    // Do not feed a pre-load age into the memory gate. Electron can take time
    // to finish loading the packaged page while the renderer process already
    // exists; liveness starts only after did-finish-load and the heartbeat
    // monitor still requires a real heartbeat after that point.
    heartbeatAgeMs: heartbeat.loadFinishedAt == null
      ? 0
      : heartbeat.lastHeartbeatAt == null && now <= heartbeat.loadingGraceUntil
        ? 0
        : heartbeat.heartbeatAgeMs,
    unresponsiveForMs: heartbeat.unresponsiveForMs,
    painted: heartbeat.painted,
  });
  const stable = latestRendererMemoryAssessment.status === 'stable' && !latestRendererMemoryAssessment.blocked;
  marketBroadcastThrottleMs = stable
    ? MARKET_BROADCAST_THROTTLE_MS
    : DEGRADED_MARKET_BROADCAST_THROTTLE_MS;
}

function runtimeComponents(now: number): RuntimeComponentHealth[] {
  refreshBridgeConnectivity(now);
  const feeds = currentFeedHealthSnapshot(now);
  const ticker = kalshiStream.telemetry(now);
  const orderbook = kalshiOrderbookStream.telemetry(now);
  const component = (
    name: RuntimeComponentHealth['name'],
    health: ReturnType<typeof registry.get>,
  ): RuntimeComponentHealth => ({
    name,
    connected: health?.transportConnected === true || health?.status === 'ok',
    qualificationReady: health?.qualificationReady === true,
    lastSuccessAt: health?.lastMessageAt ?? health?.lastSuccess ?? null,
    lastPongAt: health?.lastPongAt ?? null,
    retryAt: health?.nextRetryAt ?? null,
    failureClass: health?.failureClass ?? null,
    failures: health?.errorCount1h ?? 0,
    maxAgeMs: name === 'rest-markets' || name === 'trade-tape' ? 30_000 : undefined,
  });
  return [
    component('rest-markets', feeds.restMarkets ?? undefined),
    component('trade-tape', feeds.tradeTape ?? undefined),
    {
      name: 'ticker-websocket',
      connected: ticker.connected,
      qualificationReady: ticker.qualificationReady,
      lastSuccessAt: ticker.lastMessageAt,
      lastPongAt: ticker.lastPongAt,
      retryAt: ticker.nextRetryAt,
      failureClass: ticker.failureClass,
      failures: ticker.sequenceGaps,
      maxAgeMs: 25_000,
    },
    {
      name: 'orderbook-websocket',
      connected: orderbook.connected,
      trackingReady: orderbook.trackingReady,
      qualificationReady: orderbook.qualificationReady
        && orderbook.trackingReady
        && orderbook.booksWithExchangeTime > 0,
      lastSuccessAt: orderbook.lastMessageAt,
      lastPongAt: orderbook.lastPongAt,
      retryAt: orderbook.nextRetryAt,
      failureClass: orderbook.failureClass,
      failures: orderbook.sequenceGaps + orderbook.sequenceRegressions,
      maxAgeMs: 25_000,
    },
    {
      name: 'bridge',
      connected: bridgeStatus.connected,
      qualificationReady: bridgeStatus.qualificationReady === true,
      lastSuccessAt: bridgeStatus.lastPongAt ?? bridgeStatus.lastInboundAt,
      lastPingAt: bridgeStatus.lastPingAt ?? null,
      lastPongAt: bridgeStatus.lastPongAt,
      failures: bridgeStatus.sequenceGaps ?? 0,
      maxAgeMs: BRIDGE_TRAFFIC_TTL_MS,
    },
    {
      name: 'gea',
      connected: Boolean(geaProcess && !geaProcess.killed),
      qualificationReady: Boolean(geaProcess && !geaProcess.killed && bridgeStatus.connected),
      lastSuccessAt: bridgeStatus.lastInboundAt,
      failures: bridgeStatus.disconnects,
      maxAgeMs: BRIDGE_TRAFFIC_TTL_MS,
    },
  ];
}

function updatePreflightCycleCounts(): void {
  const feeds = currentFeedHealthSnapshot();
  const restAt = feeds.restMarkets?.lastSuccess ?? 0;
  const tradeAt = feeds.tradeTape?.lastSuccess ?? 0;
  if (restAt > preflightRestSuccessAt) {
    preflightRestSuccessAt = restAt;
    preflightRestCycles += 1;
  }
  if (tradeAt > preflightTradeSuccessAt) {
    preflightTradeSuccessAt = tradeAt;
    preflightTradeCycles += 1;
  }
}

function preflightHealthyForStability(): boolean {
  const ticker = kalshiStream.telemetry();
  const orderbook = kalshiOrderbookStream.telemetry();
  const heartbeat = rendererHeartbeatMonitor.snapshot();
  return currentProductionObservationState().qualificationReady
    && settings.liveEnabled !== true
    && settings.autoLiveEnabled !== true
    && settings.dryRun === true
    && paperDesk.snapshot().positions.length === 0
    && paperDesk.snapshot().trades.length === 0
    && paperOrderBook.working().length === 0
    && !latestRendererMemoryAssessment.blocked
    && !heartbeat.blocked
    && heartbeat.loadFinishedAt != null
    && heartbeat.lastHeartbeatAt != null
    && heartbeat.painted
    && heartbeat.heartbeatAgeMs <= 15_000
    && heartbeat.probeResponseReceived
    && heartbeat.probeAgeMs <= 15_000
    && preflightRestCycles >= 3
    && preflightTradeCycles >= 3
    && ticker.authenticated
    && ticker.qualificationReady
    && orderbook.authenticated
    && orderbook.qualificationReady
    && orderbook.trackedTickers === ORDERBOOK_TRACKING_LIMIT
    && orderbook.trackingReady
    && orderbook.booksWithExchangeTime > 0
    && (bridgeStatus.pongCount ?? 0) >= 3
    && bridgeStatus.qualificationReady === true
    && Boolean(geaProcess && !geaProcess.killed)
    && latestRuntimeDecision?.state === 'healthy'
    && Boolean(pendingCampaignPointer && !fs.existsSync(pendingCampaignPointer.filePath));
}

function preflightReadinessDetail(): Record<string, unknown> {
  const orderbook = kalshiOrderbookStream.telemetry();
  return {
    preflightFailureReason: orderbook.trackedTickers < ORDERBOOK_TRACKING_LIMIT
      ? 'orderbook_tracking_set_below_25'
      : null,
    orderbookTracking: currentOrderbookTrackingState(),
    productionObservation: currentProductionObservationState(),
  };
}

function readEvidenceControl(): { command?: string; runId?: string } | null {
  const pointer = pendingCampaignPointer;
  if (!pointer || !fs.existsSync(pointer.controlPath)) return null;
  try {
    const control = JSON.parse(fs.readFileSync(pointer.controlPath, 'utf8')) as { command?: string; runId?: string };
    fs.rmSync(pointer.controlPath, { force: true });
    return control.runId === pointer.evidenceNamespace ? control : null;
  } catch {
    return null;
  }
}

function stopCampaignInputs(): void {
  campaignEvidencePaused = true;
  pendingCampaignConfirmationTickers.clear();
  pendingCampaignThroughputTickers.clear();
  pendingCampaignDiagnosticTickers.clear();
  pendingCampaignDiagnosticObservations.clear();
  latestCampaignObservationSequence.clear();
  campaignBookTriggerScheduler.stop();
  marketStateStream.stop();
  equityHistoryStream.stop();
  kalshiStream.stop();
  kalshiOrderbookStream.stop();
  feedHub.stopBackgroundPolling();
}

function writeCampaignResult(result: ReturnType<SevenHourCampaignStore['snapshot']>, extra: Record<string, unknown> = {}): void {
  const pointer = pendingCampaignPointer;
  if (!pointer) return;
  const resultPath = path.join(CAMPAIGN_DIR, `${pointer.evidenceNamespace}.result.json`);
  const summaryPath = path.join(CAMPAIGN_DIR, `${pointer.evidenceNamespace}.summary.md`);
  const payload = {
    schemaVersion: 2,
    generatedAt: Date.now(),
    runId: pointer.evidenceNamespace,
    passed: result.passed,
    reasons: result.reasons,
    manifest: result.manifest,
    evidenceIdentity: {
      gitCommit: result.manifest.gitCommit,
      configurationHash: result.manifest.configurationHash,
      healthPolicyHash: result.manifest.schemaVersion === 2 ? result.manifest.healthPolicyHash : null,
      productionArtifactHash: result.manifest.schemaVersion === 2 ? result.manifest.productionArtifactHash : null,
      soakVerificationReceiptHash: result.manifest.schemaVersion === 2 ? result.manifest.soakVerificationReceiptHash : null,
    },
    metrics: {
      candidates: result.candidates.length,
      screenedOut: result.screenedOut?.length ?? 0,
      validDiagnosticOutcomes: result.validDiagnosticOutcomes,
      readyCandidates: result.readyCandidates,
      terminalCoverage: result.terminalCoverage,
      diagnosticSchedulingCoverage: result.diagnosticSchedulingCoverage,
      validDiagnosticCoverage: result.validDiagnosticCoverage,
      freshConfirmationRate: result.freshConfirmationRate,
      runtimeObservedSamples,
      runtimeHealthySamples,
    },
    ...extra,
  };
  writeAtomicJson(resultPath, payload);
  fs.writeFileSync(summaryPath, [
    `# NEMESIS ${pointer.evidenceNamespace}`,
    '',
    `Result: **${result.passed ? 'PASS' : 'FAIL'}**`,
    '',
    ...result.reasons.map((reason) => `- ${reason}`),
    '',
    `Candidates: ${result.candidates.length}`,
    `Valid diagnostics: ${result.validDiagnosticOutcomes}`,
    `Ready candidates: ${result.readyCandidates}`,
    `Runtime health samples: ${runtimeHealthySamples}/${runtimeObservedSamples}`,
    '',
  ].join('\n'), 'utf8');
}

function writePreflightFailureResult(reason: string, now: number, restartable: boolean): void {
  const pointer = pendingCampaignPointer;
  if (!pointer) return;
  writeAtomicJson(path.join(CAMPAIGN_DIR, `${pointer.evidenceNamespace}.result.json`), {
    schemaVersion: 2,
    generatedAt: now,
    runId: pointer.evidenceNamespace,
    passed: false,
    reasons: [reason],
    manifest: {
      schemaVersion: 2,
      runId: pointer.evidenceNamespace,
      evidenceNamespace: pointer.evidenceNamespace,
      parentRunId: pointer.parentRunId,
      restartOrdinal: pointer.restartOrdinal,
      healthPolicyHash: pointer.healthPolicyHash,
      productionArtifactHash: pointer.productionArtifactHash,
      soakVerificationReceiptHash: pointer.soakVerificationReceiptHash,
      stage: pointer.stage,
      status: 'invalidated',
      invalidationReason: reason,
    },
    metrics: {
      candidates: 0,
      screenedOut: 0,
      validDiagnosticOutcomes: 0,
      readyCandidates: 0,
      runtimeObservedSamples,
      runtimeHealthySamples,
    },
    invalidated: true,
    restartable,
  });
}

function prepareCampaignCloseout(now: number): void {
  if (closeoutPrepared || !campaignStore || !pendingCampaignPointer) return;
  closeoutPrepared = true;
  const finalOrderbookTelemetry = kalshiOrderbookStream.telemetry(now);
  stopCampaignInputs();
  const snapshot = campaignStore.snapshot();
  const startedAt = snapshot.manifest.startedAt;
  const expectedSamples = Math.max(1, Math.floor((now - startedAt) / RUNTIME_SAMPLE_INTERVAL_MS) + 1);
  const sampleCoverage = runtimeObservedSamples / expectedSamples;
  const healthyCoverage = runtimeHealthySamples / expectedSamples;
  const rendererHealthy = latestRendererMemoryAssessment.status === 'stable'
    && !latestRendererMemoryAssessment.blocked
    && (latestRendererMemoryAssessment.p95WorkingSetKb ?? Number.POSITIVE_INFINITY) <= 384 * 1024
    && latestRendererMemoryAssessment.slopeWindowComplete
    && latestRendererMemoryAssessment.slopeWindowMs >= 30 * 60_000
    && latestRendererMemoryAssessment.slopePerHour <= 0.02
    && now - lastRendererMemorySampleAt <= 60_000;
  const bridgeHealthy = bridgeStatus.qualificationReady === true && now - lastRuntimeSampleAt <= 60_000;
  campaignStore.record((tracker) => tracker.recordOperationalCheck(
    'renderer_memory_stable',
    rendererHealthy,
    latestRendererMemoryAssessment.detail,
    now,
  ));
  campaignStore.record((tracker) => tracker.recordOperationalCheck(
    'bridge_bidirectional_traffic',
    bridgeHealthy,
    `bridge coverage current=${bridgeStatus.qualificationReady === true} roundTripMs=${bridgeStatus.roundTripMs ?? 'unknown'}`,
    now,
  ));
  campaignStore.record((tracker) => tracker.recordOperationalCheck(
    'runtime_health_coverage',
    sampleCoverage >= 0.95 && healthyCoverage >= 0.995,
    `sample coverage ${(sampleCoverage * 100).toFixed(3)}%; healthy coverage ${(healthyCoverage * 100).toFixed(3)}%`,
    now,
  ));
  const finalExchangeAgeMs = finalOrderbookTelemetry.lastExchangeTimestamp == null
    ? Number.POSITIVE_INFINITY
    : now - finalOrderbookTelemetry.lastExchangeTimestamp;
  const finalExchangeEvidenceReady = finalOrderbookTelemetry.qualificationReady
    && finalExchangeAgeMs >= 0
    && finalExchangeAgeMs <= 25_000;
  campaignStore.record((tracker) => tracker.recordOperationalCheck(
    'exchange_book_time_available',
    finalExchangeEvidenceReady,
    `final sequenced delta received at ${finalOrderbookTelemetry.lastSequencedDeltaAt ?? 'unknown'}; exchange age ${Number.isFinite(finalExchangeAgeMs) ? `${finalExchangeAgeMs}ms` : 'unknown'}`,
    now,
  ));
  const restartOrdinal = snapshot.manifest.schemaVersion === 2 ? snapshot.manifest.restartOrdinal : -1;
  const noRuntimeMitigation = restartOrdinal === 0
    && (latestRuntimeDecision?.recoveryCount ?? 0) === 0;
  campaignStore.record((tracker) => tracker.recordOperationalCheck(
    'no_runtime_restart_or_emergency_mitigation',
    noRuntimeMitigation,
    `restart ordinal ${restartOrdinal}; runtime recoveries ${latestRuntimeDecision?.recoveryCount ?? 0}`,
    now,
  ));
  campaignStore.record((tracker) => tracker.prepareCloseout(now));
  pendingCampaignPointer.status = 'closeout';
  writeActiveCampaignPointer(pendingCampaignPointer);
  runtimeEvidenceSidecar?.appendTransition({ action: 'closeout', sampleCoverage, healthyCoverage }, now);
  writeRuntimeStatus('closeout-ready', { sampleCoverage, healthyCoverage }, true);
}

function finishOfflineCampaignFinalization(now: number): void {
  if (campaignFinalizationState === 'running' || campaignFinalizationState === 'done') return;
  if (!campaignStore || !pendingCampaignPointer || !runtimeEvidenceSidecar) return;
  campaignFinalizationState = 'running';
  if (campaignFinalizationTimer) {
    clearTimeout(campaignFinalizationTimer);
    campaignFinalizationTimer = null;
  }
  try {
    const pointer = pendingCampaignPointer;
    const liveSnapshot = campaignStore.snapshot();
    if (liveSnapshot.integrityError || liveSnapshot.manifest.schemaVersion !== 2 || liveSnapshot.manifest.status !== 'closeout') {
      throw new Error(liveSnapshot.integrityError ?? `offline replay requires schema-v2 closeout, got ${liveSnapshot.manifest.status}`);
    }
    // Inputs and GEA are closed before this single replay becomes the authoritative finalizer.
    const replayedStore = SevenHourCampaignStore.open(pointer.filePath, {
      runId: pointer.evidenceNamespace,
      evidenceNamespace: pointer.evidenceNamespace,
      configurationHash: liveSnapshot.manifest.configurationHash,
      gitCommit: liveSnapshot.manifest.gitCommit,
      stage: pointer.stage,
      startedAt: liveSnapshot.manifest.startedAt,
      settings: entryQualificationSettings(),
      parentRunId: pointer.parentRunId ?? undefined,
      restartOrdinal: pointer.restartOrdinal,
      healthPolicyHash: pointer.healthPolicyHash,
      productionArtifactHash: pointer.productionArtifactHash,
      soakVerificationReceiptHash: pointer.soakVerificationReceiptHash,
      runtimeSidecarPath: pointer.runtimeLedgerPath,
    }, entryQualificationSettings());
    const replayed = replayedStore.snapshot();
    if (replayed.integrityError || replayed.manifest.status !== 'closeout') {
      throw new Error(replayed.integrityError ?? `offline replay produced unexpected status ${replayed.manifest.status}`);
    }
    const runtimeHash = runtimeEvidenceSidecar.finalize({ cleanShutdownRequested: true }, now);
    replayedStore.record((tracker) => tracker.finalize(now, runtimeHash));
    evidenceRunSupervisor?.finalize(runtimeHash);
    campaignStore = replayedStore;
    const result = replayedStore.snapshot();
    writeCampaignResult(result, { finalRuntimeSidecarHash: runtimeHash, offlineReplayCount: 1 });
    writeRuntimeStatus('finalized', {
      passed: result.passed,
      finalRuntimeSidecarHash: runtimeHash,
      offlineReplayCount: 1,
      restartable: false,
    }, true);
    // The active pointer is cleared only after both durable result and status writes succeed.
    fs.rmSync(ACTIVE_CAMPAIGN_PATH, { force: true });
    campaignFinalizationState = 'done';
    setTimeout(() => app.quit(), 250);
  } catch (error) {
    campaignFinalizationState = 'done';
    invalidateEvidenceAttempt([
      `offline campaign finalization failed: ${error instanceof Error ? error.message : String(error)}`,
    ], Date.now(), false);
  }
}

function finalizeCampaign(now: number): void {
  if (!campaignStore || !pendingCampaignPointer || !runtimeEvidenceSidecar) return;
  if (campaignFinalizationState !== 'idle') return;
  stopCampaignInputs();
  if (!geaProcess || geaProcess.killed) {
    finishOfflineCampaignFinalization(now);
    return;
  }
  campaignFinalizationState = 'waiting-gea';
  const closingGea = geaProcess;
  closingGea.once('exit', () => finishOfflineCampaignFinalization(Date.now()));
  if (!closingGea.kill()) {
    campaignFinalizationState = 'done';
    invalidateEvidenceAttempt(['GEA did not accept the clean closeout signal'], now, false);
    return;
  }
  campaignFinalizationTimer = setTimeout(() => {
    campaignFinalizationTimer = null;
    campaignFinalizationState = 'done';
    invalidateEvidenceAttempt(['unclean shutdown: GEA did not exit within 20 seconds'], Date.now(), false);
  }, 20_000);
}

function invalidateEvidenceAttempt(reasons: readonly string[], now: number, restartable = true): void {
  if (evidenceInvalidationInProgress) return;
  evidenceInvalidationInProgress = true;
  const reason = [...new Set(reasons)].join('; ') || 'runtime invalidated';
  campaignEvidencePaused = true;
  evidenceRunSupervisor?.invalidate(reason);
  let runtimeHash: string | null = null;
  if (campaignStore && ['active', 'closeout'].includes(campaignStore.snapshot().manifest.status)) {
    campaignStore.record((tracker) => tracker.invalidate(reason, now));
  }
  try {
    runtimeEvidenceSidecar?.appendTransition({ action: 'invalidate', reason }, now);
    runtimeHash = runtimeEvidenceSidecar?.finalize({ invalidated: true, reason }, now) ?? null;
  } catch {
    restartable = false;
  }
  stopCampaignInputs();
  try {
    if (campaignStore) {
      writeCampaignResult(campaignStore.snapshot(), {
        invalidated: true,
        restartable,
        finalRuntimeSidecarHash: runtimeHash,
      });
    } else {
      writePreflightFailureResult(reason, now, restartable);
    }
    writeRuntimeStatus('invalidated', { reason, restartable }, true);
    // Preserve the pointer whenever either durable invalidation artifact fails.
    fs.rmSync(ACTIVE_CAMPAIGN_PATH, { force: true });
  } catch (error) {
    restartable = false;
    console.error('[nemesis] invalidation artifact persistence failed; active pointer preserved', error);
  }
  if (geaProcess && !geaProcess.killed) geaProcess.kill();
  setTimeout(() => app.quit(), 250);
}

function processEvidenceSupervisor(now: number): void {
  if (!pendingCampaignPointer || !evidenceRunSupervisor) return;
  const control = readEvidenceControl();
  const state = evidenceRunSupervisor.snapshot().status;
  if (control?.command === 'unclean-shutdown') {
    invalidateEvidenceAttempt(['unclean shutdown requested by external supervisor'], now, false);
    return;
  }
  if (state === 'preflight') {
    updatePreflightCycleCounts();
    const ticker = kalshiStream.telemetry(now);
    const orderbook = kalshiOrderbookStream.telemetry(now);
    const permanentTransportFailure = [ticker.failureClass, orderbook.failureClass]
      .find((failure) => failure === 'authentication' || failure === 'authorization' || failure === 'configuration');
    if (permanentTransportFailure) {
      invalidateEvidenceAttempt([`permanent Kalshi websocket failure: ${permanentTransportFailure}`], now, false);
      return;
    }
    const freshProductionMarkets = [...productionMarketRecords.keys()]
      .filter((ticker) => productionMarketRecord(ticker, now) != null).length;
    if (discovery.hasLiveUniverse() && preflightRestCycles >= 3 && freshProductionMarkets < ORDERBOOK_TRACKING_LIMIT) {
      invalidateEvidenceAttempt(['orderbook_tracking_set_below_25'], now, false);
      return;
    }
    const continuouslyHealthy = preflightHealthyForStability();
    const readyForStart = continuouslyHealthy && latestRendererMemoryAssessment.status === 'stable';
    const decision = evidenceRunSupervisor.observePreflight(now, continuouslyHealthy, readyForStart);
    if (decision.state === 'invalidated') {
      invalidateEvidenceAttempt([decision.reason], now);
      return;
    }
    if (decision.state === 'preflight-ready') writeRuntimeStatus('preflight-ready', preflightReadinessDetail(), true);
    else writeRuntimeStatus('preflight', preflightReadinessDetail());
    if (control?.command === 'start-campaign' && decision.state === 'preflight-ready') {
      const start = evidenceRunSupervisor.start(now);
      if (!startEvidenceCampaign(pendingCampaignPointer, now)) {
        invalidateEvidenceAttempt(['campaign ledger could not be started after preflight'], now, false);
        return;
      }
      runtimeObservedSamples = 0;
      runtimeHealthySamples = 0;
      runtimeHealthController = new RuntimeHealthController();
      latestRuntimeDecision = null;
      campaignEvidencePaused = false;
      runtimeEvidenceSidecar?.appendTransition({ action: 'start-campaign' }, now);
      writeRuntimeStatus('active', { cutoffAt: start.manifest.cutoffAt }, true);
    }
    return;
  }
  if (state === 'preflight-ready') {
    writeRuntimeStatus('preflight-ready', preflightReadinessDetail());
    if (control?.command === 'start-campaign') {
      const start = evidenceRunSupervisor.start(now);
      if (!startEvidenceCampaign(pendingCampaignPointer, now)) {
        invalidateEvidenceAttempt(['campaign ledger could not be started after preflight'], now, false);
        return;
      }
      runtimeObservedSamples = 0;
      runtimeHealthySamples = 0;
      runtimeHealthController = new RuntimeHealthController();
      latestRuntimeDecision = null;
      campaignEvidencePaused = false;
      runtimeEvidenceSidecar?.appendTransition({ action: 'start-campaign' }, now);
      writeRuntimeStatus('active', { cutoffAt: start.manifest.cutoffAt }, true);
    }
    return;
  }
  if (state === 'active') {
    const transition = evidenceRunSupervisor.tick(now);
    if (transition.state === 'closeout') prepareCampaignCloseout(now);
    else writeRuntimeStatus('active');
    return;
  }
  if (state === 'closeout' && control?.command === 'finalize') finalizeCampaign(now);
}

function recordCampaignOperationalTelemetry(): void {
  const now = Date.now();
  const activeSnapshot = campaignSnapshot();
  if (activeSnapshot?.integrityError) {
    invalidateEvidenceAttempt([activeSnapshot.integrityError], now, false);
    return;
  }
  if (activeSnapshot?.manifest.status === 'invalidated') {
    invalidateEvidenceAttempt([activeSnapshot.manifest.invalidationReason ?? 'campaign configuration invalidated'], now, false);
    return;
  }
  const productionObservation = currentProductionObservationState();
  if (pendingCampaignPointer && !productionObservation.qualificationReady) {
    invalidateEvidenceAttempt([
      `production observation integrity failed: ${productionObservation.reasons.join('; ')}`,
    ], now, false);
    return;
  }
  if (pendingCampaignPointer && !getLiveCreds()) {
    invalidateEvidenceAttempt(['protected Kalshi credentials became unavailable'], now, false);
    return;
  }
  if (pendingCampaignPointer && geaExitedDuringEvidence) {
    invalidateEvidenceAttempt(['GEA process exited during supervised evidence'], now);
    return;
  }
  const components = runtimeComponents(now);
  const rendererRuntimeAssessment = currentRendererRuntimeAssessment(now);
  const rendererHeartbeat = rendererHeartbeatMonitor.snapshot(now);
  const rendererLoadRetryGraceActive = rendererHeartbeat.loadFinishedAt == null
    && now - rendererHeartbeat.loadStartedAt <= RENDERER_LOAD_RETRY_GRACE_MS
    && !rendererHeartbeat.blocked;
  const supervisorState = evidenceRunSupervisor?.snapshot().status;
  if (supervisorState === 'preflight') runtimeHealthController = new RuntimeHealthController();
  latestRuntimeDecision = runtimeHealthController.observe({
    at: now,
    components,
    renderer: rendererRuntimeAssessment,
    process: {
      // GEA is intentionally held until the renderer load gate opens. During
      // the bounded renderer retry window, its absence is not a GEA failure;
      // a terminal renderer load failure will block the attempt explicitly.
      geaRunning: rendererLoadRetryGraceActive
        || rendererProbeGateInProgress
        || process.env.NEMESIS_AUTO_SPAWN_GEA === 'false'
        || Boolean(geaProcess && !geaProcess.killed),
      // Renderer memory/heartbeat faults are already carried with their exact
      // reasons above. Main-process responsiveness is supervised externally.
      nemesisResponsive: true,
    },
  });
  lastRuntimeSampleAt = now;
  if (campaignStore?.snapshot().manifest.status === 'active') {
    runtimeObservedSamples += 1;
    if (latestRuntimeDecision.lease.status === 'healthy') runtimeHealthySamples += 1;
  }
  try {
    unsupervisedRuntimeStatusExporter.writeIfDue(runtimeStatusPayload(
      latestRuntimeDecision.state,
      { externalRuntimeStatus: true },
      now,
    ), now);
  } catch (error) {
    console.error('[nemesis] optional runtime status export failed', error);
  }
  try {
    const processes = currentProcessTelemetry(now);
    runtimeEvidenceSidecar?.appendSample({
      state: latestRuntimeDecision.state,
      lease: latestRuntimeDecision.lease,
      components,
      renderer: rendererRuntimeAssessment,
      bridge: { ...bridgeStatus },
      processes,
      feeds: currentFeedHealthSnapshot(now),
      orderbookTracking: currentOrderbookTrackingState(now),
      productionObservation,
    }, now);
  } catch (error) {
    invalidateEvidenceAttempt([`runtime evidence persistence failed: ${error instanceof Error ? error.message : String(error)}`], now, false);
    return;
  }
  if (latestRuntimeDecision.action !== lastRuntimeTransitionAction) {
    runtimeEvidenceSidecar?.appendTransition({
      action: latestRuntimeDecision.action,
      reasons: latestRuntimeDecision.reasons,
    }, now);
    lastRuntimeTransitionAction = latestRuntimeDecision.action;
  }
  if (shouldInvalidateSupervisedEvidence(Boolean(pendingCampaignPointer), supervisorState, latestRuntimeDecision.invalidated)) {
    invalidateEvidenceAttempt(latestRuntimeDecision.reasons, now);
    return;
  }
  if (pendingCampaignPointer) {
    if (latestRuntimeDecision.pauseEvidence) campaignEvidencePaused = true;
    else if (latestRuntimeDecision.action === 'resume' || latestRuntimeDecision.state === 'healthy') campaignEvidencePaused = false;
  }
  const snapshot = campaignSnapshot();
  const orderbookTelemetry = kalshiOrderbookStream.telemetry();
  if (snapshot?.manifest.status === 'active'
    && orderbookTelemetry.sequenceRegressions > 0
    && !snapshot.safetyFailures.some((failure) => failure.includes('order-book sequence regression'))) {
    campaignStore?.record((tracker) => tracker.recordSafetyFailure(
      `${orderbookTelemetry.sequenceRegressions} order-book sequence regression(s) detected`,
    ));
  }
  processEvidenceSupervisor(now);
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
    if (PRODUCTION_OBSERVATION_MODE) return snapshot;
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
  if (PRODUCTION_OBSERVATION_MODE) return false;
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
    if (PRODUCTION_OBSERVATION_MODE) return snapshot;
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
  if (PRODUCTION_OBSERVATION_MODE) return;
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
  formalQualificationEligible?: boolean;
}) {
  if (PRODUCTION_OBSERVATION_MODE) return;
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
  if (input.formalQualificationEligible !== false) {
    recordQualification((tracker) => tracker.recordAbort(
      input.code ?? 'paper_abort',
      input.detail,
      blocksLiveUnlock,
    ));
  }
  saveAuditLog();
}

function recordSettingsManualOverride() {
  if (PRODUCTION_OBSERVATION_MODE) return;
  recordManualOverride(ensureShutdownCounters());
  saveSessionStats();
}

function tickApiHealthDegraded() {
  if (PRODUCTION_OBSERVATION_MODE) return;
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
      // Supervised evidence always uses the production market-data feeds in
      // dry-run mode; demo fixtures must never satisfy feed readiness.
      demoMode: false,
      dryRun: true,
    });
  }
  if (PRODUCTION_OBSERVATION_MODE) {
    settings = normalizeGuardrailSettings({
      ...settings,
      liveEnabled: false,
      liveStage: 'paper',
      autoLiveEnabled: false,
      demoMode: false,
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
  const supervisedMaxTickers = Number.parseInt(process.env.NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS ?? '', 10);
  if (Number.isFinite(supervisedMaxTickers) && supervisedMaxTickers > 0) {
    discovery.loadSettings({ ...discovery.settings, maxTrackedTickers: Math.min(500, supervisedMaxTickers) });
  }
}

function saveDiscoverySettings() {
  ensureDataDir();
  fs.writeFileSync(DISCOVERY_SETTINGS_PATH, JSON.stringify(discovery.settings, null, 2));
}

function broadcastDiscovery() {
  const state = discovery.getState();
  const revision = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  if (revision === lastDiscoveryRevision) return;
  lastDiscoveryRevision = revision;
  broadcast('discovery:update', state);
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
  const payload = buildWorldEventsPayload();
  const revision = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (revision === lastWorldRevision) return;
  lastWorldRevision = revision;
  broadcast('worldevents:update', payload);
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
  if (PRODUCTION_OBSERVATION_MODE) {
    // Renderer summaries may calculate mark-to-market values, but production
    // observation must not append paper equity or session-stat evidence.
    return;
  }
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

interface CampaignEnrollmentResult {
  candidate: CampaignCandidateRecord | null;
  decision: CampaignScreeningDecisionV2 | null;
}

interface CampaignScreeningEvidenceContext {
  fill?: DryRunOrder;
  feePolicy?: KalshiFeePolicy;
  entryRiskUsd?: number;
  maxSafeContracts?: number;
}

function finiteCampaignNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

/** Records every pre-enrollment campaign rejection without creating lifecycle or diagnostic state. */
function recordPreEnrollmentScreeningFailure(
  card: ThesisCard,
  reasonCode: CampaignScreeningReasonCode,
  reason: string,
  completedAt = Date.now(),
  context: CampaignScreeningEvidenceContext = {},
): void {
  const snapshot = campaignSnapshot();
  if (!campaignStore || snapshot?.manifest.status !== 'active' || findCampaignCandidate(card)) return;
  const fallbackPrice = Math.max(0.0001, Math.min(0.9999, finiteCampaignNumber(card.marketPrice, 0.5)));
  const fill: DryRunOrder = context.fill ?? {
    ticker: card.ticker,
    side: card.side,
    contracts: 1,
    expectedPrice: fallbackPrice,
    fillPrice: fallbackPrice,
    filled: 1,
    fillLevels: [{ price: fallbackPrice, quantity: 1, cost: fallbackPrice }],
    slippage: 0,
    fees: 0,
    feePolicyKnown: false,
    netEdge: finiteCampaignNumber(card.netEdge, 0),
    aborted: true,
    abortReason: reason,
  };
  const contracts = Math.max(0.01, finiteCampaignNumber(fill.filled || fill.contracts, 1));
  const entryPrice = Math.max(0.0001, Math.min(0.9999, finiteCampaignNumber(fill.fillPrice, fallbackPrice)));
  const feePolicy = isKnownKalshiFeePolicy(context.feePolicy) ? context.feePolicy : undefined;
  const economics = calculateEntryEconomics({
    entryPrice,
    entryFeesUsd: Math.max(0, finiteCampaignNumber(fill.fees, 0)),
    contracts,
    sideFairPrice: Math.max(0.0001, Math.min(0.9999, finiteCampaignNumber(card.impliedPrice, entryPrice))),
    marketPrice: finiteCampaignNumber(card.marketPrice, entryPrice),
    grossEdge: finiteCampaignNumber(card.grossEdge, 0),
    screeningNetEdge: finiteCampaignNumber(card.netEdge, 0),
    executableEntryNetEdge: finiteCampaignNumber(fill.netEdge, 0),
    spread: Math.max(0, finiteCampaignNumber(card.spread, 0)),
    fillSlippage: Math.max(0, finiteCampaignNumber(fill.slippage, 0)),
    feePolicy,
  });
  const decision: CampaignScreenedOut = {
    schemaVersion: 2,
    economicIdentity: candidateEconomicIdentity(card),
    originalCardId: card.id,
    ticker: card.ticker,
    side: card.side,
    completedAt,
    economics,
    entryRiskUsd: finiteCampaignNumber(context.entryRiskUsd, economics.entryCostUsd),
    maxSafeContracts: context.maxSafeContracts,
    status: 'screened_out',
    reasonCode,
    reason,
  };
  campaignStore.record((tracker) => tracker.recordScreenedOut({ card, decision, completedAt }));
}

function screeningReasonForPreview(preview: PaperBuyResult): CampaignScreeningReasonCode {
  const detail = `${preview.abortCode ?? ''} ${preview.abortReason ?? ''} ${preview.error ?? ''}`.toLowerCase();
  if (/reward.?risk|2:1/.test(detail)) return 'reward_risk_below_minimum';
  if (/stress/.test(detail)) return 'stress_profit_below_minimum';
  if (/risk|\$10/.test(detail)) return 'entry_risk_above_limit';
  if (/fair price/.test(detail)) return 'fair_price_not_above_entry';
  if (/edge/.test(detail)) return 'non_positive_executable_edge';
  if (/reward|profit|strict_profit/.test(detail)) return 'target_reward_below_minimum';
  return 'incomplete_fill';
}

function enrollCampaignCandidate(card: ThesisCard, preview: PaperBuyResult, book: KalshiOrderbook, at: number): CampaignEnrollmentResult {
  if (!campaignStore || !preview.fill || !preview.profitCertificate) return { candidate: null, decision: null };
  const fill = preview.fill;
  const existing = findCampaignCandidate(card);
  if (existing) return { candidate: existing, decision: null };
  const decision = qualifyCampaignEnrollment({
    card,
    fill,
    bookTimestamp: book.sourceTimestamp ?? Number.NaN,
    bookSequence: book.sequence,
    feePolicy: book.feePolicy,
    observedAt: at,
    sourceAlreadyUsed: campaignEntryConfirmationEngine.hasUsedSource(card.id),
    lastTickerExecutionAt: lastTickerSideExecutionAt.get(opportunityKey(card)),
    maxSafeContracts: preview.capitalDecision?.maxSafeContracts,
    entryRiskUsd: preview.capitalDecision?.riskUsd,
    settings: entryQualificationSettings(),
  });
  if (decision.status === 'screened_out') {
    campaignStore.record((tracker) => tracker.recordScreenedOut({ card, decision, completedAt: at }));
    return { candidate: null, decision };
  }
  campaignStore.record((tracker) => tracker.enrollQualified({
    card,
    initialFill: fill,
    screening: decision,
    completedAt: at,
  }));
  refreshOrderbookTracking();
  return { candidate: findCampaignCandidate(card), decision };
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
  const activeCampaign = source === 'throughput' ? campaignSnapshot() : null;
  const evidenceOnlyCampaign = isEvidenceOnlyCampaignExecution(source, activeCampaign);
  const mutationLock = campaignMutationLockReason();
  if (mutationLock && !evidenceOnlyCampaign) {
    return { ok: false, aborted: true, abortReason: mutationLock, error: mutationLock, abortCode: 'campaign_mutation_lock', queueState: 'blocked_final', wouldMutate: false };
  }
  if (evidenceOnlyCampaign && campaignEvidencePaused) {
    const reason = `campaign evidence paused while runtime is ${latestRuntimeDecision?.state ?? 'not ready'}`;
    return { ok: false, aborted: true, abortReason: reason, error: reason, abortCode: 'campaign_runtime_paused', queueState: 'blocked_retryable', wouldMutate: false };
  }
  if (source !== 'manual' && qualificationSnapshot()?.rollingLossPaused) {
    const reason = 'automatic entries paused by the rolling 20-position loss rule';
    recordPaperBlock({
      thesisId: card.id,
      ticker: card.ticker,
      detail: reason,
      code: 'rolling_loss_pause',
      severity: 'warning',
      blocksLiveUnlock: false,
      formalQualificationEligible: !evidenceOnlyCampaign,
    });
    return { ok: false, error: reason, abortCode: 'rolling_loss_pause', queueState: 'blocked_final', wouldMutate: false };
  }
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
    if (evidenceOnlyCampaign) {
      recordPreEnrollmentScreeningFailure(
        card,
        /net edge/i.test(eligibilityBlock) ? 'non_positive_executable_edge' : 'automatic_source_required',
        eligibilityBlock,
      );
    }
    recordPaperBlock({
      thesisId: card.id,
      ticker: card.ticker,
      detail: eligibilityBlock,
      code: 'signal_eligibility_block',
      severity: 'info',
      blocksLiveUnlock: false,
      formalQualificationEligible: !evidenceOnlyCampaign,
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
    if (evidenceOnlyCampaign) {
      recordPreEnrollmentScreeningFailure(card, 'entry_risk_above_limit', risk.error ?? 'risk gate blocked');
    }
    recordPaperBlock({
      thesisId,
      ticker: card.ticker,
      detail: risk.error ?? 'blocked',
      code: 'risk_gate_block',
      severity: 'warning',
      blocksLiveUnlock: false,
      formalQualificationEligible: !evidenceOnlyCampaign,
    });
    opportunityQueue.markBlocked(key, risk.error ?? 'risk gate blocked', false);
    return { ok: false, error: risk.error, abortCode: 'risk_gate_block', queueState: 'blocked_final', wouldMutate: false };
  }

  let book: KalshiOrderbook;
  try {
    book = await fetchBookForCard(card);
    opportunityQueue.markBookFetched(key);
    if (source === 'throughput' && !evidenceOnlyCampaign) {
      recordQualification((tracker) => tracker.recordFunnel('books_fetched'));
    }
  } catch (error) {
    const reason = describeBookFetchError(error);
    if (evidenceOnlyCampaign) {
      recordPreEnrollmentScreeningFailure(card, 'missing_exchange_provenance', `book unavailable: ${reason}`);
    }
    const backoffActive = isBookFetchBackoffError(error);
    opportunityQueue.markBlocked(key, `book unavailable: ${reason}`, true);
    if (source === 'throughput' && !evidenceOnlyCampaign) {
      recordQualification((tracker) => tracker.recordFunnel('books_unavailable', 1, 'book_unavailable'));
    }
    if (!backoffActive) {
      sessionStatsData.abortCount += 1;
      recordPaperBlock({
        thesisId,
        ticker: card.ticker,
        detail: `${source} paper buy blocked: book unavailable (${reason})`,
        code: 'book_unavailable',
        severity: 'warning',
        blocksLiveUnlock: false,
        formalQualificationEligible: !evidenceOnlyCampaign,
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

  if (evidenceOnlyCampaign) {
    const readiness = campaignEnrollmentReadiness(
      book,
      Date.now(),
      entryQualificationSettings().maxBookAgeMs,
    );
    if (!readiness.ready) {
      const reasonCode: CampaignScreeningReasonCode = /fee/i.test(readiness.reason)
        ? 'fee_policy_unknown'
        : /stale|age/i.test(readiness.reason)
          ? 'book_stale'
          : 'missing_exchange_provenance';
      recordPreEnrollmentScreeningFailure(card, reasonCode, readiness.reason, Date.now(), {
        feePolicy: book.feePolicy,
      });
      opportunityQueue.markBlocked(key, readiness.reason, true);
      return {
        ok: false,
        aborted: true,
        abortReason: readiness.reason,
        error: readiness.reason,
        abortCode: 'entry_confirmation_pending',
        queueState: 'blocked_retryable',
        wouldMutate: false,
      };
    }
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
      if (evidenceOnlyCampaign) {
        recordPreEnrollmentScreeningFailure(card, 'incomplete_fill', 'entry ask is not executable', Date.now(), {
          feePolicy: book.feePolicy,
        });
      }
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
    if (evidenceOnlyCampaign) {
      recordPreEnrollmentScreeningFailure(card, screeningReasonForPreview(preview), blockReason, Date.now(), {
        fill: preview.fill,
        feePolicy: book.feePolicy,
        entryRiskUsd: preview.capitalDecision?.riskUsd,
        maxSafeContracts: preview.capitalDecision?.maxSafeContracts,
      });
    }
    opportunityQueue.markBlocked(key, blockReason, retryableFromResult(preview));
    recordPaperBlock({
      thesisId,
      ticker: card.ticker,
      detail: blockReason,
      code: preview.abortCode,
      severity: preview.abortCode === 'strict_profit_block' ? 'info' : 'warning',
      blocksLiveUnlock: isAbnormalExecutionCode(preview.abortCode),
      formalQualificationEligible: !evidenceOnlyCampaign,
    });
    sessionStatsData.abortCount += 1;
    saveSessionStats();
    return preview;
  }

  const observedAt = Date.now();
  const enrollment = enrollCampaignCandidate(card, preview, book, observedAt);
  const campaignCandidate = enrollment.candidate;
  if (evidenceOnlyCampaign && enrollment.decision?.status === 'screened_out') {
    opportunityQueue.markBlocked(key, enrollment.decision.reason, false);
    return {
      ok: false,
      aborted: true,
      abortReason: enrollment.decision.reason,
      error: enrollment.decision.reason,
      abortCode: `campaign_screened_out:${enrollment.decision.reasonCode}`,
      queueState: 'blocked_final',
      wouldMutate: false,
    };
  }
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
      formalQualificationEligible: !evidenceOnlyCampaign,
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
  if (PRODUCTION_OBSERVATION_MODE) return;
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
  if (PRODUCTION_OBSERVATION_MODE) return;
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
  if (campaignMutationLockReason()) return false;
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
  if (campaignMutationLockReason()) return;
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
  if (campaignMutationLockReason()) return;
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

async function runThroughputCertification(trigger: string, tickerFilter?: ReadonlySet<string>) {
  const throughput = { ...DEFAULT_OPPORTUNITY_THROUGHPUT, ...(settings.opportunityThroughput ?? {}) };
  const activeCampaign = campaignSnapshot()?.manifest.status === 'active';
  if (throughputRunning && activeCampaign && tickerFilter) {
    for (const ticker of tickerFilter) pendingCampaignThroughputTickers.add(ticker);
    return;
  }
  if (
    !throughput.enabled
    || throughputRunning
    || (activeCampaign && campaignEvidencePaused)
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

    const throughputCampaign = campaignSnapshot();
    const existingCampaignIdentities = throughputCampaign?.manifest.status === 'active'
      ? new Set(throughputCampaign.candidates.map((candidate) => candidate.economicIdentity))
      : null;
    const rawCandidates = tickerFilter
      ? theses.filter((card) => tickerFilter.has(card.ticker))
      : theses;
    const formalQualificationEligible = throughputCampaign?.manifest.status !== 'active';
    if (formalQualificationEligible) {
      recordQualification((tracker) => tracker.recordFunnel('raw_candidates', rawCandidates.length));
    }
    const rankedCandidates = rawCandidates
      .filter((card) => isEntryEligible(card)
        && hasRealExecutableDepth(card)
        && !openKeys.has(opportunityKey(card))
        && !existingCampaignIdentities?.has(candidateEconomicIdentity(card)))
      .sort((a, b) => {
        const edgeDelta = b.netEdge - a.netEdge;
        if (edgeDelta !== 0) return edgeDelta;
        return (a.freshnessMs ?? 0) - (b.freshnessMs ?? 0);
      });
    if (formalQualificationEligible) {
      recordQualification((tracker) => tracker.recordFunnel('entry_eligible', rankedCandidates.length));
    }
    const deduplicatedCandidates = dedupeByExecutionKey(rankedCandidates, opportunityKey);
    const duplicateCount = rankedCandidates.length - deduplicatedCandidates.length;
    if (duplicateCount > 0 && formalQualificationEligible) {
      recordQualification((tracker) => tracker.recordFunnel('duplicates_removed', duplicateCount, 'duplicate_execution_key'));
    }
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
    if (pendingCampaignThroughputTickers.size > 0 && !campaignEvidencePaused) {
      const queued = new Set(pendingCampaignThroughputTickers);
      pendingCampaignThroughputTickers.clear();
      queueMicrotask(() => { void runThroughputCertification('coalesced-exchange-book-delta', queued); });
    }
  }
}

async function evaluateCampaignConfirmations(tickerFilter?: ReadonlySet<string>): Promise<void> {
  const initial = campaignSnapshot();
  if (!campaignStore || !initial || initial.manifest.status !== 'active' || campaignEvidencePaused) return;
  if (tickerFilter) for (const ticker of tickerFilter) pendingCampaignConfirmationTickers.add(ticker);
  else for (const candidate of initial.candidates) if (!candidate.terminalState) pendingCampaignConfirmationTickers.add(candidate.ticker);
  if (campaignConfirmationWorkerRunning) return;
  campaignConfirmationWorkerRunning = true;
  try {
    while (pendingCampaignConfirmationTickers.size > 0 && !campaignEvidencePaused) {
      const tickers = new Set([...pendingCampaignConfirmationTickers].slice(0, 4));
      for (const ticker of tickers) pendingCampaignConfirmationTickers.delete(ticker);
      const snapshot = campaignSnapshot();
      if (!snapshot || snapshot.manifest.status !== 'active' || Date.now() >= snapshot.manifest.cutoffAt) break;
      const candidates = snapshot.candidates.filter((candidate) => !candidate.terminalState && tickers.has(candidate.ticker));
      await Promise.all(candidates.map(async (candidate) => {
        const result = await executeStrictPaperBuyForCard(
          candidate.card,
          candidate.initialFill.contracts,
          'throughput',
        );
        if (
          campaignStore
          && !['book_unavailable', 'entry_confirmation_pending', 'execution_in_flight', 'campaign_runtime_paused'].includes(result.abortCode ?? '')
          && !['campaign_candidate_ready', 'campaign_candidate_terminal'].includes(result.abortCode ?? '')
        ) {
          campaignStore.record((tracker) => tracker.terminalize(
            candidate.candidateId,
            'rejected',
            result.abortReason ?? result.error ?? 'campaign confirmation failed closed',
            Date.now(),
          ));
        }
      }));
    }
  } finally {
    campaignConfirmationWorkerRunning = false;
    if (pendingCampaignConfirmationTickers.size > 0 && !campaignEvidencePaused) {
      queueMicrotask(() => { void evaluateCampaignConfirmations(new Set()); });
    }
  }
}

type DiagnosticFailureOutcome = Exclude<DiagnosticAttemptOutcome, 'valid_observation'>;

function recordDiagnosticFailure(
  diagnosticId: string,
  outcome: DiagnosticFailureOutcome,
  detail: string,
  completedAt: number,
  book?: KalshiOrderbook,
): void {
  campaignStore?.record((tracker) => tracker.recordDiagnosticAttempt({
    diagnosticId,
    outcome,
    detail,
    completedAt,
    exchangeTimestamp: book?.sourceTimestamp,
    exchangeSequence: book?.sequence,
  }));
}

function evaluateDiagnosticBook(
  diagnostic: ReturnType<SevenHourCampaignStore['snapshot']>['diagnostics'][number],
  candidate: CampaignCandidateRecord,
  book: KalshiOrderbook,
): void {
  const completedAt = Date.now();
  if (book.sourceTimestamp == null || book.sequence == null) {
    recordDiagnosticFailure(diagnostic.diagnosticId, 'missing_provenance', 'matching order-book delta lacked exchange timestamp or sequence', completedAt, book);
    return;
  }
  const bookAgeMs = completedAt - book.sourceTimestamp;
  if (bookAgeMs < 0 || bookAgeMs > entryQualificationSettings().maxBookAgeMs) {
    recordDiagnosticFailure(diagnostic.diagnosticId, 'stale_book', `matching order-book delta age was ${bookAgeMs}ms at completion`, completedAt, book);
    return;
  }
  if (!isKnownKalshiFeePolicy(book.feePolicy)) {
    recordDiagnosticFailure(diagnostic.diagnosticId, 'fee_unknown', 'market, series, or account fee policy was unresolved', completedAt, book);
    return;
  }
  const fill = dryRunCloseFill(
    book,
    candidate.side,
    candidate.initialFill.filled,
    candidate.initialFill.fillPrice,
    settings.maxSlippagePp,
  );
  if (fill.filled <= 0) {
    recordDiagnosticFailure(diagnostic.diagnosticId, 'insufficient_depth', fill.abortReason ?? 'no executable close-side depth', completedAt, book);
    return;
  }
  if (fill.filled !== candidate.initialFill.filled) {
    recordDiagnosticFailure(diagnostic.diagnosticId, 'partial_fill', fill.abortReason ?? 'follow-up fill was partial', completedAt, book);
    return;
  }
  if (fill.slippage > settings.maxSlippagePp || /slippage/i.test(fill.abortReason ?? '')) {
    recordDiagnosticFailure(diagnostic.diagnosticId, 'slippage_exceeded', fill.abortReason ?? 'follow-up slippage exceeded the limit', completedAt, book);
    return;
  }
  if (!fill.feePolicyKnown) {
    recordDiagnosticFailure(diagnostic.diagnosticId, 'fee_unknown', 'reconstructed follow-up fees were not exact', completedAt, book);
    return;
  }
  if (fill.aborted) {
    recordDiagnosticFailure(diagnostic.diagnosticId, 'insufficient_depth', fill.abortReason ?? 'follow-up fill aborted', completedAt, book);
    return;
  }
  const entryCost = candidate.initialFill.fillPrice * candidate.initialFill.filled + candidate.initialFill.fees;
  const netPnl = fill.fillPrice * fill.filled - fill.fees - entryCost;
  campaignStore?.record((tracker) => tracker.completeDiagnostic({
    diagnosticId: diagnostic.diagnosticId,
    validExecutableObservation: true,
    exchangeTimestamp: book.sourceTimestamp,
    exchangeSequence: book.sequence,
    executableFollowUpMark: fill.fillPrice,
    reconstructedExitFill: fill,
    executableNetPnlUsd: Number(netPnl.toFixed(6)),
    targetAt: netPnl >= candidate.economics.targetRewardUsd ? completedAt : undefined,
    lossAt: netPnl <= -candidate.economics.plannedLossUsd ? completedAt : undefined,
    edgeGoneAt: netPnl <= 0 ? completedAt : undefined,
    reason: 'valid executable follow-up reconstructed directly from a matching exchange delta and resolved fees',
    completedAt,
  }));
}

async function evaluateCampaignDiagnostics(tickerFilter?: ReadonlySet<string>, _fromExchangeDelta = false): Promise<void> {
  const initial = campaignSnapshot();
  if (!campaignStore || !initial || initial.manifest.status !== 'active' || campaignEvidencePaused) return;
  if (tickerFilter) {
    for (const ticker of tickerFilter) {
      pendingCampaignDiagnosticTickers.add(ticker);
    }
  }
  else {
    const now = Date.now();
    const dueIds = new Set(campaignStore.tracker.dueDiagnostics(now).map((diagnostic) => diagnostic.candidateId));
    for (const candidate of initial.candidates) if (dueIds.has(candidate.candidateId)) pendingCampaignDiagnosticTickers.add(candidate.ticker);
  }
  if (campaignDiagnosticWorkerRunning) return;
  campaignDiagnosticWorkerRunning = true;
  try {
    while (pendingCampaignDiagnosticTickers.size > 0 && !campaignEvidencePaused) {
      const tickers = new Set([...pendingCampaignDiagnosticTickers].slice(0, 4));
      for (const ticker of tickers) pendingCampaignDiagnosticTickers.delete(ticker);
      const observations = new Map<string, CampaignBookObservation>();
      for (const ticker of tickers) {
        const observation = pendingCampaignDiagnosticObservations.get(ticker);
        if (!observation) continue;
        observations.set(ticker, observation);
        if (pendingCampaignDiagnosticObservations.get(ticker) === observation) {
          pendingCampaignDiagnosticObservations.delete(ticker);
        }
      }
      const snapshot = campaignSnapshot();
      if (!snapshot || snapshot.manifest.status !== 'active') break;
      const now = Date.now();
      const candidates = new Map(snapshot.candidates.map((candidate) => [candidate.candidateId, candidate]));
      const diagnostics = snapshot.diagnostics.filter((diagnostic) => {
        const candidate = candidates.get(diagnostic.candidateId);
        return candidate && tickers.has(candidate.ticker) && diagnostic.status === 'scheduled' && diagnostic.dueAt <= now;
      });
      for (const diagnostic of diagnostics) {
        const candidate = candidates.get(diagnostic.candidateId)!;
        const observation = observations.get(candidate.ticker);
        if (observation?.feeResult.status === 'resolved') {
          evaluateDiagnosticBook(diagnostic, candidate, observation.book);
          continue;
        }
        if (observation?.feeResult.status === 'failed') {
          recordDiagnosticFailure(
            diagnostic.diagnosticId,
            observation.feeResult.outcome,
            observation.feeResult.detail,
            observation.completedAt,
            observation.book,
          );
          continue;
        }
        const dueNow = campaignStore.tracker.dueDiagnostics(now).some((item) => item.diagnosticId === diagnostic.diagnosticId);
        if (!dueNow) continue;
        recordDiagnosticFailure(diagnostic.diagnosticId, 'no_delta', 'no matching fresh order-book delta arrived at the paced evaluation time', now);
      }
    }
  } finally {
    campaignDiagnosticWorkerRunning = false;
    if (pendingCampaignDiagnosticTickers.size > 0 && !campaignEvidencePaused) {
      queueMicrotask(() => { void evaluateCampaignDiagnostics(new Set()); });
    }
  }
}

function broadcastPaperUpdate(forceSnapshot = false) {
  const marks = getMarkPrices();
  const mtm = paperDesk.markToMarket(marks);
  const portfolio = paperDesk.snapshot();
  const marksObj: Record<string, number> = {};
  for (const [k, v] of marks) marksObj[k] = v;
  snapshotEquity(forceSnapshot);
  equityHistoryStream.replace(equityHistory);
  broadcast('paper:update', {
    portfolio,
    marks: marksObj,
    equity: mtm.equity,
    unrealized: mtm.unrealized,
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
  const currentTheses = thesesForUi();
  const items: MarketStateStreamItem[] = [
    ...marketsCache.map((market) => marketStreamItem(`market:${market.ticker}`, 'market', market)),
    ...currentTheses.map((thesis) => marketStreamItem(`thesis:${thesis.id}`, 'thesis', thesis)),
  ];
  marketStateStream.replace(items);
  const activeKeys = new Set(items.map((item) => item.key));
  for (const key of marketStreamItemCache.keys()) if (!activeKeys.has(key)) marketStreamItemCache.delete(key);
  broadcast('markets:update', {
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
  const throttleMs = paperDesk.snapshot().positions.length > 0
    ? PAPER_BROADCAST_THROTTLE_MS
    : PAPER_SUMMARY_BROADCAST_THROTTLE_MS;
  paperBroadcastTimer = setTimeout(() => {
    paperBroadcastTimer = null;
    broadcastPaperUpdate();
  }, throttleMs);
}

function campaignCriticalOrderbookTickers(now = Date.now()): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (ticker: string | undefined) => {
    if (!ticker || seen.has(ticker)) return;
    seen.add(ticker);
    ordered.push(ticker);
  };
  const campaign = campaignStore?.snapshot();
  if (campaign?.manifest.status === 'active') {
    const candidates = new Map(campaign.candidates.map((candidate) => [candidate.candidateId, candidate]));
    for (const candidate of campaign.candidates) if (!candidate.terminalState) add(candidate.ticker);
    for (const diagnostic of campaign.diagnostics) {
      if (diagnostic.status !== 'scheduled' || diagnostic.dueAt > now + 60_000) continue;
      add(candidates.get(diagnostic.candidateId)?.ticker);
    }
  }
  // Apply the 25-ticker bound only after production/live filtering. Slicing
  // before filtering could let stale or demo candidates crowd out live ones.
  return ordered;
}

function productionMarketRecord(ticker: string, now = Date.now()): ProductionUniverseRecord | null {
  const record = productionMarketRecords.get(ticker);
  if (!record) return null;
  if (now < record.verifiedAt || now > record.verifiedAt + DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS) return null;
  return record;
}

function recordProductionUniverse(records: readonly ProductionUniverseRecord[]): void {
  const now = Date.now();
  for (const [ticker, record] of productionMarketRecords) {
    if (now > record.verifiedAt + DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS) productionMarketRecords.delete(ticker);
  }
  for (const record of records) {
    const accepted = kalshiOrderbookStream.recordProductionMarkets(
      [record.market],
      record.sourceBaseUrl,
      record.verifiedAt,
    );
    if (accepted.length === 1) productionMarketRecords.set(record.market.ticker, {
      market: { ...record.market },
      sourceBaseUrl: record.sourceBaseUrl,
      verifiedAt: record.verifiedAt,
    });
    else productionMarketRecords.delete(record.market.ticker);
  }
  while (productionMarketRecords.size > 1_000) {
    const oldest = [...productionMarketRecords.entries()]
      .sort((left, right) => left[1].verifiedAt - right[1].verifiedAt)[0]?.[0];
    if (!oldest) break;
    productionMarketRecords.delete(oldest);
  }
}

/** Only production, currently live markets can enter the authenticated book set. */
function isProductionLiveTicker(ticker: string | undefined, market?: KalshiMarket): boolean {
  if (!ticker || /^DEMO(?:[-_]|$)/i.test(ticker)) return false;
  const verified = productionMarketRecord(ticker);
  if (!market || !verified || verified.market.ticker !== market.ticker) return false;
  const status = verified.market.status.toLowerCase();
  return status === 'active' || status === 'open';
}

function desiredOrderbookTickers(now = Date.now()): string[] {
  const marketByTicker = new Map<string, KalshiMarket>();
  for (const [ticker, record] of productionMarketRecords) {
    if (productionMarketRecord(ticker, now)) marketByTicker.set(ticker, record.market);
  }
  const ordered = campaignCriticalOrderbookTickers(now)
    .filter((ticker) => isProductionLiveTicker(ticker, marketByTicker.get(ticker)));
  const seen = new Set(ordered);
  const add = (ticker: string | undefined) => {
    if (!ticker || !isProductionLiveTicker(ticker, marketByTicker.get(ticker))) return;
    if (seen.has(ticker)) return;
    seen.add(ticker);
    ordered.push(ticker);
  };
  const ranked = [...theses].sort((left, right) => {
    const edge = finiteCampaignNumber(right.netEdge, 0) - finiteCampaignNumber(left.netEdge, 0);
    if (edge !== 0) return edge;
    return finiteCampaignNumber(left.freshnessMs, Number.MAX_SAFE_INTEGER)
      - finiteCampaignNumber(right.freshnessMs, Number.MAX_SAFE_INTEGER);
  });
  for (const card of ranked) {
    if (isEntryEligible(card) && hasRealExecutableDepth(card)) add(card.ticker);
  }
  // Eligible signal markets are the second priority after campaign-critical
  // tickers, regardless of whether discovery has already verified depth.
  for (const market of discovery.getMarketsForSignals()) add(market.ticker);
  // Fill from the live universe before using the cached live set. Discovery
  // can expose a fixture fallback, so the production/live filter above is
  // applied to every source rather than trusting source order.
  if (discovery.hasLiveUniverse()) {
    for (const market of discovery.getUniverse()) add(market.ticker);
  }
  for (const market of marketsCache) add(market.ticker);
  // Bridge recommendations may not yet be in marketsCache; only admit them
  // when they are already represented by a live market identity.
  for (const card of ranked) if (marketByTicker.has(card.ticker)) add(card.ticker);
  return ordered;
}

function refreshTickerTracking(now = Date.now()): void {
  const ordered = desiredOrderbookTickers(now);
  const seen = new Set(ordered);
  for (const [ticker] of productionMarketRecords) {
    if (seen.has(ticker) || !productionMarketRecord(ticker, now)) continue;
    seen.add(ticker);
    ordered.push(ticker);
    if (ordered.length >= 500) break;
  }
  kalshiStream.replaceTracked(ordered.slice(0, 500));
}

function refreshOrderbookTracking(now = Date.now()): void {
  const desired = desiredOrderbookTickers(now);
  const desiredSet = new Set(desired);
  const critical = campaignCriticalOrderbookTickers(now).filter((ticker) => desiredSet.has(ticker));
  const selection = selectBoundedOrderbookTracking({
    critical,
    desired,
    // Never carry a ticker forward unless the latest production/live universe
    // still validates it. A partial refresh must fail readiness, not preserve
    // a closed or stale market in the 25-slot set.
    current: orderbookTrackedTickers.filter((ticker) => desiredSet.has(ticker)),
    now,
    lastRotationAt: orderbookLastRotationAt,
    cursor: orderbookRotationCursor,
    limit: ORDERBOOK_TRACKING_LIMIT,
    rotationIntervalMs: ORDERBOOK_ROTATION_INTERVAL_MS,
    rotationBatchSize: ORDERBOOK_ROTATION_BATCH_SIZE,
  });
  orderbookTrackedTickers = selection.tickers;
  orderbookLastRotationAt = selection.lastRotationAt;
  orderbookRotationCursor = selection.cursor;
  kalshiOrderbookStream.replaceTracked(selection.tickers);
  refreshTickerTracking(now);
}

async function applyBridgeRecommendation(packet: RecommendationPacket) {
  let market = productionMarketRecord(packet.ticker)?.market;
  if (!market) {
    let responseMetadata: { environment: 'production' | 'demo'; sourceBaseUrl: string; verifiedAt: number; status: number } | null = null;
    try {
      const hydrated = await fetchMarket(packet.ticker, {
        environment: 'production',
        onResponseMetadata: (metadata) => { responseMetadata = metadata; },
      });
      const verifiedResponse = responseMetadata as KalshiResponseMetadata | null;
      if (!verifiedResponse || verifiedResponse.environment !== 'production' || verifiedResponse.status !== 200) {
        throw new Error('production REST provenance was not returned');
      }
      const record: ProductionUniverseRecord = {
        market: hydrated,
        sourceBaseUrl: verifiedResponse.sourceBaseUrl,
        verifiedAt: verifiedResponse.verifiedAt,
      };
      recordProductionUniverse([record]);
      market = productionMarketRecord(packet.ticker)?.market;
    } catch (error) {
      auditLog.append({
        action: 'gate_block',
        ticker: packet.ticker,
        detail: `GEA recommendation rejected: production REST hydration failed (${error instanceof Error ? error.message : String(error)})`,
        ok: false,
      });
      saveAuditLog();
      return;
    }
  }
  if (!market) return;
  geaMarkets = upsertRecommendationMarket(geaMarkets, packet, market);
  marketsCache = mergeGeaMarkets(marketsCache);
  geaTheses = upsertRecommendationThesis(geaTheses, packet, market).map(applyDepthToCard);
  theses = replaceGeaTheses(theses);
  opportunityQueue.discover(geaTheses.filter((c) => isEntryEligible(c)
    && hasRealExecutableDepth(c)));
  refreshOrderbookTracking();
  // GEA can deliver bursts of recommendations. Coalesce the expensive
  // market/world snapshot work so the renderer receives one bounded update
  // per throttle window rather than one full-state broadcast per packet.
  scheduleMarketStatePublish();
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
  async (signal) => {
    const markets = await discovery.refreshUniverse(signal);
    recordProductionUniverse(discovery.getProductionUniverseRecords());
    refreshOrderbookTracking();
    return markets;
  },
  UNIVERSE_FETCH_TIMEOUT_MS,
  'universe fetch timed out',
));
const runRestHealthProbe = createSingleFlight(() => registry.pingKalshiRest());

async function reverifyTrackedProductionMarkets(): Promise<void> {
  if (settings.demoMode || orderbookTrackedTickers.length === 0) return;
  const tickers = [...new Set([
    ...campaignCriticalOrderbookTickers(),
    ...orderbookTrackedTickers,
  ])].slice(0, ORDERBOOK_TRACKING_LIMIT);
  const concurrency = 5;
  for (let index = 0; index < tickers.length; index += concurrency) {
    await Promise.all(tickers.slice(index, index + concurrency).map(async (ticker) => {
      let responseMetadata: { environment: 'production' | 'demo'; sourceBaseUrl: string; verifiedAt: number; status: number } | null = null;
      try {
        const market = await fetchMarket(ticker, {
          environment: 'production',
          onResponseMetadata: (metadata) => { responseMetadata = metadata; },
        });
        const verifiedResponse = responseMetadata as KalshiResponseMetadata | null;
        if (verifiedResponse?.environment !== 'production' || verifiedResponse.status !== 200) return;
        recordProductionUniverse([{
          market,
          sourceBaseUrl: verifiedResponse.sourceBaseUrl,
          verifiedAt: verifiedResponse.verifiedAt,
        }]);
      } catch {
        // Existing proof expires naturally. A failed refresh never extends it.
      }
    }));
  }
  refreshOrderbookTracking();
}

const runProductionMarketReverification = createSingleFlight(reverifyTrackedProductionMarkets);

function recordKalshiRestFailure(error: unknown): void {
  registry.recordError(
    'kalshi-rest',
    error instanceof Error ? error.message : String(error),
    error instanceof KalshiRequestFailure ? error.classification : undefined,
    error instanceof KalshiRequestFailure ? error.retryAfterMs : undefined,
  );
}

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
    recordKalshiRestFailure(e);
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
  refreshOrderbookTracking();

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
  if (PRODUCTION_OBSERVATION_MODE) return settings;
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
    const sentAt = Date.now();
    bridgeStatus.lastOutboundAt = sentAt;
    bridgeStatus.lastSequenceOut = full.seq;
    if (full.type === 'bridge:ping') {
      bridgeStatus.lastPingAt = sentAt;
      bridgeStatus.pingCount = (bridgeStatus.pingCount ?? 0) + 1;
    }
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
    bridgeStatus.lastSequenceIn = null;
    bridgeStatus.lastPingAt = null;
    bridgeStatus.lastPongAt = null;
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
        const previousSequence = bridgeStatus.lastSequenceIn;
        if (previousSequence != null && valid.seq !== previousSequence + 1) {
          bridgeStatus.sequenceGaps = (bridgeStatus.sequenceGaps ?? 0) + 1;
          bridgeStatus.qualificationReady = false;
          persistBridgeTelemetry('sequence_gap', { expected: previousSequence + 1, received: valid.seq });
          ws.close(1008, 'bridge sequence gap');
          return;
        }
        bridgeStatus.lastSeenAt = receivedAt;
        bridgeStatus.lastInboundAt = receivedAt;
        bridgeStatus.lastSequenceIn = valid.seq;
        if (valid.type === 'bridge:hello') {
          bridgeStatus.peerRole = (valid.payload as { role?: 'nemesis' | 'gea' }).role ?? null;
        }
        if (valid.type === 'bridge:pong') {
          bridgeStatus.lastPongAt = receivedAt;
          bridgeStatus.pongCount = (bridgeStatus.pongCount ?? 0) + 1;
          bridgeStatus.roundTripMs = bridgeStatus.lastPingAt == null ? null : Math.max(0, receivedAt - bridgeStatus.lastPingAt);
          const telemetry = valid.payload as Partial<BridgeProcessTelemetry>;
          if (Number.isInteger(telemetry.pid) && telemetry.pid! > 0
            && Number.isFinite(telemetry.workingSetMb) && telemetry.workingSetMb! >= 0
            && Number.isFinite(telemetry.sampledAt) && telemetry.sampledAt! > 0
            && telemetry.sampledAt! <= receivedAt + 5_000) {
            bridgeStatus.geaPid = telemetry.pid!;
            bridgeStatus.geaWorkingSetMb = telemetry.workingSetMb!;
            bridgeStatus.geaProcessSampledAt = telemetry.sampledAt!;
          }
        }
        refreshBridgeConnectivity(receivedAt);
        persistBridgeTelemetry('inbound', { messageType: valid.type });
        if (valid.type === 'brain:recommendation') {
          const nextRole = (valid.payload as { brain_role: BridgeStatus['brainRole'] }).brain_role;
          if (bridgeStatus.brainRole && nextRole && bridgeStatus.brainRole !== nextRole) bridgeStatus.failovers += 1;
          bridgeStatus.brainRole = nextRole;
          broadcastBridgeStatus();
          void applyBridgeRecommendation(valid.payload as RecommendationPacket);
          broadcast('bridge:recommendation', valid.payload);
        } else if (valid.type === 'brain:exit') {
          applyBridgeExitRecommendation(valid.payload as ExitRecommendation);
          broadcast('bridge:recommendation', valid.payload);
        } else if (valid.type === 'brain:no-trade') {
          broadcast('bridge:recommendation', valid.payload);
        } else if (valid.type === 'bridge:ping') {
          const pong: NemesisBridgeMessage = {
            type: 'bridge:pong',
            payload: {
              pid: process.pid,
              workingSetMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(3)),
              sampledAt: Date.now(),
            },
            seq: ++bridgeSeq,
          };
          ws.send(JSON.stringify(pong));
          bridgeStatus.lastOutboundAt = Date.now();
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
  startupTrace(`gea-spawn:${plan.command}`);
  geaProcess = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: childEnv,
    windowsHide: plan.windowsHide,
  });
  geaExitedDuringEvidence = false;
  startupTrace(`gea-spawned-pid:${geaProcess.pid}`);
  geaProcess.stderr?.on('data', (d: Buffer) => {
    const sanitized = d.toString()
      .replace(/token=[^&\s]+/gi, 'token=[redacted]')
      .replace(/NEMESIS_BRIDGE_TOKEN\s*[:=]\s*[^\s]+/gi, 'NEMESIS_BRIDGE_TOKEN=[redacted]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    if (sanitized) {
      process.stderr.write(`[gea] ${sanitized}\n`);
      startupTrace(`gea-stderr:${sanitized}`);
    }
  });
  geaProcess.once('error', (err) => {
    const detail = err instanceof Error ? err.message : String(err);
    startupTrace(`gea-error:${detail.replace(/\s+/g, ' ').slice(0, 300)}`);
    console.warn(`[gea] spawn failed: ${err.message}`);
    geaProcess = null;
    if (pendingCampaignPointer) geaExitedDuringEvidence = true;
    if (!pendingCampaignPointer) setTimeout(spawnGlobalEventAlpha, 3_000);
  });
  geaProcess.once('exit', (code, signal) => {
    console.log(`[gea] exited (code=${code ?? 'null'})`);
    startupTrace(`gea-exit:${code ?? 'null'}:signal=${signal ?? 'none'}`);
    geaProcess = null;
    if (pendingCampaignPointer && !closeoutPrepared) geaExitedDuringEvidence = true;
    if (code !== 0 && !pendingCampaignPointer) setTimeout(spawnGlobalEventAlpha, 3_000);
  });
  geaProcess.once('close', (code, signal) => {
    startupTrace(`gea-close:${code ?? 'null'}:signal=${signal ?? 'none'}`);
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
  ipcMain.on('renderer:heartbeat', (event, payload: { painted?: boolean; at?: number; sequence?: number } | undefined) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    const before = rendererHeartbeatMonitor.snapshot();
    rendererHeartbeatMonitor.recordHeartbeat({
      receivedAt: Date.now(),
      reportedAt: payload?.at,
      painted: payload?.painted,
      sequence: payload?.sequence,
    });
    const after = rendererHeartbeatMonitor.snapshot();
    if (before.firstHeartbeatAt == null && after.firstHeartbeatAt != null) startupTrace('renderer-first-heartbeat');
    if (before.firstPaintedAt == null && after.firstPaintedAt != null) {
      startupTrace('renderer-first-painted-heartbeat');
      if (rendererProbePendingAfterPaint) startRendererProbe();
    }
  });
  ipcMain.on('renderer:heartbeat-send-failed', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    rendererHeartbeatMonitor.recordHeartbeatSendFailure();
  });
  ipcMain.on('renderer:probe-response', (
    event,
    payload: { sentAt?: number; receivedAt?: number; sequence?: number } | undefined,
  ) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    rendererHeartbeatMonitor.recordProbeResponse({
      sentAt: payload?.sentAt,
      receivedAt: Date.now(),
      sequence: payload?.sequence,
    });
    startupTrace(`renderer-probe-response:${payload?.sequence ?? 'unknown'}`);
  });
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: `${mutationLock}; configuration is frozen` };
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: `${mutationLock}; credentials are frozen` };
    const result = persistKalshiCredentials(input ?? {});
    if (result.ok && (settings.liveStage ?? 'paper') !== 'paper') {
      invalidateLiveCertificate('credential change');
      saveSettings();
    }
    broadcast('settings:update', settings);
    if (result.ok) {
      kalshiStream.restart();
      kalshiOrderbookStream.restart();
    }
    return result;
  });

  ipcMain.handle('nemesis:clearKalshiCredentials', () => {
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: `${mutationLock}; credentials are frozen`, status: kalshiCredentialStatus() };
    if ((settings.liveStage ?? 'paper') !== 'paper') {
      invalidateLiveCertificate('credential change');
    }
    const status = clearStoredKalshiCredentials();
    broadcast('settings:update', settings);
    kalshiStream.restart();
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: `${mutationLock}; configuration is frozen` };
    settings = { ...settings, humanQuizPassed: true };
    saveSettings();
    saveAuditLog();
    broadcast('settings:update', settings);
    return true;
  });

  ipcMain.handle('nemesis:passBacktest', () => {
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { passed: false, error: `${mutationLock}; configuration is frozen` };
    const result = runFeeAwareBacktest(journal.list());
    settings = { ...settings, backtestPassed: result.passed };
    saveSettings();
    auditLog.append({ action: 'backtest', detail: result.detail, ok: result.passed });
    saveAuditLog();
    broadcast('settings:update', settings);
    return result;
  });

  ipcMain.handle('nemesis:quarantinePlaybook', (_e, playbook: string) => {
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: `${mutationLock}; strategy state is frozen` };
    quarantine.evaluate({ playbook: playbook as never, signals: 25, wins: 5, losses: 20, staleRate: 0.1, disagreementRate: 0.1, fillDrag: 0.05 });
    return quarantine.listFrozen();
  });

  ipcMain.handle('nemesis:killSwitch', () => activateKillSwitch('ipc'));

  ipcMain.handle('nemesis:unlockLive', (_e, confirmText: string) => {
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: mutationLock };
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: mutationLock };
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: mutationLock, abortCode: 'campaign_mutation_lock', wouldMutate: false };
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: mutationLock };
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: mutationLock };
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: mutationLock };
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: mutationLock };
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
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: `${mutationLock}; discovery configuration is frozen`, state: discovery.getState() };
    discovery.updateSettings(partial);
    qualificationSnapshot();
    saveDiscoverySettings();
    broadcastDiscovery();
    return { ok: true, state: discovery.getState() };
  });

  ipcMain.handle('nemesis:pauseDiscovery', () => {
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: `${mutationLock}; discovery state is frozen`, state: discovery.getState() };
    discovery.pause();
    broadcastDiscovery();
    return discovery.getState();
  });

  ipcMain.handle('nemesis:resumeDiscovery', () => {
    const mutationLock = campaignMutationLockReason();
    if (mutationLock) return { ok: false, error: `${mutationLock}; discovery state is frozen`, state: discovery.getState() };
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

function createWindow(rendererRetryOrdinal = 0) {
  startupTrace('window-before-create');
  rendererLoadReadyPromise = new Promise<void>((resolve) => {
    resolveRendererLoadReady = resolve;
  });
  rendererHeartbeatMonitor.reset(Date.now());
  stopRendererProbe();
  rendererProbePendingAfterPaint = true;
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
      backgroundThrottling: false,
    },
  });
  startupTrace('window-after-create');

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const packagedIndexPath = path.join(__dirname, '../dist/index.html');
  let packagedLoadRetryCount = rendererRetryOrdinal;
  let packagedLoadRetryInFlight = false;
  const handlePackagedLoadFailure = (detail: string) => {
    if (packagedLoadRetryInFlight) return;
    if (packagedLoadRetryCount < 1 && mainWindow && !mainWindow.isDestroyed()) {
      packagedLoadRetryCount += 1;
      packagedLoadRetryInFlight = true;
      // Set this before scheduling the replacement. Electron can emit
      // window-all-closed/before-quit while the failed WebContents is being
      // torn down; the retry must own that interval.
      rendererRetryInProgress = true;
      rendererHeartbeatMonitor.reset(Date.now());
      startupTrace(`renderer-load-retry:${packagedLoadRetryCount}`);
      setTimeout(() => {
        packagedLoadRetryInFlight = false;
        // ERR_FAILED can leave the original WebContents unusable. Recreate
        // the window once so the retry gets a fresh renderer process.
        const failedWindow = mainWindow;
        if (failedWindow && !failedWindow.isDestroyed()) failedWindow.destroy();
        createWindow(packagedLoadRetryCount);
      }, 250);
      return;
    }
    rendererHeartbeatMonitor.markLoadFailed(detail);
    resolveRendererLoadReady?.();
    resolveRendererLoadReady = null;
  };
  const loadPackagedPage = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    startupTrace(`window-load-file:${packagedIndexPath}`);
    mainWindow.loadFile(packagedIndexPath)
      .then(() => startupTrace(packagedLoadRetryCount > 0 ? 'window-load-file-retry-ok' : 'window-load-file-ok'))
      .catch((err) => {
        const detail = `renderer loadFile failed: ${err instanceof Error ? err.message : String(err)}`;
        startupTrace(`window-load-file-failed:${detail}`);
        if (!devUrl) handlePackagedLoadFailure(detail);
        else console.error('[nemesis] loadFile failed', err);
      });
  };
  const forceInitialPaint = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.invalidate();
    if (!mainWindow.isVisible()) mainWindow.show();
  };
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[nemesis] did-fail-load', code, desc, url);
    startupTrace(`renderer-did-fail-load:${code}:${desc}`);
    // A packaged file load can fail transiently while Electron is starting.
    // Retry once before declaring the renderer unavailable. The retry is
    // still inside startup; a renderer process restart later remains fatal.
    if (!devUrl) {
      handlePackagedLoadFailure(`renderer did-fail-load:${code}:${desc}`);
      return;
    }
    rendererHeartbeatMonitor.markLoadFailed(`renderer did-fail-load:${code}:${desc}`);
    if (devUrl && mainWindow) {
      setTimeout(() => {
        mainWindow?.loadURL(devUrl).catch((err) => console.error('[nemesis] reload failed', err));
      }, 1500);
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    startupTrace('renderer-did-finish-load');
    rendererRetryInProgress = false;
    rendererHeartbeatMonitor.markLoadFinished(Date.now());
    resolveRendererLoadReady?.();
    resolveRendererLoadReady = null;
    // Wait for the first painted heartbeat before probing. A page can report
    // did-finish-load while its initial React paint is still busy; probing
    // before paint measures startup work rather than renderer liveness.
    if (rendererHeartbeatMonitor.snapshot().firstPaintedAt != null) startRendererProbe();
    forceInitialPaint();
    setTimeout(forceInitialPaint, 250);
    setTimeout(forceInitialPaint, 1_000);
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[nemesis] preload-error', preloadPath, error);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[nemesis] render-process-gone', details.reason, details.exitCode);
    startupTrace(`renderer-process-gone:${details.reason}:${details.exitCode}`);
    rendererHeartbeatMonitor.markRendererGone();
  });
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      console.error('[nemesis] renderer-console', {
        level: event.level,
        message: event.message,
        line: event.lineNumber,
        sourceId: event.sourceId,
      });
    }
  });
  mainWindow.on('unresponsive', () => {
    rendererHeartbeatMonitor.markUnresponsive();
    startupTrace('renderer-unresponsive');
    console.error('[nemesis] main window became unresponsive');
  });
  mainWindow.on('responsive', () => {
    rendererHeartbeatMonitor.markResponsive();
    startupTrace('renderer-responsive');
    console.warn('[nemesis] main window became responsive again');
  });
  mainWindow.on('closed', () => {
    startupTrace('window-closed');
    stopRendererProbe();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    forceInitialPaint();
  });

  if (devUrl) {
    mainWindow.loadURL(devUrl).catch((err) => console.error('[nemesis] loadURL failed', err));
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    loadPackagedPage();
  }
  startupTrace('window-create-return');
}

app.whenReady().then(async () => {
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
  // Establish the immutable observation baseline only after every protected
  // paper/config store has completed its one-time startup recovery.
  captureProductionObservationBaseline();
  startupTrace('production-observation-baseline');
  initializeEvidenceCampaign();
  startupTrace('evidence-campaign');
  kalshiStream.onQuote((q) => applyKalshiQuote(q.ticker, q.yesPrice, q.spread));
  kalshiOrderbookStream.onBookUpdate((book) => {
    discovery.ingestOrderbook(book);
    const observedAt = Date.now();
    if (!campaignStore || campaignEvidencePaused) return;
    if (!Number.isInteger(book.sequence)) {
      const completedAt = Date.now();
      const work = campaignBookUpdateWork(book.ticker, [], campaignSnapshot(), completedAt);
      if (work.diagnostic) {
        pendingCampaignDiagnosticObservations.set(book.ticker, {
          ticker: book.ticker,
          sequence: -1,
          observedAt,
          completedAt,
          book,
          feeResult: {
            status: 'failed',
            outcome: 'missing_provenance',
            detail: 'order-book delta is missing an exchange sequence',
          },
        });
        campaignBookTriggerScheduler.request(book.ticker, { throughput: false, confirmation: false, diagnostic: true }, completedAt);
      }
      return;
    }
    const sequence = book.sequence!;
    const latestSequence = latestCampaignObservationSequence.get(book.ticker);
    if (latestSequence != null && sequence <= latestSequence) return;
    // Claim the sequence before resolving fees so an older async completion can never overwrite it.
    latestCampaignObservationSequence.set(book.ticker, sequence);
    void kalshiFeePolicyResolver.resolve(book.ticker).then((feePolicy) => {
      const completedAt = Date.now();
      if (latestCampaignObservationSequence.get(book.ticker) !== sequence) return;
      const enriched = sanitizeExecutableBook({ ...book, feePolicy });
      const readiness = campaignEnrollmentReadiness(
        enriched,
        completedAt,
        entryQualificationSettings().maxBookAgeMs,
      );
      const campaign = campaignSnapshot();
      const work = campaignBookUpdateWork(book.ticker, theses.filter((card) =>
        card.ticker === book.ticker
        && isEntryEligible(card)
        && hasRealExecutableDepth(card)), campaign, completedAt);
      if (!readiness.ready) {
        if (work.diagnostic) {
          const outcome: 'missing_provenance' | 'stale_book' | 'fee_unknown' = /fee/i.test(readiness.reason)
            ? 'fee_unknown'
            : /stale|age/i.test(readiness.reason)
              ? 'stale_book'
              : 'missing_provenance';
          pendingCampaignDiagnosticObservations.set(book.ticker, {
            ticker: book.ticker,
            sequence,
            observedAt,
            completedAt,
            book: enriched,
            feeResult: { status: 'failed', outcome, detail: readiness.reason },
          });
          campaignBookTriggerScheduler.request(book.ticker, { throughput: false, confirmation: false, diagnostic: true }, completedAt);
        }
        return;
      }
      if (work.diagnostic) {
        pendingCampaignDiagnosticObservations.set(book.ticker, {
          ticker: book.ticker,
          sequence,
          observedAt,
          completedAt,
          book: enriched,
          feeResult: { status: 'resolved', policy: feePolicy },
        });
      }
      campaignBookTriggerScheduler.request(book.ticker, work, completedAt);
    }).catch((error) => {
      const completedAt = Date.now();
      if (latestCampaignObservationSequence.get(book.ticker) !== sequence) return;
      const work = campaignBookUpdateWork(book.ticker, [], campaignSnapshot(), completedAt);
      if (work.diagnostic) {
        pendingCampaignDiagnosticObservations.set(book.ticker, {
          ticker: book.ticker,
          sequence,
          observedAt,
          completedAt,
          book,
          feeResult: {
            status: 'failed',
            outcome: 'fee_unknown',
            detail: `fee policy resolution failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
        campaignBookTriggerScheduler.request(book.ticker, { throughput: false, confirmation: false, diagnostic: true }, completedAt);
      }
    });
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
    broadcastToGea({ type: 'bridge:ping', payload: {} });
    recordCampaignOperationalTelemetry();
    broadcast('connectors:update', registry.getAll());
    if (paperDesk.snapshot().positions.length === 0) broadcastPaperUpdate();
  }, BRIDGE_HEARTBEAT_MS);
  setInterval(() => {
    if (paperDesk.snapshot().positions.length > 0) broadcastPaperUpdate();
  }, PAPER_BROADCAST_THROTTLE_MS);

  createWindow();
  startupTrace('window-created');
  // Give the packaged renderer its first turn before starting the feeds and
  // paginated discovery. Those operations can process thousands of markets
  // synchronously when responses arrive and otherwise delay page load enough
  // to create a false startup-liveness failure.
  await rendererLoadReadyPromise;
  startupTrace('renderer-load-gate-open');
  rendererProbeGateInProgress = true;
  try {
    if (!await waitForFreshRendererProbe()) {
      rendererHeartbeatMonitor.markLoadFailed('renderer did not answer a fresh startup probe');
      startupTrace('renderer-probe-gate-failed');
      return;
    }
  } finally {
    rendererProbeGateInProgress = false;
  }
  startupTrace('renderer-probe-gate-open');
  spawnGlobalEventAlpha();
  startupTrace('gea-spawned-feed-held');
  kalshiStream.start();
  kalshiOrderbookStream.start();
  startupTrace('kalshi-stream');
  feedHub.startBackgroundPolling(8_000);
  void feedHub.refreshForMarkets(FIXTURE_MARKETS);
  setInterval(() => { void runRestHealthProbe().catch(() => undefined); }, REST_HEALTH_POLL_MS);
  startupTrace('feedhub-started');

  marketsCache = mergeGeaMarkets(FIXTURE_MARKETS);
  discovery.seedFixtureDepth(FIXTURE_MARKETS);
  void buildThesesFromMarkets(marketsCache)
    .then(() => {
      publishMarketState({ offline: true });
      broadcastToGea({ type: 'nemesis:state', payload: buildNemesisStateMirror() });
      void evaluateAutoClosePositions('startup-fixtures');
    })
    .catch((err) => recordKalshiRestFailure(err));

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
        recordKalshiRestFailure(startupErr);
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
      setInterval(() => { void runUniverseRefresh(); }, UNIVERSE_REFRESH_MS);
      setInterval(() => { void runProductionMarketReverification(); }, 20_000);
    }
  })();
  setInterval(() => { void refreshWatchedTicker(); }, WATCHED_TICK_MS);
  setTimeout(() => sampleRendererMemory(), 1_000);
  setInterval(() => sampleRendererMemory(), RENDERER_MEMORY_SAMPLE_INTERVAL_MS);
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
  startupTrace('app-will-quit');
  globalShortcut.unregisterAll();
  stopRendererProbe();
  campaignBookTriggerScheduler.stop();
  marketStateStream.stop();
  equityHistoryStream.stop();
  kalshiStream.stop();
  kalshiOrderbookStream.stop();
  if (geaProcess && !geaProcess.killed) geaProcess.kill();
});
app.on('before-quit', (event) => {
  if (rendererRetryInProgress) {
    event.preventDefault();
    startupTrace('app-before-quit-suppressed-during-renderer-retry');
    return;
  }
  startupTrace('app-before-quit');
});
app.on('window-all-closed', () => {
  startupTrace('app-window-all-closed');
  if (rendererRetryInProgress) {
    startupTrace('app-window-all-closed-suppressed-during-renderer-retry');
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});
