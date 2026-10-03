'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4792;
const DEBUG = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listScreens() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.DeviceName + ':' + $_.Bounds.Width + 'x' + $_.Bounds.Height + '@' + $_.Bounds.X }) -join ' | '
`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
}

async function waitApi() {
  for (let i = 0; i < 60; i++) {
    try {
      const info = await fetch(`http://127.0.0.1:${PORT}/api/info`).then((r) => r.json());
      return info;
    } catch { await sleep(250); }
  }
  throw new Error('api timeout');
}

function connectViewer() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'viewer' }));
      ws.send(JSON.stringify({ type: 'viewer-ready' }));
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

(async () => {
  const electronBin = require('electron');
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${DEBUG}`], {
    cwd: ROOT,
    env: { ...process.env, SCREENEXTENDED_PORT: String(PORT), SCREENEXTENDED_ALLOW_MULTI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  try {
    await waitApi();
    await sleep(2500); // startup cleanup setDisplayCount(0)
    const before = listScreens();
    console.log('BEFORE', before);

    console.log('== connect viewer ==');
    const ws1 = await connectViewer();
    await sleep(12000);
    const mid = await waitApi();
    console.log('AFTER_CONNECT clients', mid.clients, 'selected', mid.selected?.label, mid.selected?.isRemoteVirtual);
    console.log('SCREENS', listScreens());
    if (!mid.selected?.isRemoteVirtual) throw new Error('expected virtual screen after connect');

    console.log('== disconnect viewer ==');
    ws1.close();
    await sleep(8000);
    const after = await waitApi();
    console.log('AFTER_DISCONNECT clients', after.clients, 'selected', after.selected);
    if (after.selected) throw new Error('virtual screen should be removed after disconnect');

    console.log('== reconnect viewer ==');
    const ws2 = await connectViewer();
    await sleep(12000);
    const again = await waitApi();
    console.log('AFTER_RECONNECT clients', again.clients, 'selected', again.selected?.label, again.selected?.isRemoteVirtual);
    if (!again.selected?.isRemoteVirtual) throw new Error('expected virtual screen after reconnect');

    // second viewer should be rejected / not create second screen
    console.log('== second viewer (should be busy) ==');
    let busy = false;
    const ws3 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((resolve) => {
      ws3.on('open', () => {
        ws3.send(JSON.stringify({ type: 'hello', role: 'viewer' }));
      });
      ws3.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'host-status' && msg.error) busy = true;
      });
      ws3.on('close', resolve);
      setTimeout(resolve, 3000);
    });
    console.log('second_viewer_rejected', busy);
    const final = await waitApi();
    console.log('FINAL clients', final.clients);

    ws2.close();
    await sleep(4000);
    console.log('LIFECYCLE_OK');
  } catch (e) {
    console.error('LIFECYCLE_FAIL', e);
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch { /* */ }
  }
})();
