'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const electronBin = require('electron');
  const child = spawn(electronBin, ['.', '--remote-debugging-port=9222'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  try {
    for (let i = 0; i < 40; i++) {
      try {
        await fetch('http://127.0.0.1:4789/api/info');
        await fetch('http://127.0.0.1:9222/json/list');
        break;
      } catch {
        await sleep(250);
      }
    }

    const targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
    console.log('TARGETS', targets.map((t) => ({ type: t.type, title: t.title, url: t.url })));
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

    await send('Runtime.enable');

    let cardCount = 0;
    for (let i = 0; i < 40; i++) {
      const cards = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: 'document.querySelectorAll(".source-card").length',
      });
      cardCount = cards.result?.result?.value ?? cards.result?.value ?? 0;
      // CDP wraps differently depending on path
      if (typeof cards.result?.value === 'number') cardCount = cards.result.value;
      if (cardCount > 0) break;
      await sleep(250);
    }
    console.log('CARDS', cardCount);

    await send('Runtime.evaluate', {
      expression: 'document.querySelector(".source-card") && document.querySelector(".source-card").click()',
    });
    await sleep(500);

    const start = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        try {
          const btn = document.getElementById('btnStart');
          const disabled = btn.disabled;
          btn.click();
          await new Promise((r) => setTimeout(r, 4500));
          const stream = document.getElementById('preview').srcObject;
          return {
            disabledBeforeClick: disabled,
            status: document.getElementById('statusPill')?.textContent || '',
            hasStream: !!stream,
            video: stream ? stream.getVideoTracks().length : 0,
            audio: stream ? stream.getAudioTracks().length : 0,
            meta: document.getElementById('metaLine')?.textContent || '',
          };
        } catch (e) {
          return { err: String(e), stack: e.stack };
        }
      })()`,
    });
    console.log('START', JSON.stringify(start, null, 2));
    ws.close();
  } finally {
    child.kill();
    await sleep(300);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
