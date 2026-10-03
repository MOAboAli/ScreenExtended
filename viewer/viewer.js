'use strict';

const remote = document.getElementById('remote');
const boot = document.getElementById('boot');
const bootDetail = document.getElementById('bootDetail');
const btnFs = document.getElementById('btnFs');

let ws = null;
let pc = null;
let capturingInput = false;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function normFromEvent(e) {
  const rect = remote.getBoundingClientRect();
  // Account for letterboxing from object-fit: contain
  const video = remote;
  const vw = video.videoWidth || rect.width;
  const vh = video.videoHeight || rect.height;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  const offX = rect.left + (rect.width - dispW) / 2;
  const offY = rect.top + (rect.height - dispH) / 2;
  const nx = (e.clientX - offX) / dispW;
  const ny = (e.clientY - offY) / dispH;
  return {
    nx: Math.min(1, Math.max(0, nx)),
    ny: Math.min(1, Math.max(0, ny)),
  };
}

function sendInput(data) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'input', data }));
}

function setupPeer() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.ontrack = (ev) => {
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    remote.srcObject = stream;
    remote.muted = false;
    remote.play().catch(() => {
      // Autoplay with sound may require a gesture on older Safari
      bootDetail.textContent = 'Tap the video / Enter fullscreen to unmute audio.';
    });
    boot.classList.add('hidden');
    document.body.classList.add('show-hud');
    setTimeout(() => document.body.classList.remove('show-hud'), 4000);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && ws?.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'signal',
        to: 'host',
        data: { candidate: e.candidate },
      }));
    }
  };
}

function connect() {
  bootDetail.textContent = `Connecting to ${location.host}…`;
  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'viewer' }));
    ws.send(JSON.stringify({ type: 'viewer-ready' }));
    bootDetail.textContent = 'Connected. Waiting for the Windows host to start streaming…';
  });

  ws.addEventListener('message', async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type !== 'signal' || !msg.data) return;
    const data = msg.data;

    if (!pc) setupPeer();

    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({
          type: 'signal',
          to: 'host',
          data: { sdp: pc.localDescription },
        }));
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch { /* ignore */ }
    }
  });

  ws.addEventListener('close', () => {
    boot.classList.remove('hidden');
    bootDetail.textContent = 'Disconnected from host. Reconnecting…';
    setTimeout(connect, 1500);
  });

  ws.addEventListener('error', () => {
    bootDetail.textContent = 'Could not reach host. Check the URL / firewall / same network.';
  });
}

function enableInputCapture() {
  capturingInput = true;
  remote.focus();
  document.body.classList.add('show-hud');
}

remote.addEventListener('click', () => {
  enableInputCapture();
  remote.muted = false;
  remote.play().catch(() => {});
});

remote.addEventListener('mousemove', (e) => {
  if (!capturingInput) return;
  const { nx, ny } = normFromEvent(e);
  sendInput({ type: 'mousemove', nx, ny });
});

remote.addEventListener('mousedown', (e) => {
  enableInputCapture();
  const { nx, ny } = normFromEvent(e);
  sendInput({ type: 'mousedown', nx, ny, button: e.button });
  e.preventDefault();
});

remote.addEventListener('mouseup', (e) => {
  const { nx, ny } = normFromEvent(e);
  sendInput({ type: 'mouseup', nx, ny, button: e.button });
  e.preventDefault();
});

remote.addEventListener('wheel', (e) => {
  if (!capturingInput) return;
  const { nx, ny } = normFromEvent(e);
  sendInput({ type: 'wheel', nx, ny, deltaY: e.deltaY });
  e.preventDefault();
}, { passive: false });

remote.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (!capturingInput) return;
  if (e.key === 'Escape' && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  sendInput({ type: 'keydown', key: e.key, code: e.code });
  e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (!capturingInput) return;
  sendInput({ type: 'keyup', key: e.key, code: e.code });
  e.preventDefault();
});

btnFs.addEventListener('click', async () => {
  try {
    await document.documentElement.requestFullscreen();
  } catch { /* older Safari may need webkit prefix */ }
  try {
    // @ts-ignore
    if (!document.fullscreenElement && document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen();
    }
  } catch { /* */ }
  remote.muted = false;
  await remote.play().catch(() => {});
  enableInputCapture();
});

setupPeer();
connect();
