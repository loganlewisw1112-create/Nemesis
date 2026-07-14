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

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import WebSocket, { type RawData } from 'ws';
import type { BrainRole, ExitRecommendation, NemesisBridgeMessage, BridgeStatus, NoTradeWarning, NemesisCloseResult, NemesisStateMirror } from '@nemesis/bridge-contracts';
import { fetchMarkets, fetchOrderbook, type KalshiMarket, type KalshiTrade } from '@nemesis/core';
import {
  ConnectorRegistry,
  FeedHub,
  PublicDataMesh,
  fetchEiaEnergySnapshot,
  fetchSecEdgarRss,
  hasExecutableOrderbook,
  selectExecutableMarkets,
  selectKalshiTapeTickers,
  KalshiStream,
  KalshiTapeEngine,
  publicDataSource,
  type KalshiTapeSink,
  type KalshiTapeState,
  type PublicDataMeshSink,
  type PublicDataMeshState,
} from '@nemesis/connectors';
import {
  AlphaInterceptEngine,
  AlphaScorer,
  EdgeEngine,
  EventGraph,
  HealthSupervisor,
  HoldOptimizer,
  NoTradeIntelligence,
  ProbabilityTribunal,
  ProfitRetentionEngine,
  SettlementIntelligence,
  type AlphaIntercept,
  type BrainInstance,
  type EdgeEstimateResult,
  type EventGraphResult,
  type HoldEstimateResult,
  type NoTradeDecision,
  type ProbabilityTribunalResult,
  type ProfitRetentionResult,
  type SettlementRule,
} from '../../../packages/brain-core/src/index.js';
import {
  AnalyticsExporter,
  ModelTournament,
  TicketAutopsy,
  type ModelTournamentResult,
  type ReplayEvent,
  type TicketAutopsyResult,
} from '../../../packages/simulation-core/src/index.js';
import { createGeaLocalStore, migrateGeaDatabase, type GeaDatabaseStatus, type GeaLocalStore } from './localDb.js';
import { createEntryRecommendationPacket } from './bridgePublisher.js';
import { resolveNemesisBridgeUrl } from './bridgeClient.js';
import { resolveGeaUserDataPath } from './userDataPath.js';
import { copyLegacyGeaDatabaseIfMissing, legacyGeaDatabasePath, resolveGeaDatabasePath } from './localDb.js';
import { TapeStartupCoordinator } from './tapeStartup.js';
import { buildExitExecutionContext } from './exitExecutionContext.js';

if (process.env.GEA_E2E_USER_DATA) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}
app.setPath('userData', resolveGeaUserDataPath(process.env, app.getPath('appData')));

const BRIDGE_URL = resolveNemesisBridgeUrl(process.env);
const BRIDGE_VERSION = '0.1.0';
const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const EXIT_PACKET_TTL_MS = 500;

let mainWindow: BrowserWindow | null = null;
let bridgeWs: WebSocket | null = null;
let bridgeSeq = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_INITIAL_MS;

const bridgeStatus: BridgeStatus = {
  connected: false,
  brainRole: null,
  lastSeenAt: null,
  clientCount: 0,
};

export interface GlobalEventAlphaIntelligenceState {
  settlement: SettlementRule;
  eventGraph: EventGraphResult;
  tribunal: ProbabilityTribunalResult;
  edge: EdgeEstimateResult;
  hold: HoldEstimateResult;
  retention: ProfitRetentionResult;
  noTrade: NoTradeDecision;
  intercepts: AlphaIntercept[];
  autopsy: TicketAutopsyResult;
  tournament: ModelTournamentResult;
  analyticsExport: {
    json: string;
    csv: string;
  };
}

