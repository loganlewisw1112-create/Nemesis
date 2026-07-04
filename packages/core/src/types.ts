import { DEFAULT_AUTO_CLOSE_SETTINGS, type AutoCloseSettings, type ProfitCertificate } from './paper/types.js';

export const KALSHI_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';

export interface KalshiMarket {
  ticker: string;
  title: string;
  subtitle?: string;
  status: string;
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
  category?: string;
  close_time?: string;
  event_ticker?: string;
  series_ticker?: string;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface KalshiOrderbook {
  ticker: string;
  yes: OrderbookLevel[];
  no: OrderbookLevel[];
  yesAsk?: number;
  noAsk?: number;
  spread?: number;
}

export interface KalshiTrade {
  trade_id: string;
  ticker: string;
  yes_price: number;
  no_price: number;
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
}

export const DEFAULT_STRICT_PROFIT_MODE: StrictProfitModeSettings = {
  enabled: true,
  minNetPnlUsd: 0.01,
  requireEntryLiquidationPath: true,
  allowEmergencyLossClose: false,
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
  marketPrice: number;
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
