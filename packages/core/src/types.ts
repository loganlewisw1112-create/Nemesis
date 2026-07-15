import { DEFAULT_AUTO_CLOSE_SETTINGS, type AutoCloseSettings, type ProfitCertificate } from './paper/types.js';

/** Kalshi's recommended production websocket endpoint. */
export const KALSHI_WS_URL = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';

export type KalshiEnvironment = 'production' | 'demo';

export type KalshiEndpointClass = 'market-data' | 'portfolio' | 'orders';

export interface KalshiEndpointPolicy {
  environment: KalshiEnvironment;
  restBaseUrls: readonly string[];
  websocketUrls: readonly string[];
}

export type KalshiFailureClass =
  | 'aborted'
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'not_found'
  | 'server'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'unknown';

export interface KalshiMarket {
  ticker: string;
  title: string;
  subtitle?: string;
  status: string;
  result?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  volume?: number;
  volume_24h?: number;
  open_interest?: number;
  volume_fp?: string;
  volume_24h_fp?: string;
  open_interest_fp?: string;
  category?: string;
  close_time?: string;
  event_ticker?: string;
  series_ticker?: string;
  price_level_structure?: 'linear_cent' | 'tapered_deci_cent' | 'deci_cent' | string;
  fractional_trading_enabled?: boolean;
  fee_waiver_expiration_time?: string;
  fee_type?: string;
  fee_multiplier?: number;
  fee_type_override?: string;
  fee_multiplier_override?: number;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export type KalshiFeeRole = 'maker' | 'taker';
export type KalshiAccountPrecision = 'direct' | 'non_direct' | 'unknown';

/** Exchange fee inputs frozen with each evidence run. Unknown inputs fail qualification closed. */
export interface KalshiFeePolicy {
  known: boolean;
  role: KalshiFeeRole;
  multiplier: number;
  accountPrecision: KalshiAccountPrecision;
  seriesTicker?: string;
  feeType?: string;
  scheduleVersion: string;
  source: string;
}

export interface KalshiSeries {
  ticker: string;
  fee_type?: string;
  fee_multiplier?: number;
  last_updated_ts?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  last_updated_ts?: string;
}

export interface KalshiOrderbook {
  ticker: string;
  yes: OrderbookLevel[];
  no: OrderbookLevel[];
  yesAsk?: number;
  noAsk?: number;
  spread?: number;
  /** Exchange-origin book time. Never populated from local post-fetch time. */
  sourceTimestamp?: number;
  /** Exchange WebSocket sequence. REST books normally cannot supply this. */
  sequence?: number;
  receivedAt?: number;
  priceLevelStructure?: string;
  feePolicy?: KalshiFeePolicy;
}

export interface KalshiTrade {
  trade_id: string;
  ticker: string;
  /** Internal cent price (0-100); fixed-point dollar API fields are normalized at fetch. */
  yes_price: number;
  no_price: number;
  /** Contract quantity; Kalshi fixed-point responses may contain fractional contracts. */
  count: number;
  taker_side: 'yes' | 'no';
  created_time: string;
}

export interface KalshiTradesResponse {
  trades: KalshiTrade[];
  cursor?: string;
}

export type LiveTradingStage = 'paper' | 'manual-live' | 'auto-live';

export interface LiveUnlockCertificate {
  stage: Exclude<LiveTradingStage, 'paper'>;
  issuedAt: number;
  expiresAt: number;
  summary: string;
  metrics: Record<string, number | boolean | string>;
}

export interface StrictProfitModeSettings {
  enabled: boolean;
  minNetPnlUsd: number;
  requireEntryLiquidationPath: boolean;
  allowEmergencyLossClose: boolean;
  maxBookAgeMs: number;
}

export interface OpportunityThroughputSettings {
  enabled: boolean;
  maxConcurrentBookFetches: number;
  retryableBlockCooldownMs: number;
  maxDailyCertifiedTrades: number | null;
  minCertifiedProfitPerTradeUsd: number;
}

export type StrategyValidationStage = 'shadow' | 'pilot' | 'qualification';

export interface EntryQualificationSettings {
  enabled: boolean;
  minSamples: number;
  minWindowMs: number;
  maxSourceAgeMs: number;
  minEdgeRetention: number;
  maxBookAgeMs: number;
  maxSpreadWideningPp: number;
  /** Minimum conditional target reward; legacy field name retained for saved settings. */
  minExpectedNetPnlUsd: number;
  minRewardRiskRatio: number;
  minStressedNetPnlUsd: number;
  tickerCooldownMs: number;
  maxPendingCandidates: number;
  shadowFollowUpMs: number;
  shadowMinScored: number;
  shadowMinDistinctDays: number;
  shadowMinProfitFactor: number;
  shadowMinWinRate: number;
  shadowMinStressedProfitFactor: number;
  pilotMaxEntryRiskUsd: number;
  pilotLossBudgetUsd: number;
  pilotMinCompleted: number;
  pilotMinProfitFactor: number;
  pilotMinWinRate: number;
  pilotMaxDrawdownUsd: number;
  pilotMaxFalseExitRate: number;
  pilotMaxAverageRegretUsd: number;
  instrumentationDurationMs: number;
  instrumentationMinUniqueCandidates: number;
  instrumentationMinTerminalCoverage: number;
  instrumentationMinDiagnosticSchedulingCoverage: number;
  instrumentationMinValidDiagnosticCoverage: number;
  campaignDurationMs: number;
  campaignEnrollmentCloseoutMs: number;
  campaignMinValidDiagnostics: number;
  campaignMinReadyCandidates: number;
  campaignMinFreshSampleRate: number;
}

export const DEFAULT_ENTRY_QUALIFICATION: EntryQualificationSettings = {
  enabled: true,
  minSamples: 6,
  minWindowMs: 30_000,
  maxSourceAgeMs: 60_000,
  minEdgeRetention: 0.7,
  maxBookAgeMs: 1_000,
  maxSpreadWideningPp: 0.01,
  minExpectedNetPnlUsd: 1,
  minRewardRiskRatio: 2,
  minStressedNetPnlUsd: 0.01,
  tickerCooldownMs: 15 * 60_000,
  maxPendingCandidates: 8,
  shadowFollowUpMs: 15 * 60_000,
  shadowMinScored: 100,
  shadowMinDistinctDays: 3,
  shadowMinProfitFactor: 1.25,
  shadowMinWinRate: 0.55,
  shadowMinStressedProfitFactor: 1.1,
  pilotMaxEntryRiskUsd: 10,
  pilotLossBudgetUsd: 20,
  pilotMinCompleted: 20,
  pilotMinProfitFactor: 1.25,
  pilotMinWinRate: 0.55,
  pilotMaxDrawdownUsd: 20,
  pilotMaxFalseExitRate: 0.15,
  pilotMaxAverageRegretUsd: 0.5,
  instrumentationDurationMs: 2 * 60 * 60_000,
  instrumentationMinUniqueCandidates: 20,
  instrumentationMinTerminalCoverage: 1,
  instrumentationMinDiagnosticSchedulingCoverage: 0.95,
  instrumentationMinValidDiagnosticCoverage: 0.9,
  campaignDurationMs: 7 * 60 * 60_000,
  campaignEnrollmentCloseoutMs: 15 * 60_000,
  campaignMinValidDiagnostics: 30,
  campaignMinReadyCandidates: 1,
  campaignMinFreshSampleRate: 0.95,
};

export interface GuardrailSettings {
  demoMode: boolean;
  dryRun: boolean;
  liveEnabled: boolean;
  liveStage?: LiveTradingStage;
  autoLiveEnabled?: boolean;
  liveUnlockCertificate?: LiveUnlockCertificate;
  cryptoLiveEnabled: boolean;
  maxPositionUsd: number;
  dailyLossCapUsd: number;
  maxSlippagePp: number;
  killSwitchActive: boolean;
  kalshiApiKeyId?: string;
  useProductionApi?: boolean;
  humanQuizPassed?: boolean;
  backtestPassed?: boolean;
  autoClose?: AutoCloseSettings;
  strictProfitMode?: StrictProfitModeSettings;
  opportunityThroughput?: OpportunityThroughputSettings;
  entryQualification?: EntryQualificationSettings;
  kalshiAccountPrecision?: KalshiAccountPrecision;
}

export const DEFAULT_STRICT_PROFIT_MODE: StrictProfitModeSettings = {
  enabled: true,
  minNetPnlUsd: 0.01,
  requireEntryLiquidationPath: true,
  allowEmergencyLossClose: true,
  maxBookAgeMs: 2_000,
};

export const DEFAULT_OPPORTUNITY_THROUGHPUT: OpportunityThroughputSettings = {
  enabled: true,
  maxConcurrentBookFetches: 8,
  retryableBlockCooldownMs: 5_000,
  maxDailyCertifiedTrades: null,
  minCertifiedProfitPerTradeUsd: 0.01,
};

export const DEFAULT_GUARDRAILS: GuardrailSettings = {
  demoMode: true,
  dryRun: true,
  liveEnabled: false,
  liveStage: 'paper',
  autoLiveEnabled: false,
  cryptoLiveEnabled: false,
  maxPositionUsd: 10,
  dailyLossCapUsd: 5,
  maxSlippagePp: 0.03,
  killSwitchActive: false,
  useProductionApi: false,
  humanQuizPassed: false,
  backtestPassed: false,
  autoClose: { ...DEFAULT_AUTO_CLOSE_SETTINGS },
  strictProfitMode: { ...DEFAULT_STRICT_PROFIT_MODE },
  opportunityThroughput: { ...DEFAULT_OPPORTUNITY_THROUGHPUT },
  entryQualification: { ...DEFAULT_ENTRY_QUALIFICATION },
};

export type ThesisStatus =
  | 'observe'
  | 'qualified'
  | 'tradeable'
  | 'watch-only'
  | 'stale'
  | 'uncertain'
  | 'blocked'
  | 'de-risk'
  | 'closed'
  | 'review';

export type ExecutionQueueState =
  | 'discovered'
  | 'book_pending'
  | 'certified'
  | 'blocked_retryable'
  | 'blocked_final'
  | 'executed';

export type PlaybookId =
  | 'flow-hunter'
  | 'weather-wing'
  | 'macro-pulse'
  | 'crypto-lead'
  | 'release-radar'
  | 'global-pulse'
  | 'infra-watch'
  | 'sports-live'
  | 'fed-sniper';

export interface ThesisCard {
  id: string;
  ticker: string;
  title: string;
  category: string;
  playbook: PlaybookId;
  status: ThesisStatus;
  side: 'yes' | 'no';
  /** Executable/reference price for the selected side, never an unconditional YES price. */
  marketPrice: number;
  /** Model fair price for the selected side. */
  impliedPrice: number;
  grossEdge: number;
  netEdge: number;
  spread: number;
  depthUsd: number;
  predictability: number;
  feeEstimate: number;
  signalReason: string;
  externalSummary: string;
  createdAt: number;
  updatedAt: number;
  freshnessMs: number;
  edgeHistory: number[];
  drivers: ThesisDriver[];
  invalidations: string[];
  sourceMove?: SourceMoveClass;
  executableTier?: 'scout' | 'solid' | 'whale';
  fillableUsd?: number;
  slippagePp?: number;
  depthLevels?: number;
  executionQueueState?: ExecutionQueueState;
  executionBlockReason?: string;
  executionAbortCode?: string;
  certifiedNetPnlUsd?: number;
  profitCertificate?: ProfitCertificate;
  cryptoContext?: CryptoThesisContext;
}

export type SourceMoveClass =
  | 'flow-driven'
  | 'forecast-driven'
  | 'news-driven'
  | 'resolution-near'
  | 'microstructure-only'
  | 'unknown';

export interface ThesisDriver {
  label: string;
  impact: number;
  detail: string;
}

export interface CryptoThesisContext {
  symbol: string;
  spotPrice: number;
  strike: number;
  distanceBps: number;
  momentumBps: number;
  volatilityBps: number;
  confidence: number;
  sampleCount: number;
  windowMs: number;
}

export interface JournalEntry {
  id: string;
  timestamp: number;
  ticker: string;
  marketTitle: string;
  module: PlaybookId;
  signalReason: string;
  side: 'yes' | 'no';
  entryPrice: number;
  spread: number;
  feeEstimate: number;
  exitRule: string;
  result?: 'win' | 'loss' | 'pending';
  grossPnl?: number;
  netEstimate?: number;
  notes: string;
  mistakeTags: string[];
}

export interface ConnectorHealth {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  lastSuccess: number | null;
  latencyMs: number | null;
  errorCount1h: number;
  lastError: string | null;
  lastAttempt?: number | null;
  lastMessageAt?: number | null;
  lastPongAt?: number | null;
  nextRetryAt?: number | null;
  failureClass?: KalshiFailureClass | null;
  reconnects?: number;
  disconnects?: number;
  sequenceGaps?: number;
  lastCloseAt?: number | null;
  lastCloseCode?: number | null;
  lastCloseReason?: string | null;
  trackedTickers?: number;
  qualifiedTickers?: number;
  subscriptionUpdates?: number;
  subscriptionUpdateQueueDepth?: number;
  subscriptionUpdateInFlight?: boolean;
  freshnessMs?: number | null;
  transportConnected?: boolean;
  authenticated?: boolean;
  qualificationReady?: boolean;
  environment?: KalshiEnvironment;
  endpointClass?: KalshiEndpointClass;
}

export interface GateStatus {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export interface GeoNewsItem {
  title: string;
  url: string;
  category: string;
  severity: number;
  region: string;
  countryCode: string;
  lat: number;
  lon: number;
  fetchedAt: number;
}

export interface GeoMarket {
  ticker: string;
  title: string;
  category: string;
  marketPrice: number;
  netEdge: number;
  status: string;
  lat: number;
  lon: number;
  countryCode: string;
  thesisId?: string;
}

export interface WorldEventsPayload {
  geoNews: GeoNewsItem[];
  geoMarkets: GeoMarket[];
  heatData: Record<string, number>;
  lastUpdated: number;
}
