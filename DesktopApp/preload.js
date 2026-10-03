'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostAPI', {
  getBootstrap: () => ipcRenderer.invoke('get-bootstrap'),
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  getSources: () => ipcRenderer.invoke('get-sources'),
  setSelectedScreen: (screenInfo) => ipcRenderer.invoke('set-selected-screen', screenInfo),
  setCaptureOptions: (opts) => ipcRenderer.invoke('set-capture-options', opts),
  getOpenAtLogin: () => ipcRenderer.invoke('get-open-at-login'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('set-open-at-login', enabled),
  virtualDriverStatus: () => ipcRenderer.invoke('virtual-driver-status'),
  installVirtualDriver: () => ipcRenderer.invoke('install-virtual-driver'),
  createRemoteScreen: () => ipcRenderer.invoke('create-remote-screen'),
  removeRemoteScreen: () => ipcRenderer.invoke('remove-remote-screen'),
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
  onViewerRequestStart: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('viewer-request-start', listener);
    return () => ipcRenderer.removeListener('viewer-request-start', listener);
  },
  onRemoteScreenReady: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('remote-screen-ready', listener);
    return () => ipcRenderer.removeListener('remote-screen-ready', listener);
  },
  onViewerSession: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('viewer-session', listener);
    return () => ipcRenderer.removeListener('viewer-session', listener);
  },
  onStopStreaming: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('stop-streaming', listener);
    return () => ipcRenderer.removeListener('stop-streaming', listener);
  },
});