const BRAIN_ROLES: BrainRole[] = ['primary', 'standby-a', 'standby-b', 'standby-c', 'shadow', 'replay', 'emergency'];
const brainWorkers = new Map<BrainRole, Worker>();
const brainSupervisor = new HealthSupervisor(createBrainInstances(Date.now()));
let dbStatus: GeaDatabaseStatus = { available: false, path: '', migrationsApplied: 0 };
let brainHealthTimer: ReturnType<typeof setInterval> | null = null;
const connectorRegistry = new ConnectorRegistry();
let localStore: GeaLocalStore | null = null;
let tapeEngine: KalshiTapeEngine | null = null;
let tapeRefreshTimer: ReturnType<typeof setInterval> | null = null;
let tapeRefreshInFlight: Promise<void> | null = null;
let tapeStreamStarted = false;
let tapeState: KalshiTapeState = emptyTapeState();
const feedHub = new FeedHub(connectorRegistry);
let publicDataMesh: PublicDataMesh | null = null;
let publicDataRefreshTimer: ReturnType<typeof setInterval> | null = null;
let publicDataState: PublicDataMeshState = emptyPublicDataState();
let intelligenceState: GlobalEventAlphaIntelligenceState = createIntelligenceState();
let lastEntrySignature = '';
let lastNoTradeSignature = '';
const lastExitSignatures = new Map<string, string>();
let latestNemesisState: NemesisStateMirror | null = null;
const tapeStartup = new TapeStartupCoordinator({
  coordinated: process.env.GEA_COORDINATE_TAPE_WITH_NEMESIS === 'true',
  fallbackMs: 30_000,
  startTape: () => startKalshiTape(),
});

function createBrainInstances(now: number): BrainInstance[] {
  return BRAIN_ROLES.map((role) => ({
    id: `brain-${role}`,
    role,
    status: role === 'primary' ? 'HEALTHY' : 'STANDBY_READY',
    model_version: 'alpha-v1',
    started_at: now,
    last_heartbeat: now,
    missed_heartbeats: 0,
    packet_rate: 0,
    error_rate: 0,
    latency_ms: 0,
  }));
}

function emptyTapeState(): KalshiTapeState {
  return {
    snapshotCount: 0,
    tradeCount: 0,
    orderbookCount: 0,
    trackedTickers: [],
    latestSnapshots: [],
    latestTrades: [],
    latestOrderbooks: [],
    freshness: { kalshiTapeAgeMs: null, stale: true },
  };
}

function emptyPublicDataState(): PublicDataMeshState {
  return {
    sources: [],
    observations: [],
    releases: [],
    freshness: [],
  };
}

function clamp(value: number, min = 0.01, max = 0.99): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function latestMarketContext() {
  const snapshot = tapeState.latestSnapshots[0];
  const orderbook = tapeState.latestOrderbooks[0];
  const ticker = snapshot?.ticker ?? orderbook?.ticker ?? 'KXDEMO-26';
  const marketPrice = clamp(snapshot?.yes_price ?? snapshot?.yes_ask ?? orderbook?.yes_ask ?? 0.44);
  const spread = Math.max(0.01, snapshot?.spread ?? orderbook?.spread ?? 0.03);
  const title = publicDataState.releases[0]?.title ?? `${ticker} event outcome`;
  const category = publicDataState.sources[0]?.category ?? 'macro';
  const tapeAge = tapeState.freshness.kalshiTapeAgeMs ?? 1_000;
  const dataFreshness = tapeState.freshness.stale ? 0.35 : clamp(1 - tapeAge / 60_000, 0.1, 1);
  const liquidity = clamp((snapshot?.volume ?? 250) / 1_000, 0.2, 1);
  const bookPressure = orderbook?.best_yes_bid != null && orderbook?.yes_ask != null
    ? clamp((orderbook.best_yes_bid - (marketPrice - spread / 2)) / 0.25, -0.08, 0.08)
    : 0.03;
  const tradeFlow = tapeState.latestTrades.length > 0 ? 0.03 : 0.01;

  return { ticker, marketPrice, spread, title, category, tapeAge, dataFreshness, liquidity, bookPressure, tradeFlow };
}

