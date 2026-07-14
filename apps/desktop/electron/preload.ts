import { contextBridge, ipcRenderer } from 'electron';

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
  getTickHistory: (ticker: string) => ipcRenderer.invoke('nemesis:getTickHistory', ticker),
  watchTicker: (ticker: string | null) => ipcRenderer.invoke('nemesis:watchTicker', ticker),
  getDiscoveryState: () => ipcRenderer.invoke('nemesis:getDiscoveryState'),
  updateDiscoverySettings: (partial: unknown) => ipcRenderer.invoke('nemesis:updateDiscoverySettings', partial),
  pauseDiscovery: () => ipcRenderer.invoke('nemesis:pauseDiscovery'),
  resumeDiscovery: () => ipcRenderer.invoke('nemesis:resumeDiscovery'),
  forceUniverseRefresh: () => ipcRenderer.invoke('nemesis:forceUniverseRefresh'),
  forceDepthPass: () => ipcRenderer.invoke('nemesis:forceDepthPass'),
  onSettingsUpdate: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('settings:update');
    ipcRenderer.on('settings:update', (_e, s) => cb(s));
  },
  onMarketsUpdate: (cb: (d: unknown) => void) => {
    ipcRenderer.removeAllListeners('markets:update');
    ipcRenderer.on('markets:update', (_e, d) => cb(d));
  },
  onPaperUpdate: (cb: (d: unknown) => void) => {
    ipcRenderer.removeAllListeners('paper:update');
    ipcRenderer.on('paper:update', (_e, d) => cb(d));
  },
  onTicksUpdate: (cb: (d: unknown) => void) => {
    ipcRenderer.removeAllListeners('ticks:update');
    ipcRenderer.on('ticks:update', (_e, d) => cb(d));
  },
  onDiscoveryUpdate: (cb: (d: unknown) => void) => {
    ipcRenderer.removeAllListeners('discovery:update');
    ipcRenderer.on('discovery:update', (_e, d) => cb(d));
  },
  openWidget: (type: string) => ipcRenderer.invoke('nemesis:openWidget', type),
  closeThisWidget: () => ipcRenderer.invoke('nemesis:closeThisWidget'),
  getWorldEvents: () => ipcRenderer.invoke('nemesis:getWorldEvents'),
  onWorldEventsUpdate: (cb: (d: unknown) => void) => {
    ipcRenderer.removeAllListeners('worldevents:update');
    ipcRenderer.on('worldevents:update', (_e, d) => cb(d));
  },
  getBridgeStatus: () => ipcRenderer.invoke('nemesis:getBridgeStatus'),
  onBridgeStatus: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('bridge:status');
    ipcRenderer.on('bridge:status', (_e, s) => cb(s));
  },
  onBridgeRecommendation: (cb: (p: unknown) => void) => {
    ipcRenderer.removeAllListeners('bridge:recommendation');
    ipcRenderer.on('bridge:recommendation', (_e, p) => cb(p));
  },
  onConnectorsUpdate: (cb: (d: unknown) => void) => {
    ipcRenderer.removeAllListeners('connectors:update');
    ipcRenderer.on('connectors:update', (_e, d) => cb(d));
  },
});
