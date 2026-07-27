import type { RecommendationPacket, NoTradeWarning, ExitRecommendation, BrainRole, NemesisCloseResult } from './recommendations.js';

export type NemesisBridgeMessageType =
  | 'nemesis:state'
  | 'brain:recommendation'
  | 'brain:no-trade'
  | 'brain:exit'
  | 'nemesis:close-result'
  | 'bridge:ping'
  | 'bridge:pong'
  | 'bridge:hello';

export interface NemesisStateMirror {
  thesesCount: number;
  marketsCount: number;
  isLive: boolean;
  paperCash: number;
  paperEquity: number;
  dailyPnl: number;
  gates: string[];
  activeRegimes: string[];
  opportunityThroughput?: Record<string, number>;
  throughputTrigger?: string;
  paperPositions?: Array<{
    ticker: string;
    side: 'yes' | 'no';
    contracts: number;
    entryPrice: number;
  }>;
  marketFeedReady?: boolean;
  timestamp: number;
}

export interface BridgeHello {
  version: string;
  role: 'nemesis' | 'gea';
  timestamp: number;
}

export interface BridgeProcessTelemetry {
  pid: number;
  workingSetMb: number;
  sampledAt: number;
}

export type BridgePayload =
  | NemesisStateMirror
  | RecommendationPacket
  | NoTradeWarning
  | ExitRecommendation
  | NemesisCloseResult
  | BridgeHello
  | BridgeProcessTelemetry
  | Record<string, never>;

export interface NemesisBridgeMessage {
  type: NemesisBridgeMessageType;
  payload: BridgePayload;
  seq: number;
}

export interface BridgeStatus {
  connected: boolean;
  brainRole: BrainRole | null;
  lastSeenAt: number | null;
  clientCount: number;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  lastPongAt: number | null;
  lastSequenceIn: number | null;
  lastSequenceOut: number | null;
  /**
   * Bridge-socket counters (desktop<->GEA). NOT the Kalshi orderbook stream.
   * A 2026-07-27 run was read as "the orderbook never reconnected" from these
   * three zeros; the orderbook stream's own counters are the `orderbook*`
   * fields below.
   */
  reconnects: number;
  disconnects: number;
  failovers: number;
  tapeFreshnessMs: number | null;
  /** True transport state; `connected` additionally requires recent bidirectional traffic. */
  socketConnected?: boolean;
  qualificationReady?: boolean;
  peerRole?: BridgeHello['role'] | null;
  lastPingAt?: number | null;
  roundTripMs?: number | null;
  trafficFreshnessMs?: number | null;
  sequenceGaps?: number;
  pingCount?: number;
  pongCount?: number;
  tradeTapeFreshnessMs?: number | null;
  orderbookObservationFreshnessMs?: number | null;
  exchangeDeltaFreshnessMs?: number | null;
  /** Kalshi orderbook stream state — socket health here is not book health. */
  orderbookSocketState?: 'none' | 'connecting' | 'open' | 'closing' | 'closed' | null;
  orderbookStreamReconnects?: number | null;
  orderbookTrackedTickers?: number | null;
  orderbookQualifiedTickers?: number | null;
  orderbookSupervisorEscalations?: number | null;
  /** Latched when candidates cannot obtain a sequenced book; rejections emitted while true are not economic evidence. */
  dataPlaneDegraded?: boolean;
  dataPlaneDegradedMs?: number | null;
  candidateSequencedBookFraction?: number | null;
  geaPid?: number | null;
  geaWorkingSetMb?: number | null;
  geaProcessSampledAt?: number | null;
  mainPid?: number | null;
  mainWorkingSetMb?: number | null;
  mainProcessSampledAt?: number | null;
}