function createIntelligenceState(): GlobalEventAlphaIntelligenceState {
  const now = Date.now();
  const market = latestMarketContext();
  const settlement = SettlementIntelligence.parseRule({
    ticker: market.ticker,
    title: market.title,
    category: market.category,
  });
  const catalysts = publicDataState.releases.slice(0, 3).map((release) => release.title);
  if (catalysts.length === 0) catalysts.push('Kalshi tape update', settlement.source);
  const eventGraph = EventGraph.fromMarket({
    ticker: market.ticker,
    title: market.title,
    category: market.category,
  }, catalysts);
  const tribunal = ProbabilityTribunal.evaluate({
    ticker: market.ticker,
    market_price: market.marketPrice,
    calibrated_probability: clamp(0.52 + settlement.clarity_score * 0.08),
    orderbook_pressure: market.bookPressure,
    trade_flow: market.tradeFlow,
    settlement_clarity: settlement.clarity_score,
    similar_setup_probability: clamp(0.5 + settlement.clarity_score * 0.09),
    data_freshness: market.dataFreshness,
  });
  const edge = EdgeEngine.estimate({
    ticker: market.ticker,
    market_price: market.marketPrice,
    probability: tribunal.nemesis_probability,
    spread: market.spread,
    fee: 0.01,
    slippage: market.spread / 3,
    depth: market.liquidity,
    uncertainty: 1 - tribunal.model_agreement_score,
  });
  const hold = HoldOptimizer.estimate({
    ticker: market.ticker,
    event_time: now + 12 * 60 * 60 * 1000,
    now,
    edge_half_life_ms: 90 * 60 * 1000,
    settlement_clarity: settlement.clarity_score,
    volatility: market.spread * 5,
  });
  const retention = ProfitRetentionEngine.evaluate({
    ticker: market.ticker,
    original_edge: Math.max(0.08, edge.raw_edge),
    current_edge: Math.max(0, edge.net_edge),
    captured_edge: Math.max(0.03, edge.raw_edge - edge.net_edge),
    drawdown_from_peak: 0.06,
    settlement_clarity: settlement.clarity_score,
  });
  const noTrade = NoTradeIntelligence.evaluate({
    ticker: market.ticker,
    net_edge: edge.net_edge,
    spread: market.spread,
    settlement_clarity: settlement.clarity_score,
    data_freshness_ms: market.tapeAge,
    liquidity_score: market.liquidity,
  });
  const intercepts = AlphaInterceptEngine.detect({
    ticker: market.ticker,
    public_data_delta: publicDataState.observations.length > 0 ? 0.08 : 0.02,
    market_move: Math.abs(edge.raw_edge) < 0.02 ? 0.01 : 0.03,
    orderbook_imbalance: tapeState.latestOrderbooks.length > 0 ? 0.18 : 0.06,
    freshness_ms: Math.min(market.tapeAge, publicDataState.freshness[0]?.age_ms ?? market.tapeAge),
  });
  const replayEvents: ReplayEvent[] = [
    { id: `${market.ticker}:snapshot`, timestamp: now - 4_000, type: 'snapshot', payload: { ticker: market.ticker, price: market.marketPrice } },
    { id: `${market.ticker}:public`, timestamp: now - 3_000, type: 'public-data', payload: { source: publicDataState.sources[0]?.id ?? 'local', value: publicDataState.observations[0]?.value ?? 0 } },
    { id: `${market.ticker}:brain`, timestamp: now - 2_000, type: 'brain-output', payload: { ticker: market.ticker, probability: tribunal.nemesis_probability } },
    { id: `${market.ticker}:decision`, timestamp: now - 1_000, type: 'decision', payload: { ticker: market.ticker, action: noTrade.blocked ? 'blocked' : retention.action } },
  ];
  const autopsy = TicketAutopsy.fromEvents(market.ticker, replayEvents);
  const tournament = ModelTournament.run({
    replay_id: 'local-v1',
    models: [
      { model_version: 'alpha-v1', predictions: [tribunal.nemesis_probability, 0.48], actuals: [1, 0], pnl: [12, 4] },
      { model_version: 'alpha-baseline', predictions: [market.marketPrice, 0.52], actuals: [1, 0], pnl: [2, -3] },
    ],
  });

  return {
    settlement,
    eventGraph,
    tribunal,
    edge,
    hold,
    retention,
    noTrade,
    intercepts,
    autopsy,
    tournament,
    analyticsExport: {
      json: AnalyticsExporter.toJson(autopsy),
      csv: AnalyticsExporter.toCsv(tournament.results.map((result) => ({
        model_version: result.model_version,
        rank: result.rank,
        pnl: result.metrics.pnl,
        hit_rate: result.metrics.hit_rate,
        brier_score: result.metrics.brier_score,
      }))),
    },
  };
}

