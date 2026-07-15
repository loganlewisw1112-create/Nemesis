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
  geaPid?: number | null;
  geaWorkingSetMb?: number | null;
  geaProcessSampledAt?: number | null;
  mainPid?: number | null;
  mainWorkingSetMb?: number | null;
  mainProcessSampledAt?: number | null;
}
