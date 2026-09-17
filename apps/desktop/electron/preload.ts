import { contextBridge, ipcRenderer } from 'electron';

function subscribe(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

let rendererPainted = false;
let rendererHeartbeatSequence = 0;
let rendererHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
const reportRendererHeartbeat = () => {
  const payload = {
    painted: rendererPainted,
    at: Date.now(),
    sequence: ++rendererHeartbeatSequence,
  };
  try {
    ipcRenderer.send('renderer:heartbeat', payload);
  } catch {
    try { ipcRenderer.send('renderer:heartbeat-send-failed'); } catch { /* unloading */ }
  }
};
const onRendererProbe = (_event: Electron.IpcRendererEvent, payload: { sentAt?: number; sequence?: number } = {}) => {
  try {
    ipcRenderer.send('renderer:probe-response', {
      sentAt: payload.sentAt,
      sequence: payload.sequence,
      receivedAt: Date.now(),
    });
  } catch {
    try { ipcRenderer.send('renderer:heartbeat-send-failed'); } catch { /* unloading */ }
  }
};
ipcRenderer.on('renderer:probe', onRendererProbe);
reportRendererHeartbeat();
rendererHeartbeatTimer = setInterval(reportRendererHeartbeat, 5_000);
window.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => {
    rendererPainted = true;
    reportRendererHeartbeat();
  });
}, { once: true });
window.addEventListener('unload', () => {
  if (rendererHeartbeatTimer) clearInterval(rendererHeartbeatTimer);
  rendererHeartbeatTimer = null;
  ipcRenderer.removeListener('renderer:probe', onRendererProbe);
}, { once: true });

contextBridge.exposeInMainWorld('nemesis', {
  getState: () => ipcRenderer.invoke('nemesis:getState'),
  getMarkets: () => ipcRenderer.invoke('nemesis:getMarkets'),
  updateSettings: (partial: unknown) => ipcRenderer.invoke('nemesis:updateSettings', partial),
  getKalshiCredentialStatus: () => ipcRenderer.invoke('nemesis:getKalshiCredentialStatus'),
  saveKalshiCredentials: (input: unknown) => ipcRenderer.invoke('nemesis:saveKalshiCredentials', input),
  clearKalshiCredentials: () => ipcRenderer.invoke('nemesis:clearKalshiCredentials'),
  journalAdd: (id: string, notes?: string) => ipcRenderer.invoke('nemesis:journalAdd', id, notes),
  journalExport: () => ipcRenderer.invoke('nemesis:journalExport'),
  dryRun: (id: string) => ipcRenderer.invoke('nemesis:dryRun', id),
  passQuiz: () => ipcRenderer.invoke('nemesis:passQuiz'),
  passBacktest: () => ipcRenderer.invoke('nemesis:passBacktest'),
  quarantinePlaybook: (p: string) => ipcRenderer.invoke('nemesis:quarantinePlaybook', p),
  killSwitch: () => ipcRenderer.invoke('nemesis:killSwitch'),
  unlockLive: (confirmText: string) => ipcRenderer.invoke('nemesis:unlockLive', confirmText),
  exportSession: () => ipcRenderer.invoke('nemesis:exportSession'),
  reconcileLive: () => ipcRenderer.invoke('nemesis:reconcileLive'),
  refresh: () => ipcRenderer.invoke('nemesis:refresh'),
  liveBuy: (id: string, contracts?: number, limitPrice?: number) =>
    ipcRenderer.invoke('nemesis:liveBuy', id, contracts, limitPrice),
  paperBuy: (id: string, contracts?: number) => ipcRenderer.invoke('nemesis:paperBuy', id, contracts),
  paperClose: (id: string, contracts?: number) => ipcRenderer.invoke('nemesis:paperClose', id, contracts),
  paperPreview: (id: string, contracts?: number) => ipcRenderer.invoke('nemesis:paperPreview', id, contracts),
  paperPlaceLimit: (id: string, contracts: number, limitPrice: number) =>
    ipcRenderer.invoke('nemesis:paperPlaceLimit', id, contracts, limitPrice),
  paperCancelOrder: (orderId: string) => ipcRenderer.invoke('nemesis:paperCancelOrder', orderId),
  getPaperPortfolio: () => ipcRenderer.invoke('nemesis:getPaperPortfolio'),
  resetPaper: (confirmation: string) => ipcRenderer.invoke('nemesis:resetPaper', confirmation),
  advanceStrategyStage: (stage: string, confirmation: string) =>
    ipcRenderer.invoke('nemesis:advanceStrategyStage', stage, confirmation),
  getTickHistory: (ticker: string) => ipcRenderer.invoke('nemesis:getTickHistory', ticker),
  watchTicker: (ticker: string | null) => ipcRenderer.invoke('nemesis:watchTicker', ticker),
  getDiscoveryState: () => ipcRenderer.invoke('nemesis:getDiscoveryState'),
  updateDiscoverySettings: (partial: unknown) => ipcRenderer.invoke('nemesis:updateDiscoverySettings', partial),
  pauseDiscovery: () => ipcRenderer.invoke('nemesis:pauseDiscovery'),
  resumeDiscovery: () => ipcRenderer.invoke('nemesis:resumeDiscovery'),
  forceUniverseRefresh: () => ipcRenderer.invoke('nemesis:forceUniverseRefresh'),
  forceDepthPass: () => ipcRenderer.invoke('nemesis:forceDepthPass'),
  onSettingsUpdate: (cb: (s: unknown) => void) => {
    return subscribe('settings:update', cb);
  },
  onMarketsUpdate: (cb: (d: unknown) => void) => {
    return subscribe('markets:update', cb);
  },
  onMarketsStateV2: (cb: (d: unknown) => void) => {
    return subscribe('markets:state-v2', cb);
  },
  onPaperUpdate: (cb: (d: unknown) => void) => {
    return subscribe('paper:update', cb);
  },
  onEquityHistoryStateV2: (cb: (d: unknown) => void) => {
    return subscribe('equity-history:state-v2', cb);
  },
  onTicksUpdate: (cb: (d: unknown) => void) => {
    return subscribe('ticks:update', cb);
  },
  onDiscoveryUpdate: (cb: (d: unknown) => void) => {
    return subscribe('discovery:update', cb);
  },
  openWidget: (type: string) => ipcRenderer.invoke('nemesis:openWidget', type),
  closeThisWidget: () => ipcRenderer.invoke('nemesis:closeThisWidget'),
  getWorldEvents: () => ipcRenderer.invoke('nemesis:getWorldEvents'),
  onWorldEventsUpdate: (cb: (d: unknown) => void) => {
    return subscribe('worldevents:update', cb);
  },
  getBridgeStatus: () => ipcRenderer.invoke('nemesis:getBridgeStatus'),
  onBridgeStatus: (cb: (s: unknown) => void) => {
    return subscribe('bridge:status', cb);
  },
  onBridgeRecommendation: (cb: (p: unknown) => void) => {
    return subscribe('bridge:recommendation', cb);
  },
  onConnectorsUpdate: (cb: (d: unknown) => void) => {
    return subscribe('connectors:update', cb);
  },
});
