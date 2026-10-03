'use strict';

/**
 * Full DesktopApp quality gate:
 * - API + viewer assets
 * - WebSocket signaling
 * - Desktop capture (video+audio)
 * - Viewer receives live tracks
 * - Mid-stream audio/video toggles
 * - Auto-start setting IPC
 */

const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');

const ROOT = __dirname + '/..';
const PORT = 4791; // isolated from any manual host on 4789
const DEBUG_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* */ }
    await sleep(250);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function attachCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  function send(method, params = {}) {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  return { ws, ready, send };
}

async function evalPage(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function main() {
  const electronBin = require('electron');
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCREENEXTENDED_PORT: String(PORT),
      SCREENEXTENDED_ALLOW_MULTI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  const kill = async () => {
    try { child.kill(); } catch { /* */ }
    await sleep(400);
    try { process.kill(child.pid); } catch { /* */ }
  };

  try {
    console.log('== 1) API / viewer assets ==');
    await waitFor(`http://127.0.0.1:${PORT}/api/info`);
    const info = await fetch(`http://127.0.0.1:${PORT}/api/info`).then((r) => r.json());
    if (info.name !== 'ScreenExtended') throw new Error('bad api name');
    if (info.openAtLogin !== true && info.openAtLogin !== false) throw new Error('openAtLogin missing');
    const html = await fetch(`http://127.0.0.1:${PORT}/viewer/`).then((r) => r.text());
    if (!html.includes('ScreenExtended')) throw new Error('viewer html missing');
    console.log('OK api+viewer', { openAtLogin: info.openAtLogin, displays: info.displays?.length });

    console.log('== 2) WebSocket hello ==');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const t = setTimeout(() => reject(new Error('ws timeout')), 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'viewer' }));
        clearTimeout(t);
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    console.log('OK websocket');

    console.log('== 3) Attach host UI via CDP ==');
    await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    let hostPage = null;
    for (let i = 0; i < 40; i++) {
      const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      hostPage = targets.find((t) => t.type === 'page' && /ui[/\\]index\.html|ScreenExtended/i.test((t.url || '') + (t.title || '')))
        || targets.find((t) => t.type === 'page');
      if (hostPage?.webSocketDebuggerUrl) break;
      await sleep(250);
    }
    if (!hostPage?.webSocketDebuggerUrl) throw new Error('no host page');
    const host = attachCdp(hostPage.webSocketDebuggerUrl);
    await host.ready;
    await host.send('Runtime.enable');

    let cards = 0;
    for (let i = 0; i < 40; i++) {
      cards = await evalPage(host, 'document.querySelectorAll(".source-card").length');
      if (cards > 0) break;
      await sleep(250);
    }
    if (!cards) throw new Error('no source cards');
    console.log('OK sources', cards);

    console.log('== 4) Auto-start toggle ==');
    const autoBefore = await evalPage(host, 'document.getElementById("optAutoStart").checked');
    await evalPage(host, `(async () => {
      const el = document.getElementById('optAutoStart');
      el.checked = !el.checked;
      el.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 400));
      return el.checked;
    })()`);
    const autoAfterToggle = await evalPage(host, 'document.getElementById("optAutoStart").checked');
    // restore to true for product default
    await evalPage(host, `(async () => {
      const el = document.getElementById('optAutoStart');
      el.checked = true;
      el.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 300));
      return true;
    })()`);
    if (autoAfterToggle === autoBefore) throw new Error('auto-start toggle did not change');
    console.log('OK auto-start toggle', { autoBefore, autoAfterToggle, restored: true });

    console.log('== 5) Capture video+audio ==');
    const capture = await evalPage(host, `(async () => {
      document.querySelector('.source-card').click();
      await new Promise(r => setTimeout(r, 400));
      document.getElementById('optVideo').checked = true;
      document.getElementById('optAudio').checked = true;
      document.getElementById('btnStart').click();
      await new Promise(r => setTimeout(r, 3500));
      const stream = document.getElementById('preview').srcObject;
      return {
        ok: !!(stream && stream.getVideoTracks().length),
        video: stream ? stream.getVideoTracks().length : 0,
        audio: stream ? stream.getAudioTracks().length : 0,
        status: document.getElementById('statusPill')?.textContent || '',
        vEnabled: stream ? stream.getVideoTracks()[0]?.enabled : null,
        aEnabled: stream ? stream.getAudioTracks()[0]?.enabled : null,
      };
    })()`);
    console.log('CAPTURE', capture);
    if (!capture?.ok || capture.video < 1 || capture.audio < 1) {
      throw new Error('capture failed: ' + JSON.stringify(capture));
    }

    console.log('== 6) Mid-stream disable audio then video ==');
    const toggles = await evalPage(host, `(async () => {
      const stream = document.getElementById('preview').srcObject;
      document.getElementById('optAudio').checked = false;
      document.getElementById('optAudio').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 200));
      const audioOff = stream.getAudioTracks()[0]?.enabled === false;
      document.getElementById('optVideo').checked = false;
      document.getElementById('optVideo').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 200));
      const videoOff = stream.getVideoTracks()[0]?.enabled === false;
      document.getElementById('optVideo').checked = true;
      document.getElementById('optAudio').checked = true;
      document.getElementById('optVideo').dispatchEvent(new Event('change'));
      document.getElementById('optAudio').dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 200));
      return {
        audioOff, videoOff,
        restoredV: stream.getVideoTracks()[0]?.enabled === true,
        restoredA: stream.getAudioTracks()[0]?.enabled === true,
      };
    })()`);
    console.log('TOGGLES', toggles);
    if (!toggles.audioOff || !toggles.videoOff || !toggles.restoredV || !toggles.restoredA) {
      throw new Error('A/V toggles failed: ' + JSON.stringify(toggles));
    }

    console.log('== 7) Viewer receives live media ==');
    await evalPage(host, 'window.hostAPI.openViewerWindow()');
    let viewerPage = null;
    for (let i = 0; i < 40; i++) {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      viewerPage = list.find((t) => t.type === 'page' && /\/viewer\/?/.test(t.url || ''));
      if (viewerPage?.webSocketDebuggerUrl) break;
      await sleep(250);
    }
    if (!viewerPage) throw new Error('viewer window missing');
    const viewer = attachCdp(viewerPage.webSocketDebuggerUrl);
    await viewer.ready;
    await viewer.send('Runtime.enable');

    // Restart stream so viewer-ready renegotiation is clean
    await evalPage(host, `(async () => {
      const stop = document.getElementById('btnStop');
      if (stop && !stop.disabled) {
        stop.click();
        await new Promise(r => setTimeout(r, 700));
      }
      document.getElementById('optVideo').checked = true;
      document.getElementById('optAudio').checked = true;
      document.getElementById('btnStart').click();
      await new Promise(r => setTimeout(r, 2500));
      return true;
    })()`);

    const media = await evalPage(viewer, `(async () => {
      const video = document.getElementById('remote');
      for (let i = 0; i < 24; i++) {
        const stream = video.srcObject;
        if (stream && stream.getVideoTracks().some(t => t.readyState === 'live')) {
          return {
            ok: true,
            tracks: stream.getTracks().map(t => t.kind + ':' + t.readyState),
            bootHidden: document.getElementById('boot')?.classList.contains('hidden'),
          };
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return {
        ok: false,
        tracks: video.srcObject ? video.srcObject.getTracks().map(t => t.kind+':'+t.readyState) : [],
        detail: document.getElementById('bootDetail')?.textContent || '',
      };
    })()`);
    console.log('VIEWER', media);
    if (!media?.ok) throw new Error('viewer media failed: ' + JSON.stringify(media));
    if (!media.tracks.some((t) => t.startsWith('audio:live'))) {
      throw new Error('viewer missing live audio: ' + JSON.stringify(media));
    }

    console.log('== 8) Stop streaming cleans up ==');
    const stopped = await evalPage(host, `(async () => {
      document.getElementById('btnStop').click();
      await new Promise(r => setTimeout(r, 800));
      return {
        streamingBtn: document.getElementById('btnStart').disabled === false,
        stopDisabled: document.getElementById('btnStop').disabled === true,
        previewGone: document.getElementById('preview').srcObject == null,
        status: document.getElementById('statusPill')?.textContent || '',
      };
    })()`);
    console.log('STOP', stopped);
    if (!stopped.stopDisabled || !stopped.previewGone) {
      throw new Error('stop cleanup failed: ' + JSON.stringify(stopped));
    }

    host.ws.close();
    viewer.ws.close();
    console.log('\nALL CHECKS PASSED — DesktopApp runs great');
  } finally {
    await kill();
  }
}

main().catch(async (err) => {
  console.error('\nDESKTOPAPP TEST FAIL:', err);
  process.exit(1);
});