function broadcast(channel: string, data: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function pushBridgeStatus() {
  broadcast('gea:bridgeStatus', { ...bridgeStatus });
}

function pushBrainHealth() {
  const snapshot = brainSupervisor.checkHealth(Date.now());
  broadcast('gea:brainHealth', snapshot);
}

function activePublishingRole(): BrainRole {
  const activeRole = brainSupervisor.snapshot().activeRole;
  return activeRole === 'standalone' ? 'emergency' : activeRole;
}

function publishIntelligencePackets(state: GlobalEventAlphaIntelligenceState) {
  if (!bridgeStatus.connected) return;
  const role = activePublishingRole();
  const issuedAt = Date.now();
  const alpha = AlphaScorer.score({
    raw_edge: Math.max(0, state.edge.raw_edge),
    net_edge: Math.max(0, state.edge.net_edge),
    confidence: state.tribunal.model_agreement_score,
    liquidity: state.noTrade.reasons.includes('LIQUIDITY_TOO_THIN') ? 0.25 : 0.75,
    settlement_clarity: state.settlement.clarity_score,
    freshness: state.noTrade.reasons.includes('DATA_STALE') ? 0.25 : 0.85,
    volatility_penalty: Math.max(0, state.edge.raw_edge - state.edge.net_edge),
  });
  const entry = createEntryRecommendationPacket({
    role,
    id: `${state.edge.ticker}:alpha-v1:entry`,
    modelVersion: 'alpha-v1',
    ticker: state.edge.ticker,
    alphaScore: alpha.alpha_score,
    classification: alpha.classification,
    nemesisProbability: state.tribunal.nemesis_probability,
    confidenceBandLow: state.tribunal.confidence_band_low,
    confidenceBandHigh: state.tribunal.confidence_band_high,
    netEdge: state.edge.net_edge,
    rawEdge: state.edge.raw_edge,
    entryZoneLow: state.edge.entry_zone_low,
    entryZoneHigh: state.edge.entry_zone_high,
    doNotChaseLevel: state.edge.do_not_chase_level,
    targetExit: state.edge.target_exit,
    settlementClarityScore: state.settlement.clarity_score,
    holdClass: state.hold.hold_class,
    noTradeBlocked: state.noTrade.blocked,
    now: issuedAt,
  });
  if (entry) {
    const signature = `${entry.ticker}:${entry.classification}:${entry.alpha_score}:${entry.net_ev.toFixed(4)}:${entry.entry_zone_low.toFixed(4)}:${entry.entry_zone_high.toFixed(4)}`;
    if (signature !== lastEntrySignature) {
      lastEntrySignature = signature;
      sendToNemesis({ type: 'brain:recommendation', payload: entry });
    }
  }

  if (state.noTrade.blocked) {
    const signature = `${state.noTrade.ticker}:${state.noTrade.reasons.join('|')}:${state.noTrade.recheck_at}`;
    if (signature !== lastNoTradeSignature) {
      lastNoTradeSignature = signature;
      const warning: NoTradeWarning = {
        ticker: state.noTrade.ticker,
        block_reason: state.noTrade.reasons.join(', '),
        what_would_need_to_change: state.noTrade.what_would_need_to_change,
        recheck_at: state.noTrade.recheck_at,
        issued_by: role,
        issued_at: issuedAt,
      };
      sendToNemesis({ type: 'brain:no-trade', payload: warning });
    }
  }

  if (state.retention.action !== 'hold') {
    const matchingPositions = latestNemesisState?.paperPositions?.filter(
      (position) => position.ticker === state.retention.ticker && position.contracts > 0,
    ) ?? [];
    for (const position of matchingPositions) {
      const context = buildExitExecutionContext(tapeState, state.retention.ticker, position.side, issuedAt, EXIT_PACKET_TTL_MS);
      if (!context) continue;
      const positionKey = `${state.retention.ticker}:${position.side}`;
      const signature = `${positionKey}:${state.retention.action}:${state.retention.current_edge}:${state.retention.captured_edge}:${context.executable_close_price}:${context.book_timestamp}`;
      if (signature === lastExitSignatures.get(positionKey)) continue;
      lastExitSignatures.set(positionKey, signature);
      const recommendation: ExitRecommendation = {
        ticker: state.retention.ticker,
        side: position.side,
        action: state.retention.action,
        current_edge: state.retention.current_edge,
        captured_edge: state.retention.captured_edge,
        ...context,
        reason: state.retention.reason,
        issued_by: role,
        issued_at: issuedAt,
      };
      sendToNemesis({ type: 'brain:exit', payload: recommendation });
    }
  }
}

function pushIntelligenceState() {
  intelligenceState = createIntelligenceState();
  broadcast('gea:intelligenceUpdate', intelligenceState);
  publishIntelligencePackets(intelligenceState);
}

function pushTapeState(state = tapeEngine?.getState() ?? tapeState) {
  tapeState = state;
  broadcast('gea:tapeUpdate', tapeState);
  pushIntelligenceState();
}

function pushPublicDataState(state = publicDataMesh?.getState() ?? publicDataState) {
  publicDataState = state;
  broadcast('gea:publicDataUpdate', publicDataState);
  pushIntelligenceState();
}

function createTapeSink(): KalshiTapeSink {
  return {
    insertMarketSnapshot: (snapshot) => { localStore?.insertMarketSnapshot(snapshot); },
    insertTradePrint: (trade) => { localStore?.insertTradePrint(trade); },
    insertOrderbookSnapshot: (book) => { localStore?.insertOrderbookSnapshot(book); },
  };
}

function createPublicDataSink(): PublicDataMeshSink {
  return {
    insertPublicDataSource: (source) => { localStore?.insertPublicDataSource(source); },
    insertPublicDataObservation: (observation) => { localStore?.insertPublicDataObservation(observation); },
    insertPublicDataRelease: (release) => { localStore?.insertPublicDataRelease(release); },
  };
}

function configuredTapeTickers(): string[] {
  return (process.env.GEA_TAPE_TICKERS ?? '')
    .split(',')
    .map((ticker) => ticker.trim())
    .filter(Boolean);
}

function startKalshiTape() {
  if (tapeEngine) return;
  const stream = new KalshiStream(connectorRegistry);
  tapeEngine = new KalshiTapeEngine({
    sink: createTapeSink(),
    stream,
    staleAfterMs: Number(process.env.GEA_TAPE_STALE_MS ?? 15_000),
  });
  tapeEngine.onUpdate((state) => pushTapeState(state));

  const tickers = configuredTapeTickers();
  if (tickers.length > 0) startTapeStream(tickers);

  void refreshKalshiTape();
  const refreshMs = Number(process.env.GEA_TAPE_REFRESH_MS ?? 30_000);
  tapeRefreshTimer = setInterval(() => void refreshKalshiTape(), Number.isFinite(refreshMs) ? refreshMs : 30_000);
  pushTapeState();
}

function startTapeStream(tickers: string[]) {
  if (!tapeEngine || process.env.GEA_TAPE_STREAM === 'false') return;
  if (tapeStreamStarted) {
    tapeEngine.track(tickers);
    return;
  }
  tapeEngine.start(tickers);
  tapeStreamStarted = true;
}

function refreshKalshiTape(): Promise<void> {
  if (!tapeEngine || process.env.GEA_TAPE_REST === 'false') return Promise.resolve();
  if (tapeRefreshInFlight) return tapeRefreshInFlight;
  tapeRefreshInFlight = refreshKalshiTapeOnce().finally(() => {
    tapeRefreshInFlight = null;
  });
  return tapeRefreshInFlight;
}

async function refreshKalshiTapeOnce(): Promise<void> {
  const engine = tapeEngine;
  if (!engine) return;
  let trades: KalshiTrade[] = [];
  try {
    trades = await feedHub.refreshTradeTape();
    for (const trade of trades) engine.ingestTrade(trade);
  } catch (err) {
    connectorRegistry.recordWarn('kalshi-trades', err instanceof Error ? err.message : String(err));
  }

  let markets: KalshiMarket[] = [];
  try {
    const limit = Number(process.env.GEA_TAPE_MARKET_LIMIT ?? 25);
    const marketRes = await fetchMarkets({ limit: Number.isFinite(limit) ? limit : 25, status: 'open' });
    markets = marketRes.markets ?? [];
  } catch (err) {
    connectorRegistry.recordWarn('kalshi-rest', err instanceof Error ? err.message : String(err));
  }

  const liquidMarkets = selectExecutableMarkets(markets);
  for (const market of liquidMarkets) engine.ingestMarket(market);
  const selection = selectKalshiTapeTickers(liquidMarkets, trades, {
    trackLimit: Number(process.env.GEA_TAPE_TRACK_LIMIT ?? 12),
    orderbookLimit: Number(process.env.GEA_TAPE_ORDERBOOK_LIMIT ?? 6),
    minTradeNotionalUsd: Number(process.env.GEA_TAPE_MIN_TRADE_NOTIONAL_USD ?? 50),
  });
  if (selection.trackedTickers.length > 0) startTapeStream(selection.trackedTickers);

  for (const ticker of selection.orderbookTickers) {
    try {
      const book = await fetchOrderbook(ticker);
      if (hasExecutableOrderbook(book)) engine.ingestOrderbook(book);
    } catch (err) {
      connectorRegistry.recordWarn('kalshi-rest', err instanceof Error ? err.message : String(err));
    }
  }
  pushTapeState();
}

function startPublicDataMesh() {
  if (publicDataMesh || process.env.GEA_PUBLIC_DATA === 'false') return;
  publicDataMesh = new PublicDataMesh({ sink: createPublicDataSink() });
  publicDataMesh.onUpdate((state) => pushPublicDataState(state));
  for (const source of connectorRegistry.getAll()) {
    publicDataMesh.ingestSource(publicDataSource(source.id, {
      name: source.name,
      category: source.id,
      last_success: source.lastSuccess,
      last_error: source.lastError,
    }));
  }
  void refreshPublicDataMesh();
  const refreshMs = Number(process.env.GEA_PUBLIC_DATA_REFRESH_MS ?? 120_000);
  publicDataRefreshTimer = setInterval(
    () => void refreshPublicDataMesh(),
    Number.isFinite(refreshMs) ? refreshMs : 120_000,
  );
  pushPublicDataState();
}

async function refreshPublicDataMesh() {
  if (!publicDataMesh) return;
  const now = Date.now();
  const markets = tapeState.latestSnapshots.slice(0, 25).map((snapshot) => ({
    ticker: snapshot.ticker,
    title: snapshot.ticker,
    status: 'open',
    yes_bid: snapshot.yes_bid == null ? undefined : Math.round(snapshot.yes_bid * 100),
    yes_ask: snapshot.yes_ask == null ? undefined : Math.round(snapshot.yes_ask * 100),
    volume: snapshot.volume,
  }));

  await feedHub.refreshForMarkets(markets);
  publicDataMesh.ingestFeedHubSnapshot(feedHub, now);

  if (process.env.GEA_PUBLIC_DATA_EIA !== 'false') {
    const observations = await fetchEiaEnergySnapshot(connectorRegistry, {
      apiKey: process.env.NEMESIS_EIA_API_KEY,
      seriesId: process.env.GEA_EIA_SERIES_ID ?? 'PET.RWTC.D',
      label: process.env.GEA_EIA_SERIES_LABEL ?? 'WTI spot price',
    });
    if (observations.length === 0) {
      publicDataMesh.ingestSource(publicDataSource('eia', {
        last_success: connectorRegistry.get('eia')?.lastSuccess ?? null,
        last_error: connectorRegistry.get('eia')?.lastError ?? null,
      }));
    }
    for (const observation of observations) publicDataMesh.ingestObservation(observation);
  }

  if (process.env.GEA_PUBLIC_DATA_SEC !== 'false') {
    const releases = await fetchSecEdgarRss(connectorRegistry);
    if (releases.length === 0) {
      publicDataMesh.ingestSource(publicDataSource('sec-edgar', {
        last_success: connectorRegistry.get('sec-edgar')?.lastSuccess ?? null,
        last_error: connectorRegistry.get('sec-edgar')?.lastError ?? null,
      }));
    }
    for (const release of releases) publicDataMesh.ingestRelease(release);
  }

  pushPublicDataState();
}

function startBrainCluster() {
  for (const role of BRAIN_ROLES) {
    if (brainWorkers.has(role)) continue;
    const id = `brain-${role}`;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      let packetRate = workerData.role === 'primary' ? 1 : 0;
      function beat() {
        parentPort.postMessage({
          type: 'heartbeat',
          id: workerData.id,
          role: workerData.role,
          now: Date.now(),
          latency_ms: workerData.role === 'emergency' ? 3 : 1,
          packet_rate: packetRate,
          error_rate: 0
        });
      }
      const timer = setInterval(beat, 5000);
      beat();
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'shutdown') {
          clearInterval(timer);
          process.exit(0);
        }
      });
    `, { eval: true, workerData: { id, role } });
    worker.on('message', (msg: { type?: string; id?: string; now?: number; latency_ms?: number; packet_rate?: number; error_rate?: number }) => {
      if (msg.type !== 'heartbeat' || !msg.id || !msg.now) return;
      brainSupervisor.recordHeartbeat(msg.id, msg.now, {
        latency_ms: msg.latency_ms,
        packet_rate: msg.packet_rate,
        error_rate: msg.error_rate,
      });
      pushBrainHealth();
    });
    worker.once('exit', () => {
      brainWorkers.delete(role);
      pushBrainHealth();
    });
    brainWorkers.set(role, worker);
  }
  if (!brainHealthTimer) brainHealthTimer = setInterval(pushBrainHealth, 5_000);
  pushBrainHealth();
}

async function initializeLocalDb() {
  const dbPath = resolveGeaDatabasePath(app.getPath('userData'));
  copyLegacyGeaDatabaseIfMissing(dbPath, legacyGeaDatabasePath(app.getPath('appData')));
  dbStatus = await migrateGeaDatabase(dbPath);
  localStore = dbStatus.available ? await createGeaLocalStore(dbPath) : null;
  broadcast('gea:dbStatus', dbStatus);
}

function sendToNemesis(msg: Omit<NemesisBridgeMessage, 'seq'>) {
  if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) return;
  const full: NemesisBridgeMessage = { ...msg, seq: ++bridgeSeq };
  bridgeWs.send(JSON.stringify(full));
}

function connectBridge() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const ws = new WebSocket(BRIDGE_URL);
  bridgeWs = ws;

  ws.on('open', () => {
    reconnectDelay = RECONNECT_INITIAL_MS;
    bridgeStatus.connected = true;
    bridgeStatus.lastSeenAt = Date.now();
    pushBridgeStatus();

    sendToNemesis({
      type: 'bridge:hello',
      payload: { version: BRIDGE_VERSION, role: 'gea', timestamp: Date.now() },
    });
    pushIntelligenceState();
  });

  ws.on('message', (raw: RawData) => {
    try {
      const msg = JSON.parse(raw.toString()) as NemesisBridgeMessage;
      bridgeStatus.lastSeenAt = Date.now();

      if (msg.type === 'nemesis:state') {
        latestNemesisState = msg.payload as NemesisStateMirror;
        tapeStartup.observeNemesisState(latestNemesisState);
        broadcast('gea:nemesisState', msg.payload);
      } else if (msg.type === 'brain:recommendation') {
        broadcast('gea:recommendation', msg.payload);
      } else if (msg.type === 'nemesis:close-result') {
        localStore?.insertNemesisCloseResult(msg.payload as NemesisCloseResult);
        broadcast('gea:closeResult', msg.payload);
      } else if (msg.type === 'bridge:pong') {
        // heartbeat ack
      }
    } catch {
      // malformed packet — drop
    }
  });

  ws.on('close', () => {
    bridgeStatus.connected = false;
    pushBridgeStatus();
    scheduleReconnect();
  });

  ws.on('error', (_err: Error) => {
    // 'close' fires after 'error'; reconnect handled there
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
    connectBridge();
  }, reconnectDelay);
}

function setupIpc() {
  ipcMain.handle('gea:getBridgeStatus', () => ({ ...bridgeStatus }));
  ipcMain.handle('gea:getBrainHealth', () => brainSupervisor.snapshot());
  ipcMain.handle('gea:getDbStatus', () => ({ ...dbStatus }));
  ipcMain.handle('gea:getTapeState', () => tapeEngine?.getState() ?? tapeState);
  ipcMain.handle('gea:getPublicDataState', () => publicDataMesh?.getState() ?? publicDataState);
  ipcMain.handle('gea:getIntelligenceState', () => intelligenceState);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#0a0b0f',
    title: 'NEMESIS — Global Event Alpha',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (devUrl) {
    mainWindow.loadURL(devUrl).catch((err: Error) => console.error('[gea] loadURL failed', err));
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  setupIpc();
  createWindow();
  startBrainCluster();
  await initializeLocalDb();
  startPublicDataMesh();
  connectBridge();
  tapeStartup.begin();

  setInterval(() => {
    sendToNemesis({ type: 'bridge:ping', payload: {} });
  }, 30_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  tapeStartup.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (brainHealthTimer) clearInterval(brainHealthTimer);
  if (tapeRefreshTimer) clearInterval(tapeRefreshTimer);
  if (publicDataRefreshTimer) clearInterval(publicDataRefreshTimer);
  tapeEngine?.stop();
  feedHub.stopBackgroundPolling();
  localStore?.close();
  for (const worker of brainWorkers.values()) worker.postMessage({ type: 'shutdown' });
  if (bridgeWs) bridgeWs.close();
});
