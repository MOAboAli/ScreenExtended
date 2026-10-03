'use strict';

/**
 * Live end-to-end: start host (debuggable), add virtual screen, stream,
 * open viewer window, confirm live A/V tracks.
 */

const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4789;
const DEBUG_PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* */ }
    await sleep(250);
  }
  throw new Error('Timeout ' + url);
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
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
  };

  try {
    await waitFor(`http://127.0.0.1:${PORT}/api/info`);
    await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/list`);

    const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
    const hostPage = targets.find((t) => t.type === 'page');
    if (!hostPage?.webSocketDebuggerUrl) throw new Error('no host page');
    const host = attachCdp(hostPage.webSocketDebuggerUrl);
    await host.ready;
    await host.send('Runtime.enable');

    console.log('== Create remote virtual screen ==');
    const created = await evalPage(host, `(async () => {
      try {
        const info = await window.hostAPI.createRemoteScreen();
        return { ok: true, info };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    })()`);
    console.log('CREATE', JSON.stringify(created, null, 2));
    if (!created?.ok) throw new Error('create failed: ' + JSON.stringify(created));

    console.log('== Start streaming ==');
    const started = await evalPage(host, `(async () => {
      document.getElementById('optVideo').checked = true;
      document.getElementById('optAudio').checked = true;
      document.getElementById('btnStart').disabled = false;
      document.getElementById('btnStart').click();
      await new Promise(r => setTimeout(r, 4000));
      const stream = document.getElementById('preview').srcObject;
      return {
        ok: !!(stream && stream.getVideoTracks().length),
        video: stream ? stream.getVideoTracks().length : 0,
        audio: stream ? stream.getAudioTracks().length : 0,
        status: document.getElementById('statusPill')?.textContent || '',
      };
    })()`);
    console.log('START', started);
    if (!started?.ok) throw new Error('start failed');

    console.log('== Open viewer ==');
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

    // Renegotiate for late viewer
    await evalPage(host, `(async () => {
      const stop = document.getElementById('btnStop');
      if (stop && !stop.disabled) { stop.click(); await new Promise(r => setTimeout(r, 700)); }
      document.getElementById('btnStart').click();
      await new Promise(r => setTimeout(r, 2500));
      return true;
    })()`);

    const media = await evalPage(viewer, `(async () => {
      const video = document.getElementById('remote');
      for (let i = 0; i < 30; i++) {
        const stream = video.srcObject;
        if (stream && stream.getVideoTracks().some(t => t.readyState === 'live')) {
          return {
            ok: true,
            tracks: stream.getTracks().map(t => t.kind + ':' + t.readyState),
            bootHidden: document.getElementById('boot')?.classList.contains('hidden'),
            detail: document.getElementById('bootDetail')?.textContent || '',
          };
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return {
        ok: false,
        tracks: video.srcObject ? video.srcObject.getTracks().map(t => t.kind + ':' + t.readyState) : [],
        detail: document.getElementById('bootDetail')?.textContent || '',
      };
    })()`);
    console.log('VIEWER', media);
    if (!media?.ok) throw new Error('viewer no media');

    const info = await fetch(`http://127.0.0.1:${PORT}/api/info`).then((r) => r.json());
    console.log('API clients', info.clients, 'selected', info.selected?.label || info.selected?.sourceName);

    console.log('\nLIVE_OK url=http://127.0.0.1:' + PORT + '/viewer/');
    console.log('Host stays running. Press Ctrl+C to stop.');
    // Keep process/host alive indefinitely for manual browser use
    await new Promise(() => {});
  } catch (err) {
    console.error('LIVE_FAIL', err);
    try { child.kill(); } catch { /* */ }
    process.exit(1);
  }
}

main();
