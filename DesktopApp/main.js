'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { handleRemoteInput } = require('./input');
const virtualDisplay = require('./virtualDisplay');

const PORT = Number(process.env.SCREENEXTENDED_PORT || 4789);
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

let mainWindow = null;
let selectedScreen = null;
let selectedSourceId = null;
let captureWantsAudio = true;
let remoteVirtualDisplayId = null;
let remoteVirtualActive = false;
let activeViewerWs = null;
let markerWindow = null;
let screenOpQueue = Promise.resolve();
const peers = new Map();

function enqueueScreenOp(fn) {
  const run = screenOpQueue.then(fn).catch((err) => {
    console.error('screen op failed', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('viewer-session', {
        connected: countViewers() > 0,
        action: 'error',
        error: String(err?.message || err),
      });
    }
    throw err;
  });
  screenOpQueue = run.catch(() => {}); // keep queue alive
  return run;
}

function countViewers() {
  let n = 0;
  for (const [peer, role] of peers.entries()) {
    if (role === 'viewer' && peer.readyState === 1) n += 1;
  }
  return n;
}

function closeMarkerWindow() {
  if (markerWindow && !markerWindow.isDestroyed()) {
    try { markerWindow.close(); } catch { /* */ }
  }
  markerWindow = null;
  if (global.__sxMarkerWindows) {
    for (const w of global.__sxMarkerWindows) {
      try { if (!w.isDestroyed()) w.close(); } catch { /* */ }
    }
    global.__sxMarkerWindows = [];
  }
}

app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

const gotLock = process.env.SCREENEXTENDED_ALLOW_MULTI === '1'
  ? true
  : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return { openAtLogin: false };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function applyOpenAtLogin(enabled) {
  const settings = loadSettings();
  settings.openAtLogin = !!enabled;
  saveSettings(settings);

  // Starts ScreenExtended Host automatically after Windows restart / user login
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    openAsHidden: false,
    path: process.execPath,
    args: app.isPackaged ? [] : [path.resolve(__dirname)],
  });
  return settings.openAtLogin;
}

function getOpenAtLogin() {
  const settings = loadSettings();
  // Prefer our saved setting; sync OS state on first run
  if (settings.openAtLogin == null) settings.openAtLogin = false;
  return !!settings.openAtLogin;
}

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
    isRemoteVirtual: remoteVirtualDisplayId != null && String(d.id) === String(remoteVirtualDisplayId),
  }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function forceExtendMode() {
  try {
    const { spawn } = require('child_process');
    spawn('DisplaySwitch.exe', ['/extend'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    console.warn('DisplaySwitch failed', err);
  }
}

async function waitForNewDisplay(beforeIds, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const displays = screen.getAllDisplays();
    const added = displays.filter((d) => !beforeIds.has(String(d.id)));
    if (added.length) {
      // Prefer a non-primary added display
      return added.find((d) => d.id !== screen.getPrimaryDisplay().id) || added[0];
    }
    await sleep(250);
  }
  return null;
}

async function resolveSourceForDisplay(display) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  let match = sources.find((s) => String(s.display_id) === String(display.id));
  if (!match) {
    match = sources[sources.length - 1] || sources[0];
  }
  if (!match) {
    // Last resort: synthesize a selectable descriptor so session can continue
    return {
      id: display.id,
      bounds: display.bounds,
      size: display.size,
      label: display.label || 'ScreenExtended Virtual',
      sourceId: null,
      sourceName: 'Virtual',
      thumbnail: '',
      isRemoteVirtual: true,
    };
  }
  return {
    id: display.id,
    bounds: display.bounds,
    size: display.size,
    label: display.label || 'ScreenExtended Virtual',
    sourceId: match.id,
    sourceName: match.name,
    thumbnail: match.thumbnail.isEmpty() ? '' : match.thumbnail.toDataURL(),
    isRemoteVirtual: true,
  };
}

async function createRemoteVirtualScreen() {
  virtualDisplay.ensureSettingsFile();

  // Always tear down first — never more than one ScreenExtended virtual monitor
  try {
    await virtualDisplay.setDisplayCount(0);
    await sleep(800);
  } catch { /* first run */ }

  const baselineIds = new Set(screen.getAllDisplays().map((d) => String(d.id)));
  await virtualDisplay.setDisplayCount(1); // max one virtual screen
  await forceExtendMode();
  await sleep(1500);

  const after = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const added = after.filter((d) => !baselineIds.has(String(d.id)) && d.id !== primaryId);

  let display = added.find((d) => d.bounds.width >= 1280 && d.bounds.height >= 720) || added[0] || null;

  if (!display) {
    display = after
      .filter((d) => d.id !== primaryId)
      .sort((a, b) => b.bounds.x - a.bounds.x)[0] || null;
  }

  if (!display) {
    throw new Error('Virtual display was created but Windows did not expose a monitor yet. Try again or reboot once after driver install.');
  }

  remoteVirtualDisplayId = display.id;
  remoteVirtualActive = true;

  const selected = await resolveSourceForDisplay(display);
  selectedScreen = selected;
  selectedSourceId = selected.sourceId;
  console.log('createRemoteVirtualScreen selected', selected.label, selected.id, selected.sourceId);
  broadcastInfo();

  closeMarkerWindow();
  try {
    markerWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      fullscreen: false,
      backgroundColor: '#1a8f7f',
      title: 'ScreenExtended Remote Screen',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    markerWindow.loadURL(
      'data:text/html,' +
        encodeURIComponent(`<!DOCTYPE html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#1a8f7f,#f0a35e);color:#fff;font-family:Segoe UI,sans-serif">
<div style="text-align:center"><h1 style="font-size:64px;margin:0">ScreenExtended</h1>
<p style="font-size:24px">Remote secondary screen (1 per client)</p></div></body></html>`),
    );
  } catch (err) {
    console.warn('marker window failed', err);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-screen-ready', selected);
  }

  return selected;
}

