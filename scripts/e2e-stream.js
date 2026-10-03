'use strict';

/**
 * E2E: Electron host captures a display; a second Electron target loads the
 * Mac viewer and must receive a live video track.
 */

const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4789;
const DEBUG_PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function attachCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const handlers = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    for (const h of handlers) h(msg);
  });

  const ready = new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

  function send(method, params = {}, sessionId) {
    const msgId = ++id;
    const payload = { id: msgId, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  }

  function onEvent(fn) { handlers.push(fn); }

  return { ws, ready, send, onEvent };
}

async function main() {
  const electronBin = require('electron');
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: { ...process.env, SCREENEXTENDED_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  try {
    await waitFor(`http://127.0.0.1:${PORT}/api/info`);
    await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`);

    const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
    const hostPage = targets.find((t) => t.type === 'page');
    if (!hostPage?.webSocketDebuggerUrl) throw new Error('No host page');

    const host = attachCdp(hostPage.webSocketDebuggerUrl);
    await host.ready;
    await host.send('Runtime.enable');

    // Wait for source cards to render
    let cardCount = 0;
    for (let i = 0; i < 40; i++) {
      const n = await host.send('Runtime.evaluate', {
        returnByValue: true,
        expression: 'document.querySelectorAll(".source-card").length',
      });
      cardCount = n.result?.value || 0;
      if (cardCount > 0) break;
      await sleep(250);
    }
    console.log('CARDS', cardCount);
    if (!cardCount) throw new Error('No source cards rendered');

    const captureMsg = await host.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        try {
          const card = document.querySelector('.source-card');
          if (!card) return { ok:false, err:'no sources' };
          card.click();
          await new Promise(r => setTimeout(r, 400));
          document.getElementById('btnStart').click();
          await new Promise(r => setTimeout(r, 3500));
          const stream = document.getElementById('preview').srcObject;
          return {
            ok: !!(stream && stream.getVideoTracks().length),
            video: stream ? stream.getVideoTracks().length : 0,
            audio: stream ? stream.getAudioTracks().length : 0,
            status: document.getElementById('statusPill')?.textContent || ''
          };
        } catch (e) {
          return { ok:false, err: String(e) };
        }
      })()`,
    });
    const hostCapture = captureMsg?.result?.value;
    console.log('HOST_CAPTURE', JSON.stringify(hostCapture), 'RAW_KEYS', captureMsg && Object.keys(captureMsg));
    if (!hostCapture?.ok) {
      throw new Error('Desktop capture failed — grant screen permission / run interactively. ' + JSON.stringify(hostCapture || captureMsg));
    }

    // Open Mac viewer as a second Electron window
    await host.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: 'window.hostAPI.openViewerWindow()',
    });

    let viewerPage = null;
    for (let i = 0; i < 40; i++) {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      viewerPage = list.find((t) => t.type === 'page' && /\/viewer\/?/.test(t.url || ''));
      if (viewerPage?.webSocketDebuggerUrl) break;
      await sleep(250);
    }
    if (!viewerPage?.webSocketDebuggerUrl) throw new Error('Viewer window did not open');

    const viewerCdp = attachCdp(viewerPage.webSocketDebuggerUrl);
    await viewerCdp.ready;
    await viewerCdp.send('Runtime.enable');

    // Host re-offers on viewer-ready; wait for media
    await sleep(2000);

    // Nudge renegotiation in case offer raced
    await host.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const stop = document.getElementById('btnStop');
        if (stop && !stop.disabled) {
          stop.click();
          await new Promise((r) => setTimeout(r, 500));
        }
        document.getElementById('btnStart').click();
        await new Promise((r) => setTimeout(r, 2500));
        return true;
      })()`,
    });

    const viewer = await viewerCdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const video = document.getElementById('remote');
        for (let i = 0; i < 20; i++) {
          const stream = video.srcObject;
          if (stream && stream.getVideoTracks().some((t) => t.readyState === 'live')) {
            return {
              ok: true,
              tracks: stream.getTracks().map((t) => t.kind + ':' + t.readyState),
              detail: document.getElementById('bootDetail')?.textContent || '',
              bootHidden: document.getElementById('boot')?.classList.contains('hidden'),
            };
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return {
          ok: false,
          tracks: video.srcObject
            ? video.srcObject.getTracks().map((t) => t.kind + ':' + t.readyState)
            : [],
          detail: document.getElementById('bootDetail')?.textContent || '',
          bootHidden: document.getElementById('boot')?.classList.contains('hidden'),
        };
      })()`,
    });

    const viewerMedia = viewer?.result?.value;
    console.log('VIEWER_MEDIA', JSON.stringify(viewerMedia));
    if (!viewerMedia?.ok) throw new Error('Viewer did not receive WebRTC media: ' + JSON.stringify(viewerMedia));

    console.log('E2E OK: screen capture + viewer WebRTC media path works');
    host.ws.close();
    viewerCdp.ws.close();
  } finally {
    try { child.kill(); } catch { /* */ }
    await sleep(400);
    try { process.kill(child.pid); } catch { /* */ }
  }
}

main().catch((err) => {
  console.error('E2E FAIL:', err);
  process.exit(1);
});
