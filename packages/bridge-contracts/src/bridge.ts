import type { RecommendationPacket, NoTradeWarning, ExitRecommendation, BrainRole } from './recommendations.js';

export type NemesisBridgeMessageType =
  | 'nemesis:state'
  | 'brain:recommendation'
  | 'brain:no-trade'
  | 'brain:exit'
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
  timestamp: number;
}

export interface BridgeHello {
  version: string;
  role: 'nemesis' | 'gea';
  timestamp: number;
}

export type BridgePayload =
  | NemesisStateMirror
  | RecommendationPacket
  | NoTradeWarning
  | ExitRecommendation
  | BridgeHello
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
}
