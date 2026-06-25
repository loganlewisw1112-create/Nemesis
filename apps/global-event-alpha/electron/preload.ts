import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('gea', {
  getBridgeStatus: () => ipcRenderer.invoke('gea:getBridgeStatus'),
  getBrainHealth: () => ipcRenderer.invoke('gea:getBrainHealth'),
  getDbStatus: () => ipcRenderer.invoke('gea:getDbStatus'),
  getTapeState: () => ipcRenderer.invoke('gea:getTapeState'),
  getPublicDataState: () => ipcRenderer.invoke('gea:getPublicDataState'),
  getIntelligenceState: () => ipcRenderer.invoke('gea:getIntelligenceState'),
  onBridgeStatus: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('gea:bridgeStatus');
    ipcRenderer.on('gea:bridgeStatus', (_e, s) => cb(s));
  },
  onNemesisState: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('gea:nemesisState');
    ipcRenderer.on('gea:nemesisState', (_e, s) => cb(s));
  },
  onRecommendation: (cb: (p: unknown) => void) => {
    ipcRenderer.removeAllListeners('gea:recommendation');
    ipcRenderer.on('gea:recommendation', (_e, p) => cb(p));
  },
  onBrainHealth: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('gea:brainHealth');
    ipcRenderer.on('gea:brainHealth', (_e, s) => cb(s));
  },
  onDbStatus: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('gea:dbStatus');
    ipcRenderer.on('gea:dbStatus', (_e, s) => cb(s));
  },
  onTapeUpdate: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('gea:tapeUpdate');
    ipcRenderer.on('gea:tapeUpdate', (_e, s) => cb(s));
  },
  onPublicDataUpdate: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('gea:publicDataUpdate');
    ipcRenderer.on('gea:publicDataUpdate', (_e, s) => cb(s));
  },
  onIntelligenceUpdate: (cb: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('gea:intelligenceUpdate');
    ipcRenderer.on('gea:intelligenceUpdate', (_e, s) => cb(s));
  },
});
