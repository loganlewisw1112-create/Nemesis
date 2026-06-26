export interface LatencyMetrics {
  localDecisionMs: number;
  orderSubmitRttMs: number;
  orderAckMs?: number;
  fillConfirmMs: number;
  profitLockTotalMs: number;
  eventLoopDelayMs: number;
  workerQueueDepth: number;
}

export interface ExchangeLatencySettings {
  orderTransport: 'rest' | 'fix';
  keepAliveEnabled: boolean;
  prestageExitEnabled: boolean;
  preferIocForProfitLock: boolean;
  maxSubmitRttMs: number;
  maxFillConfirmMs: number;
  privateConnectivityEnabled: boolean;
}

export const DEFAULT_EXCHANGE_LATENCY_SETTINGS: ExchangeLatencySettings = {
  orderTransport: 'rest',
  keepAliveEnabled: true,
  prestageExitEnabled: true,
  preferIocForProfitLock: true,
  maxSubmitRttMs: 50,
  maxFillConfirmMs: 150,
  privateConnectivityEnabled: false,
};

export function emptyLatencyMetrics(overrides: Partial<LatencyMetrics> = {}): LatencyMetrics {
  return {
    localDecisionMs: 0,
    orderSubmitRttMs: 0,
    fillConfirmMs: 0,
    profitLockTotalMs: 0,
    eventLoopDelayMs: 0,
    workerQueueDepth: 0,
    ...overrides,
  };
}
