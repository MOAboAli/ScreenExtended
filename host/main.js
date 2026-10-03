'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, shell, session } = require('electron');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { handleRemoteInput } = require('./input');

const PORT = Number(process.env.SCREENEXTENDED_PORT || 4789);

let mainWindow = null;
let selectedScreen = null;
let selectedSourceId = null;
let captureWantsAudio = true;
const peers = new Map(); // ws -> role

// Required on modern Electron for screen + WASAPI loopback audio
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        out.push({ name, address: net.address });
      }
    }
  }
  return out;
}

function listDisplays() {
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    index: i,
    label: d.label || `Display ${i + 1}`,
    bounds: d.bounds,
    size: d.size,
    scaleFactor: d.scaleFactor,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: 'ScreenExtended Host',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Needed so the host page can capture desktop + system audio loopback
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

function startServer() {
  const expressApp = express();
  expressApp.use('/viewer', express.static(path.join(__dirname, '..', 'viewer')));
  expressApp.get('/', (_req, res) => {
    res.redirect('/viewer/');
  });
  expressApp.get('/api/info', (_req, res) => {
    res.json({
      name: 'ScreenExtended',
      port: PORT,
      addresses: lanAddresses(),
      displays: listDisplays(),
      selected: selectedScreen,
      clients: [...peers.values()].filter((r) => r === 'viewer').length,
    });
  });

  const server = http.createServer(expressApp);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    peers.set(ws, 'unknown');

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        peers.set(ws, msg.role || 'unknown');
        if (msg.role === 'viewer' && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('viewer-status', {
            connected: true,
            count: [...peers.values()].filter((r) => r === 'viewer').length,
          });
        }
        broadcastInfo();
        return;
      }

      if (msg.type === 'signal') {
        // Relay WebRTC signaling between host and viewers
        const targetRole = msg.to || (peers.get(ws) === 'host' ? 'viewer' : 'host');
        for (const [peer, role] of peers.entries()) {
          if (peer !== ws && role === targetRole && peer.readyState === 1) {
            peer.send(JSON.stringify({
              type: 'signal',
              from: peers.get(ws),
              data: msg.data,
            }));
          }
        }
        return;
      }

      if (msg.type === 'input') {
        if (selectedScreen && selectedScreen.bounds) {
          handleRemoteInput(msg.data, selectedScreen.bounds);
        }
        return;
      }

      if (msg.type === 'viewer-ready') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('viewer-ready');
        }
      }
    });

    ws.on('close', () => {
      peers.delete(ws);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('viewer-status', {
          connected: [...peers.values()].some((r) => r === 'viewer'),
          count: [...peers.values()].filter((r) => r === 'viewer').length,
        });
      }
      broadcastInfo();
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ScreenExtended listening on http://0.0.0.0:${PORT}`);
  });

  return { server, wss };
}

function broadcastInfo() {
  const payload = JSON.stringify({
    type: 'info',
    displays: listDisplays(),
    selected: selectedScreen,
    addresses: lanAddresses(),
  });
  for (const [peer] of peers.entries()) {
    if (peer.readyState === 1) peer.send(payload);
  }
}

function setupIpc() {
  ipcMain.handle('get-bootstrap', async () => ({
    port: PORT,
    addresses: lanAddresses(),
    displays: listDisplays(),
    viewerUrlHints: lanAddresses().map((a) => `http://${a.address}:${PORT}/viewer/`),
  }));

  ipcMain.handle('list-displays', async () => listDisplays());

  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    console.log(`desktopCapturer sources: ${sources.length}`);
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      display_id: s.display_id,
      thumbnail: s.thumbnail.isEmpty()
        ? ''
        : s.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('set-selected-screen', async (_e, screenInfo) => {
    selectedScreen = screenInfo;
    selectedSourceId = screenInfo?.sourceId || null;
    broadcastInfo();
    return true;
  });

  ipcMain.handle('set-capture-options', async (_e, opts) => {
    captureWantsAudio = opts?.audio !== false;
    return { audio: captureWantsAudio };
  });

  ipcMain.handle('open-viewer-local', async () => {
    const url = `http://127.0.0.1:${PORT}/viewer/`;
    await shell.openExternal(url);
    return url;
  });

  ipcMain.handle('open-viewer-window', async () => {
    const url = `http://127.0.0.1:${PORT}/viewer/`;
    const win = new BrowserWindow({
      width: 960,
      height: 600,
      title: 'ScreenExtended Viewer',
      backgroundColor: '#05070a',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await win.loadURL(url);
    return url;
  });
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const chosen =
        sources.find((s) => s.id === selectedSourceId) ||
        sources[0];
      if (!chosen) {
        callback({});
        return;
      }
      // audio: 'loopback' duplicates system speakers on Windows (does not take over)
      callback({
        video: chosen,
        audio: captureWantsAudio ? 'loopback' : undefined,
      });
    } catch (err) {
      console.error('setDisplayMediaRequestHandler failed', err);
      callback({});
    }
  }, { useSystemPicker: false });

  setupIpc();
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