async function removeRemoteVirtualScreen() {
  closeMarkerWindow();
  remoteVirtualActive = false;
  remoteVirtualDisplayId = null;
  selectedScreen = null;
  selectedSourceId = null;
  try {
    if (await virtualDisplay.isDriverReady()) {
      await virtualDisplay.setDisplayCount(0);
    }
  } catch (err) {
    console.warn('remove virtual display failed', err);
  }
  broadcastInfo();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-screen-ready', null);
    mainWindow.webContents.send('stop-streaming');
  }
  return true;
}

/**
 * One virtual screen per viewer session:
 * connect → ensure exactly one screen
 * disconnect (no viewers left) → remove screen
 * reconnect → remove then add fresh screen
 */
function bindViewerSession(ws) {
  enqueueScreenOp(async () => {
    console.log('bindViewerSession start');
    if (remoteVirtualActive || activeViewerWs) {
      console.log('bindViewerSession removing previous');
      await removeRemoteVirtualScreen();
      await sleep(600);
    }
    activeViewerWs = ws;
    console.log('bindViewerSession creating screen');
    const selected = await createRemoteVirtualScreen();
    console.log('bindViewerSession created', selected && selected.label, selected && selected.id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('viewer-status', {
        connected: true,
        count: countViewers(),
        screenReady: true,
      });
      mainWindow.webContents.send('viewer-session', {
        connected: true,
        action: 'created',
        screen: selected,
      });
      mainWindow.webContents.send('viewer-ready');
      mainWindow.webContents.send('viewer-request-start');
    }
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'host-status',
        title: 'Remote screen ready',
        detail: 'A new virtual secondary screen was created for this session.',
        error: false,
      }));
    }
  });
}

function unbindViewerSession(ws) {
  enqueueScreenOp(async () => {
    if (activeViewerWs && activeViewerWs !== ws) return;
    activeViewerWs = null;
    // Only remove when no viewers remain
    if (countViewers() === 0) {
      await removeRemoteVirtualScreen();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('viewer-status', {
          connected: false,
          count: 0,
          screenReady: false,
        });
        mainWindow.webContents.send('viewer-session', {
          connected: false,
          action: 'removed',
        });
      }
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    title: 'ScreenExtended Host',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

function startServer() {
  const expressApp = express();
  expressApp.use('/viewer', express.static(path.join(__dirname, 'viewer')));
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
      openAtLogin: getOpenAtLogin(),
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
        if (msg.role === 'viewer') {
          // One client max: if another live viewer exists, reject this one
          const others = [...peers.entries()].filter(
            ([peer, role]) => peer !== ws && role === 'viewer' && peer.readyState === 1,
          );
          if (others.length > 0 && activeViewerWs && activeViewerWs !== ws && activeViewerWs.readyState === 1) {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: 'host-status',
                title: 'Host busy',
                detail: 'Only one viewer client is allowed. Disconnect the other laptop first.',
                error: true,
              }));
            }
            try { ws.close(); } catch { /* */ }
            return;
          }
          bindViewerSession(ws);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('viewer-status', {
              connected: true,
              count: countViewers(),
            });
          }
        }
        broadcastInfo();
        return;
      }

      if (msg.type === 'signal') {
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
        return;
      }

      if (msg.type === 'request-start') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('viewer-request-start');
        }
        // Acknowledge to the requesting viewer
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'host-status',
            title: 'Start requested',
            detail: 'Windows host received the request. If a screen is already selected, streaming should begin shortly.',
          }));
        }
        return;
      }
    });

    ws.on('close', () => {
      const role = peers.get(ws);
      peers.delete(ws);
      if (role === 'viewer') {
        unbindViewerSession(ws);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('viewer-status', {
          connected: countViewers() > 0,
          count: countViewers(),
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
    openAtLogin: getOpenAtLogin(),
    virtualDriverReady: await virtualDisplay.isDriverReady(),
    remoteVirtualActive,
    selected: selectedScreen,
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
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
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

  ipcMain.handle('get-open-at-login', async () => getOpenAtLogin());

  ipcMain.handle('set-open-at-login', async (_e, enabled) => applyOpenAtLogin(enabled));

  ipcMain.handle('virtual-driver-status', async () => ({
    ready: await virtualDisplay.isDriverReady(),
    remoteVirtualActive,
    selected: selectedScreen,
  }));

  ipcMain.handle('install-virtual-driver', async () => {
    const ok = await virtualDisplay.installDriverElevated();
    return { ready: ok };
  });

  ipcMain.handle('create-remote-screen', async () => createRemoteVirtualScreen());

  ipcMain.handle('remove-remote-screen', async () => removeRemoteVirtualScreen());

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

app.whenReady().then(async () => {
  // Ensure login item matches saved preference (default: ON after Windows restart)
  applyOpenAtLogin(getOpenAtLogin());

  // Clear leftover virtual monitors from previous sessions (max 0 until a viewer connects)
  try {
    if (await virtualDisplay.isDriverReady()) {
      await virtualDisplay.setDisplayCount(0);
      console.log('Cleared leftover virtual displays on startup');
    }
  } catch (err) {
    console.warn('startup virtual cleanup skipped', err);
  }

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const chosen = sources.find((s) => s.id === selectedSourceId) || sources[0];
      if (!chosen) {
        callback({});
        return;
      }
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

app.on('before-quit', () => {
  closeMarkerWindow();
  try { virtualDisplay.setDisplayCount(0); } catch { /* */ }
});
