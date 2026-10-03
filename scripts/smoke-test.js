'use strict';

/**
 * Smoke test: boots a lightweight copy of the signaling/static server
 * (without Electron) and verifies viewer HTML + WebSocket hello relay.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = 4790;

async function main() {
  const app = express();
  app.use('/viewer', express.static(path.join(__dirname, '..', 'viewer')));
  app.get('/api/info', (_req, res) => {
    res.json({ ok: true, name: 'ScreenExtended' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const peers = new Map();

  wss.on('connection', (ws) => {
    peers.set(ws, 'unknown');
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello') peers.set(ws, msg.role);
      if (msg.type === 'signal') {
        for (const [peer, role] of peers.entries()) {
          if (peer !== ws && role !== peers.get(ws) && peer.readyState === 1) {
            peer.send(JSON.stringify({ type: 'signal', data: msg.data }));
          }
        }
      }
    });
    ws.on('close', () => peers.delete(ws));
  });

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const info = await fetch(`http://127.0.0.1:${PORT}/api/info`).then((r) => r.json());
  if (!info.ok) throw new Error('api/info failed');

  const html = await fetch(`http://127.0.0.1:${PORT}/viewer/`).then((r) => r.text());
  if (!html.includes('ScreenExtended')) throw new Error('viewer html missing');

  const js = await fetch(`http://127.0.0.1:${PORT}/viewer/viewer.js`).then((r) => r.text());
  if (!js.includes('RTCPeerConnection')) throw new Error('viewer.js missing');

  const hostWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const viewerWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

  await Promise.all([
    new Promise((r, j) => { hostWs.once('open', r); hostWs.once('error', j); }),
    new Promise((r, j) => { viewerWs.once('open', r); viewerWs.once('error', j); }),
  ]);

  const got = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('signal timeout')), 3000);
    viewerWs.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'signal' && msg.data?.ping === 1) {
        clearTimeout(t);
        resolve(true);
      }
    });
  });

  hostWs.send(JSON.stringify({ type: 'hello', role: 'host' }));
  viewerWs.send(JSON.stringify({ type: 'hello', role: 'viewer' }));
  await new Promise((r) => setTimeout(r, 100));
  hostWs.send(JSON.stringify({ type: 'signal', data: { ping: 1 } }));
  await got;

  hostWs.close();
  viewerWs.close();
  server.close();

  console.log('SMOKE OK: viewer assets + websocket signaling work');
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
