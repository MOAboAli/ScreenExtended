'use strict';

const remote = document.getElementById('remote');
const boot = document.getElementById('boot');
const bootTitle = document.getElementById('bootTitle');
const bootDetail = document.getElementById('bootDetail');
const btnFs = document.getElementById('btnFs');
const btnRequest = document.getElementById('btnRequest');
const btnRetry = document.getElementById('btnRetry');

let ws = null;
let pc = null;
let capturingInput = false;
let connected = false;

function isFilePage() {
  return location.protocol === 'file:';
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function setBoot(title, detail, ok = false) {
  if (bootTitle) bootTitle.textContent = title;
  bootDetail.textContent = detail;
  boot.classList.toggle('error', !ok && !!detail);
}

function normFromEvent(e) {
  const rect = remote.getBoundingClientRect();
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
  if (pc) {
    try { pc.close(); } catch { /* */ }
  }
  // Prefer host candidates on LAN; STUN helps some routers
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.ontrack = (ev) => {
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    if (remote.srcObject !== stream) remote.srcObject = stream;
    else {
      try { remote.srcObject.addTrack(ev.track); } catch { /* already added */ }
    }
    remote.muted = false;
    const reveal = () => {
      boot.classList.add('hidden');
      document.body.classList.add('show-hud');
      setTimeout(() => document.body.classList.remove('show-hud'), 4000);
    };
    remote.play().then(reveal).catch(() => {
      setBoot('Stream arrived', 'Tap the video / Enter fullscreen to unmute audio.', true);
      reveal();
    });
    // Also reveal once frames actually decode
    const onMeta = () => {
      if (remote.videoWidth > 0) reveal();
    };
    remote.addEventListener('loadedmetadata', onMeta, { once: true });
    remote.addEventListener('playing', onMeta, { once: true });
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

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'connected') {
      boot.classList.add('hidden');
      return;
    }
    // Ignore transient failed if we already have live media
    const stream = remote.srcObject;
    const hasLive = stream && stream.getTracks().some((t) => t.readyState === 'live');
    if (state === 'failed' && !hasLive) {
      boot.classList.remove('hidden');
      setBoot(
        'Stream connection failed',
        'Signaling reached the PC, but media was blocked. On Windows run DesktopApp\\scripts\\Fix-Firewall.bat as Administrator, and use the same Wi‑Fi network.',
      );
    }
  };
}

async function checkApi() {
  try {
    const info = await fetch(`http://${location.host}/api/info`, { cache: 'no-store' }).then((r) => r.json());
    return info;
  } catch {
    return null;
  }
}

function connect() {
  if (isFilePage()) {
    setBoot(
      'Wrong way to open the viewer',
      'Do not open a copied HTML file. On the other laptop, open a browser and go to the URL shown in the Windows ScreenExtended Host app, for example http://192.168.x.x:4789/viewer/',
    );
    btnRequest.disabled = true;
    return;
  }

  connected = false;
  btnRequest.disabled = true;
  setBoot('Connecting…', `Trying ${location.host}…`, true);

  if (ws) {
    try { ws.close(); } catch { /* */ }
  }

  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', async () => {
    connected = true;
    btnRequest.disabled = false;
    ws.send(JSON.stringify({ type: 'hello', role: 'viewer' }));
    ws.send(JSON.stringify({ type: 'viewer-ready' }));
    const info = await checkApi();
    const selected = info?.selected?.sourceName || info?.selected?.label;
    setBoot(
      'Connected to Windows host',
      selected
        ? `Host selected “${selected}”. Tap “Start stream from host”, or click Start streaming on Windows.`
        : 'On Windows: choose a screen, then Start streaming — or tap “Start stream from host” after a screen is selected.',
      true,
    );
  });

  ws.addEventListener('message', async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'host-status') {
      setBoot(
        msg.title || 'Host update',
        msg.detail || '',
        !msg.error,
      );
      if (!msg.error) boot.classList.remove('hidden');
      return;
    }

    if (msg.type !== 'signal' || !msg.data) return;
    const data = msg.data;

    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      setupPeer();
    }

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
    connected = false;
    btnRequest.disabled = true;
    boot.classList.remove('hidden');
    setBoot(
      'Disconnected from host',
      'Check that ScreenExtended Host is running on Windows, you used http://IP:4789/viewer/ (not a file), same Wi‑Fi, and Windows Firewall allows it (run Fix-Firewall.bat as Admin). Reconnecting…',
    );
    setTimeout(connect, 2000);
  });

  ws.addEventListener('error', () => {
    setBoot(
      'Cannot reach Windows host',
      `Failed talking to ${location.host}. Common fixes: 1) Open the URL from the Host app (not a saved HTML). 2) Same network as the PC. 3) On Windows run DesktopApp\\scripts\\Fix-Firewall.bat as Administrator.`,
    );
  });
}

function requestStart() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'request-start' }));
  setBoot('Start requested', 'Ask sent to Windows host… waiting for stream…', true);
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
  } catch { /* */ }
  try {
    if (!document.fullscreenElement && document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen();
    }
  } catch { /* */ }
  remote.muted = false;
  await remote.play().catch(() => {});
  enableInputCapture();
});

btnRequest.addEventListener('click', requestStart);
btnRetry.addEventListener('click', () => {
  if (ws) try { ws.close(); } catch { /* */ }
  connect();
});

setupPeer();
connect();
