'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostAPI', {
  getBootstrap: () => ipcRenderer.invoke('get-bootstrap'),
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  getSources: () => ipcRenderer.invoke('get-sources'),
  setSelectedScreen: (screenInfo) => ipcRenderer.invoke('set-selected-screen', screenInfo),
  setCaptureOptions: (opts) => ipcRenderer.invoke('set-capture-options', opts),
  openViewerLocal: () => ipcRenderer.invoke('open-viewer-local'),
  openViewerWindow: () => ipcRenderer.invoke('open-viewer-window'),
  onViewerStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('viewer-status', listener);
    return () => ipcRenderer.removeListener('viewer-status', listener);
  },
  onViewerReady: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('viewer-ready', listener);
    return () => ipcRenderer.removeListener('viewer-ready', listener);
  },
});
