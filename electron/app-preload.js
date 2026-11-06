// Preload for the main UI window. Exposes a minimal bridge so the web UI can ask
// the Electron shell to fully quit (window + tray + backend). Everything else the
// UI needs is served over HTTP by the backend, so only `quitApp` is bridged.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  quitApp: () => ipcRenderer.invoke('app-quit'),
});
