import type { BrainRole, Classification, RecommendationPacket } from '@nemesis/bridge-contracts';

export type BrainHealthStatus =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'STALE'
  | 'UNSAFE'
  | 'OFFLINE'
  | 'QUARANTINED'
  | 'PROMOTED'
  | 'STANDBY_READY';

export interface BrainInstance {
  id: string;
  role: BrainRole;
  status: BrainHealthStatus;
  model_version: string;
  started_at: number;
  last_heartbeat: number;
  missed_heartbeats: number;
  packet_rate: number;
  error_rate: number;
  latency_ms: number;
}

export interface BrainFailoverEvent {
  id: string;
  from_role: BrainRole;
  to_role: BrainRole | 'standalone';
  reason: string;
  timestamp: number;
}

export interface BrainClusterSnapshot {
  activeRole: BrainRole | 'standalone';
  instances: BrainInstance[];
  failoverEvents: BrainFailoverEvent[];
}

export interface BrainInputFeatures {
  raw_edge: number;
  net_edge: number;
  confidence: number;
  liquidity: number;
  settlement_clarity: number;
  freshness: number;
  volatility_penalty?: number;
}

export interface AlphaScoreResult {
  alpha_score: number;
  classification: Classification;
}

export interface BrainOutputDraft extends Omit<RecommendationPacket, 'expires_at' | 'created_at'> {
  ttl_ms: number;
}
