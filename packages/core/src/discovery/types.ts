export type ExecutableTier = 'scout' | 'solid' | 'whale';
export type DiscoveryPreset = 'conservative' | 'balanced' | 'aggressive';
export type DiscoveryMode = 'full' | 'depth-only' | 'legacy' | 'frozen';

export interface DiscoverySettings {
  preset: DiscoveryPreset;
  universePageSize: number;
  maxTrackedTickers: number;
  depthChecksPerCycle: number;
  depthVerifyEnabled: boolean;
  signalPassEnabled: boolean;
  autoPauseOnApiDegrade: boolean;
  scoutTarget: number;
  solidTarget: number;
  whaleTarget: number;
}

export interface SideDepthResult {
  executableTier: ExecutableTier | null;
  fillableUsd: number;
  slippagePp: number;
  depthLevels: number;
}

export interface TickerDepthResult {
  ticker: string;
  spread: number;
  depthUsd: number;
  verifiedAt: number;
  yes?: SideDepthResult;
  no?: SideDepthResult;
}

export interface DiscoveryMetrics {
  trackedTickers: number;
  universePages: number;
  universeAgeSec: number;
  depthPending: number;
  depthVerifiedCycle: number;
  avgBookMs: number;
  scoutCount: number;
  solidCount: number;
  whaleCount: number;
  belowScout: number;
  orderbooksThisCycle: number;
  orderbookBudget: number;
  mode: DiscoveryMode;
  paused: boolean;
}

export interface DiscoveryState {
  settings: DiscoverySettings;
  metrics: DiscoveryMetrics;
}

export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  preset: 'balanced',
  universePageSize: 100,
  maxTrackedTickers: 500,
  depthChecksPerCycle: 150,
  depthVerifyEnabled: true,
  signalPassEnabled: true,
  autoPauseOnApiDegrade: true,
  scoutTarget: 20,
  solidTarget: 20,
  whaleTarget: 10,
};

export const PRESET_OVERRIDES: Record<DiscoveryPreset, Partial<DiscoverySettings>> = {
  conservative: { maxTrackedTickers: 200, depthChecksPerCycle: 80 },
  balanced: {},
  aggressive: { maxTrackedTickers: 500, depthChecksPerCycle: 200 },
};
