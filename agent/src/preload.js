// Secure bridge between renderer windows and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getContext: () => ipcRenderer.invoke('get-context'),
  saveServerUrl: (url) => ipcRenderer.invoke('save-server-url', url),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  login: (creds) => ipcRenderer.invoke('login', creds),
  changePassword: (creds) => ipcRenderer.invoke('change-password', creds),
  reauth: (creds) => ipcRenderer.invoke('reauth', creds),
  confirmLogout: (data) => ipcRenderer.invoke('confirm-logout', data),
  cancelLogout: () => ipcRenderer.invoke('cancel-logout'),
});
