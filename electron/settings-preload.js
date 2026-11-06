// Preload for the settings window. Runs with contextIsolation, exposing only the
// two IPC calls the settings form needs — no Node access leaks into the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
});
