'use strict';

const statusPill = document.getElementById('statusPill');
const sourceGrid = document.getElementById('sourceGrid');
const urlList = document.getElementById('urlList');
const metaLine = document.getElementById('metaLine');
const preview = document.getElementById('preview');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnRefresh = document.getElementById('btnRefresh');
const btnLocalViewer = document.getElementById('btnLocalViewer');
const optVideo = document.getElementById('optVideo');
const optAudio = document.getElementById('optAudio');

let bootstrap = null;
let sources = [];
let displays = [];
let selectedSource = null;
let selectedDisplay = null;
let localStream = null;
let pc = null;
let ws = null;
let streaming = false;

function wantsVideo() {
  return !!optVideo.checked;
}

function wantsAudio() {
  return !!optAudio.checked;
}

function setStatus(text, live = false) {
  statusPill.textContent = text;
  statusPill.classList.toggle('live', live);
}

function streamStatusLabel() {
  const parts = [];
  if (wantsVideo()) parts.push('video');
  if (wantsAudio()) parts.push('audio');
  if (!parts.length) return 'Nothing selected to stream';
  return parts.join(' + ');
}

function matchDisplayForSource(source) {
  const byId = displays.find((d) => String(d.id) === String(source.display_id));
  if (byId) return byId;
  const m = /Screen\s+(\d+)/i.exec(source.name || '');
  if (m) {
    const idx = Number(m[1]) - 1;
    if (displays[idx]) return displays[idx];
  }
  return displays.find((d) => d.primary) || displays[0] || null;
}

async function refreshSources() {
  try {
    sources = await window.hostAPI.getSources();
    displays = await window.hostAPI.listDisplays();
  } catch (err) {
    console.error(err);
    setStatus(`Could not list screens: ${err.message || err}`);
    sources = [];
  }
  sourceGrid.innerHTML = '';

  if (!sources.length) {
    sourceGrid.innerHTML = '<p class="hint">No screens found. On Windows, allow desktop capture / screen recording for ScreenExtended, then click Refresh.</p>';
    return;
  }

  for (const source of sources) {
    const display = matchDisplayForSource(source);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'source-card' + (selectedSource?.id === source.id ? ' selected' : '');
    const thumb = source.thumbnail
      ? `<img alt="" src="${source.thumbnail}" />`
      : `<div style="aspect-ratio:16/9;background:#000;display:grid;place-items:center;color:#9bb0c1;font-size:12px">No preview</div>`;
    btn.innerHTML = `
      ${thumb}
      <div class="cap">
        ${source.name}
        <small>${display ? `${display.bounds.width}×${display.bounds.height} @ (${display.bounds.x},${display.bounds.y})` : 'Display'}</small>
      </div>
    `;
    btn.addEventListener('click', async () => {
      selectedSource = source;
      selectedDisplay = matchDisplayForSource(source);
      await window.hostAPI.setSelectedScreen(selectedDisplay ? {
        id: selectedDisplay.id,
        bounds: selectedDisplay.bounds,
        size: selectedDisplay.size,
        label: selectedDisplay.label,
        sourceId: source.id,
        sourceName: source.name,
      } : {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        sourceId: source.id,
        sourceName: source.name,
      });
      btnStart.disabled = !(wantsVideo() || wantsAudio());
      [...sourceGrid.children].forEach((c) => c.classList.remove('selected'));
      btn.classList.add('selected');
      setStatus(`Selected: ${source.name}`);
    });
    sourceGrid.appendChild(btn);
  }
}

function renderUrls() {
  urlList.innerHTML = '';
  for (const url of bootstrap.viewerUrlHints || []) {
    const li = document.createElement('li');
    li.textContent = url;
    urlList.appendChild(li);
  }
}

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://127.0.0.1:${bootstrap.port}/ws`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'host' }));
  });

  ws.addEventListener('message', async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'signal' && msg.data && pc) {
      const data = msg.data;
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({
            type: 'signal',
            to: 'viewer',
            data: { sdp: pc.localDescription },
          }));
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch { /* ignore late */ }
      }
    }
  });
}

function applyTrackToggles() {
  if (!localStream) return;
  for (const track of localStream.getVideoTracks()) {
    track.enabled = wantsVideo();
  }
  for (const track of localStream.getAudioTracks()) {
    track.enabled = wantsAudio();
  }
  if (streaming) {
    const label = streamStatusLabel();
    setStatus(label === 'Nothing selected to stream' ? 'Streaming paused (no A/V)' : `Streaming ${label}`, true);
  }
}

async function createPeer() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.onicecandidate = (e) => {
    if (e.candidate && ws?.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'signal',
        to: 'viewer',
        data: { candidate: e.candidate },
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus(`Streaming ${streamStatusLabel()}`, true);
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setStatus('Peer disconnected');
    }
  };

  applyTrackToggles();
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }
}

async function startCapture() {
  if (!selectedSource) return;

  await window.hostAPI.setCaptureOptions({ audio: wantsAudio() });

  // getDisplayMedia always needs a video surface; audio loopback is optional via main handler.
  // Unwanted tracks are disabled immediately so the Mac does not play them.
  localStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
    },
    audio: wantsAudio(),
  });
  applyTrackToggles();
  preview.srcObject = localStream;
  for (const track of localStream.getTracks()) {
    track.addEventListener('ended', () => {
      if (streaming) stopStreaming();
    });
  }
}

async function startStreaming() {
  if (streaming || !selectedSource) return;
  if (!wantsVideo() && !wantsAudio()) {
    setStatus('Enable video and/or audio first');
    return;
  }
  try {
    await startCapture();
    await createPeer();

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
      type: 'signal',
      to: 'viewer',
      data: { sdp: pc.localDescription },
    }));

    streaming = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    setStatus(`Waiting for Mac viewer… (${streamStatusLabel()})`);
  } catch (err) {
    console.error(err);
    setStatus(`Capture failed: ${err.message || err}`);
    await stopStreaming();
  }
}

async function stopStreaming() {
  streaming = false;
  btnStop.disabled = true;
  btnStart.disabled = !selectedSource || !(wantsVideo() || wantsAudio());

  if (pc) {
    try { pc.close(); } catch { /* */ }
    pc = null;
  }
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }
  preview.srcObject = null;
  setStatus('Idle');
}

function onStreamOptionChange() {
  applyTrackToggles();
  if (!streaming) {
    btnStart.disabled = !selectedSource || !(wantsVideo() || wantsAudio());
  }
}

async function init() {
  bootstrap = await window.hostAPI.getBootstrap();
  displays = bootstrap.displays || [];
  renderUrls();
  await refreshSources();
  connectSignaling();

  window.hostAPI.onViewerStatus((data) => {
    metaLine.textContent = data.connected
      ? `Viewer connected (${data.count}). Start streaming when ready.`
      : 'No viewer connected yet.';
  });

  window.hostAPI.onViewerReady(async () => {
    if (!streaming || !localStream) return;
    if (pc) {
      try { pc.close(); } catch { /* */ }
      pc = null;
    }
    await createPeer();
    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
      type: 'signal',
      to: 'viewer',
      data: { sdp: pc.localDescription },
    }));
  });

  optVideo.addEventListener('change', onStreamOptionChange);
  optAudio.addEventListener('change', onStreamOptionChange);
  btnStart.addEventListener('click', startStreaming);
  btnStop.addEventListener('click', stopStreaming);
  btnRefresh.addEventListener('click', refreshSources);
  btnLocalViewer.addEventListener('click', () => window.hostAPI.openViewerLocal());
}

init().catch((err) => {
  console.error(err);
  setStatus(`Init failed: ${err.message || err}`);
});
