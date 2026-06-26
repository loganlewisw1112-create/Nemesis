export type BrainRole =
  | 'primary'
  | 'standby-a'
  | 'standby-b'
  | 'standby-c'
  | 'shadow'
  | 'replay'
  | 'emergency';

export type Classification =
  | 'institutional-prime'
  | 'elite'
  | 'strong'
  | 'watch-for-entry'
  | 'paper-research'
  | 'ignore'
  | 'blocked';

export interface RecommendationPacket {
  id: string;
  brain_role: BrainRole;
  model_version: string;
  ticker: string;
  classification: Classification;
  alpha_score: number;
  nemesis_probability: number;
  confidence_band_low: number;
  confidence_band_high: number;
  net_ev: number;
  raw_edge: number;
  entry_zone_low: number;
  entry_zone_high: number;
  do_not_chase_level: number;
  target_exit: number;
  settlement_clarity_score: number;
  hold_class: 'scalp' | 'intraday' | 'catalyst' | 'pre-settlement' | 'settlement' | 'no-hold';
  expires_at: number;
  created_at: number;
  block_reason?: string;
}

export interface NoTradeWarning {
  ticker: string;
  block_reason: string;
  what_would_need_to_change: string;
  recheck_at: number;
  issued_by: BrainRole;
  issued_at: number;
}

export interface ExitRecommendation {
  ticker: string;
  action: 'hold' | 'trim' | 'exit' | 'add-only-on-pullback';
  current_edge: number;
  captured_edge: number;
  reason: string;
  issued_by: BrainRole;
  issued_at: number;
}

export type NemesisPositionTier = 'scalp' | 'core' | 'runner';

export interface NemesisCloseResult {
  ticker: string;
  action: 'trim' | 'close';
  contracts: number;
  pnl: number;
  was_profit: boolean;
  peak_pnl_usd: number;
  close_regret_usd: number;
  closed_at: number;
  reason: string;
  tier: NemesisPositionTier;
}
