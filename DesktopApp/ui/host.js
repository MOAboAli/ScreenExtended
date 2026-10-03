'use strict';

const statusPill = document.getElementById('statusPill');
const urlList = document.getElementById('urlList');
const metaLine = document.getElementById('metaLine');
const virtualMeta = document.getElementById('virtualMeta');
const remoteCard = document.getElementById('remoteCard');
const remoteThumb = document.getElementById('remoteThumb');
const remoteTitle = document.getElementById('remoteTitle');
const remoteDetails = document.getElementById('remoteDetails');
const preview = document.getElementById('preview');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnInstallDriver = document.getElementById('btnInstallDriver');
const btnLocalViewer = document.getElementById('btnLocalViewer');
const optVideo = document.getElementById('optVideo');
const optAudio = document.getElementById('optAudio');
const optAutoStart = document.getElementById('optAutoStart');

let bootstrap = null;
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

function showRemoteScreen(info) {
  selectedDisplay = info;
  selectedSource = info ? { id: info.sourceId, name: info.sourceName, display_id: info.id } : null;
  if (!info) {
    remoteCard.hidden = true;
    virtualMeta.textContent = 'Waiting for a viewer to connect…';
    btnStart.disabled = true;
    return;
  }
  remoteCard.hidden = false;
  remoteTitle.textContent = info.label || info.sourceName || 'Remote virtual screen';
  remoteDetails.textContent = `${info.bounds.width}×${info.bounds.height} @ (${info.bounds.x},${info.bounds.y})`;
  if (info.thumbnail) remoteThumb.src = info.thumbnail;
  virtualMeta.textContent = 'Viewer connected — one virtual secondary screen is active.';
  btnStart.disabled = !(wantsVideo() || wantsAudio());
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
  for (const track of localStream.getVideoTracks()) track.enabled = wantsVideo();
  for (const track of localStream.getAudioTracks()) track.enabled = wantsAudio();
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
    if (pc.connectionState === 'connected') setStatus(`Streaming ${streamStatusLabel()}`, true);
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
    setStatus(`Streaming ${streamStatusLabel()}`, true);
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
  setStatus(selectedSource ? 'Viewer connected — screen ready' : 'Idle');
}

function onStreamOptionChange() {
  applyTrackToggles();
  if (!streaming) {
    btnStart.disabled = !selectedSource || !(wantsVideo() || wantsAudio());
  }
}

async function init() {
  bootstrap = await window.hostAPI.getBootstrap();
  if (optAutoStart) optAutoStart.checked = bootstrap.openAtLogin !== false;
  renderUrls();
  connectSignaling();

  showRemoteScreen(bootstrap.selected?.isRemoteVirtual ? bootstrap.selected : null);

  if (!bootstrap.virtualDriverReady) {
    virtualMeta.textContent = 'Virtual display driver not detected. Click Install driver (Admin), then connect a viewer.';
  }

  window.hostAPI.onViewerStatus((data) => {
    metaLine.textContent = data.connected
      ? `Viewer connected (${data.count}/1). Virtual screen is managed automatically.`
      : 'No viewer connected — virtual screen removed.';
  });

  window.hostAPI.onViewerSession(async (data) => {
    if (data.action === 'created' && data.screen) {
      showRemoteScreen(data.screen);
      setStatus('Virtual screen created for viewer');
      // Auto stream for the new session
      if (streaming) await stopStreaming();
      await startStreaming();
    } else if (data.action === 'removed') {
      if (streaming) await stopStreaming();
      showRemoteScreen(null);
      setStatus('Idle');
    }
  });

  window.hostAPI.onRemoteScreenReady((info) => showRemoteScreen(info));

  window.hostAPI.onStopStreaming(async () => {
    if (streaming) await stopStreaming();
    showRemoteScreen(null);
  });

  window.hostAPI.onViewerReady(async () => {
    if (!selectedSource) return;
    if (!streaming) {
      await startStreaming();
      return;
    }
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

  window.hostAPI.onViewerRequestStart(async () => {
    if (!selectedSource) {
      setStatus('Waiting for virtual screen…');
      return;
    }
    if (!streaming) await startStreaming();
    else if (localStream) {
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
    }
  });

  if (optAutoStart) {
    optAutoStart.addEventListener('change', async () => {
      const enabled = await window.hostAPI.setOpenAtLogin(optAutoStart.checked);
      optAutoStart.checked = !!enabled;
    });
  }

  optVideo.addEventListener('change', onStreamOptionChange);
  optAudio.addEventListener('change', onStreamOptionChange);
  btnStart.addEventListener('click', startStreaming);
  btnStop.addEventListener('click', stopStreaming);
  btnInstallDriver.addEventListener('click', async () => {
    setStatus('Installing virtual display driver…');
    const res = await window.hostAPI.installVirtualDriver();
    setStatus(res.ready ? 'Virtual driver ready — connect a viewer' : 'Driver install unfinished — reboot and retry');
  });
  btnLocalViewer.addEventListener('click', () => window.hostAPI.openViewerLocal());
}

init().catch((err) => {
  console.error(err);
  setStatus(`Init failed: ${err.message || err}`);
});
