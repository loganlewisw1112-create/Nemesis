export type SandboxMode =
  | 'historical-replay'
  | 'paper-trading'
  | 'strategy-lab'
  | 'execution-sim'
  | 'scenario-injection'
  | 'model-tournament';

export interface StrategyRule {
  id: string;
  type: 'entry' | 'exit' | 'size' | 'filter';
  field: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq';
  value: number;
}

export interface SandboxStrategy {
  id: string;
  name: string;
  rules: StrategyRule[];
  risk_rules: StrategyRule[];
  created_at: number;
}

export interface SandboxSession {
  id: string;
  mode: SandboxMode;
  strategy_id: string | null;
  model_version: string;
  starting_balance: number;
  status: 'running' | 'paused' | 'completed' | 'error';
  started_at: number;
  ended_at: number | null;
}

export interface SimulatedFill {
  id: string;
  session_id: string;
  ticker: string;
  side: 'yes' | 'no';
  qty: number;
  fill_price: number;
  slippage: number;
  fees: number;
  filled_at: number;
}
