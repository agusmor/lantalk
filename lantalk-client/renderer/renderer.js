// Renderer process. Handles connecting to the relay, text chat, and
// voice: one RTCPeerConnection per other participant, signaled through
// the same WebSocket used for chat and roster events.

const DEFAULT_PORT = 51000;
const DISCOVERY_PORT = 51001;
const DISCOVERY_WINDOW_MS = 2500;
const DISCOVERY_RETRY_MS = 500;

let ws = null;
let myId = null;
let myName = null;
let localStream = null;
let screenStream = null;
let muted = false;
let deafened = false;
let voiceActive = false;
let sharing = false;
let sharePending = false;
let lastSearchRequestId = 0;
const peers = new Map(); // id -> { name, pc, audioEl, videoEl }

// Pure LAN/ZeroTier: no NAT to punch through, so no STUN/TURN needed.
const ICE_CONFIG = { iceServers: [] };

// Accepts "192.168.1.50", "192.168.1.50:51000", "localhost", or
// "localhost:51000". If no port is given, DEFAULT_PORT is assumed.
function normalizeServerAddr(raw) {
  const addr = raw.trim();
  if (!addr) return null;
  // host:port already present (last colon separates host from port)
  if (/:\d+$/.test(addr)) return addr;
  return `${addr}:${DEFAULT_PORT}`;
}

// --- element refs ---
const connectScreen = document.getElementById('connect-screen');
const chatScreen = document.getElementById('chat-screen');
const nameInput = document.getElementById('name-input');
const serverInput = document.getElementById('server-input');
const connectBtn = document.getElementById('connect-btn');
const statusEl = document.getElementById('status');
const peerCountEl = document.getElementById('peer-count');
const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send');
const discoveryStatusEl = document.getElementById('discovery-status');
const discoveredListEl = document.getElementById('discovered-servers');
const muteBtn = document.getElementById('mute-btn');
const deafBtn = document.getElementById('deafen-btn');
const voiceBtn = document.getElementById('voice-btn');
const shareBtn = document.getElementById('share-btn');
const screenTilesEl = document.getElementById('screen-tiles');
const audioContainerEl = document.getElementById('audio-container');
const searchToggleBtn = document.getElementById('search-toggle-btn');
const searchPanelEl = document.getElementById('search-panel');
const searchInputEl = document.getElementById('search-input');
const searchCloseBtn = document.getElementById('search-close-btn');
const searchResultsEl = document.getElementById('search-results');

// --- persistent identity -------------------------------------------
// A small UUID generated once and stored on disk, sent alongside 'join'
// so the server (and thus chat history) can recognize "this is the same
// person" across separate connections/sessions — connection ids reset
// to 1 on every server restart, so they can't be used for that. This is
// a claimed identity, not a verified one: there's no auth in this app,
// so nothing stops someone from editing their own identity.json to
// claim a different clientId. Fine for a trusted LAN/friend group,
// worth remembering if that trust model ever changes.
//
// The config file lives beside the app's executable, which only the
// main process can actually determine (app.isPackaged / the real
// process.execPath aren't available in the renderer) — so this starts
// with an IPC round-trip, and everything that depends on `identity`
// awaits `identityReady` first.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcRenderer } = require('electron');

let identity = null;
let identityFilePath = null;

function loadIdentity() {
  try {
    return JSON.parse(fs.readFileSync(identityFilePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveIdentity(value) {
  if (!identityFilePath) return;
  try {
    fs.mkdirSync(path.dirname(identityFilePath), { recursive: true });
    fs.writeFileSync(identityFilePath, JSON.stringify(value, null, 2));
  } catch (err) {
    console.error('[identity] failed to save:', err.message);
  }
}

const identityReady = (async () => {
  const configDir = await ipcRenderer.invoke('get-config-dir');
  identityFilePath = path.join(configDir, 'identity.json');

  identity = loadIdentity();
  if (!identity) {
    identity = { clientId: crypto.randomUUID(), lastUsername: '', lastServerAddr: '' };
    saveIdentity(identity);
  }
  nameInput.value = identity.lastUsername || '';
  serverInput.value = identity.lastServerAddr || '';
  if (identity.lastServerAddr) {
    attemptConnect(identity.lastServerAddr);
  }
})();

// --- discovery -------------------------------------------------------
// Broadcasts a small UDP packet asking "any LanTalk servers out there?"
// on every local network interface (so it reaches plain LAN and a
// ZeroTier interface alike), then listens for replies for a short
// window and renders a button per unique server found.

const dgram = require('dgram');

function localBroadcastAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address.split('.').map(Number);
      const mask = net.netmask.split('.').map(Number);
      const bcast = ip.map((octet, i) => octet | (~mask[i] & 255));
      addrs.push(bcast.join('.'));
    }
  }
  // Fallback in case no usable interface was found (unlikely, but cheap to cover).
  if (addrs.length === 0) addrs.push('255.255.255.255');
  return [...new Set(addrs)];
}

function startDiscovery() {
  const found = new Map(); // "address:port" -> { address, port, name }
  const socket = dgram.createSocket('udp4');

  socket.on('error', (err) => {
    console.error('[discovery] socket error:', err.message);
  });

  socket.on('message', (raw, rinfo) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'lantalk-announce' || !msg.port) return;

    const key = `${rinfo.address}:${msg.port}`;
    if (found.has(key)) return;
    found.set(key, { address: rinfo.address, port: msg.port, name: msg.name || rinfo.address });
    renderDiscoveredServers(found);
  });

  socket.bind(0, () => {
    socket.setBroadcast(true);
    sendDiscoveryPing(socket);
    // A couple of retries in case the first packet is lost or a server
    // was still starting up when it arrived.
    const retryTimer = setInterval(() => sendDiscoveryPing(socket), DISCOVERY_RETRY_MS);

    setTimeout(() => {
      clearInterval(retryTimer);
      socket.close();
      discoveryStatusEl.textContent = found.size > 0
        ? `Found ${found.size} server${found.size === 1 ? '' : 's'}:`
        : 'No servers found automatically — enter an address manually.';
    }, DISCOVERY_WINDOW_MS);
  });
}

function sendDiscoveryPing(socket) {
  const payload = Buffer.from(JSON.stringify({ type: 'lantalk-discover' }));
  for (const bcast of localBroadcastAddresses()) {
    socket.send(payload, DISCOVERY_PORT, bcast, (err) => {
      if (err) console.error(`[discovery] send to ${bcast} failed:`, err.message);
    });
  }
}

function renderDiscoveredServers(found) {
  discoveredListEl.innerHTML = '';
  for (const server of found.values()) {
    const btn = document.createElement('button');
    btn.className = 'server-btn';
    btn.innerHTML = `<span class="server-name"></span><span class="server-addr"></span>`;
    btn.querySelector('.server-name').textContent = server.name;
    btn.querySelector('.server-addr').textContent = `${server.address}:${server.port}`;
    btn.onclick = () => {
      serverInput.value = `${server.address}:${server.port}`;
      connectBtn.click();
    };
    discoveredListEl.appendChild(btn);
  }
  discoveryStatusEl.textContent = `Found ${found.size} server${found.size === 1 ? '' : 's'}:`;
}

startDiscovery();

// --- connect ---

connectBtn.onclick = async () => {
  await identityReady;
  myName = nameInput.value.trim() || 'Anonymous';
  identity.lastUsername = myName;
  saveIdentity(identity);

  const addr = normalizeServerAddr(serverInput.value);
  if (!addr) {
    statusEl.textContent = 'Enter a server address.';
    return;
  }
  attemptConnect(addr);
};

async function attemptConnect(addr) {
  connectBtn.disabled = true;
  statusEl.textContent = `Connecting to ${addr}…`;

  ws = new WebSocket(`ws://${addr}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name: myName, clientId: identity.clientId }));
  };

  ws.onerror = () => {
    statusEl.textContent = 'Could not connect. Check the address and that the server is running.';
    connectBtn.disabled = false;
  };

  ws.onclose = () => {
    for (const id of peers.keys()) closePeerConnection(id);
    peers.clear();
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    voiceActive = false;
    if (chatScreen.style.display !== 'none') {
      appendSystemMessage('Disconnected from server.');
    } else {
      statusEl.textContent = 'Connection closed.';
      connectBtn.disabled = false;
    }
  };

  ws.onmessage = (event) => {
    handleMessage(JSON.parse(event.data));
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.yourId;
      for (const p of msg.peers) {
        peers.set(p.id, { name: p.name, pc: null, audioEl: null, videoEl: null, videoTileEl: null });
      }
      showChatScreen();
      appendSystemMessage(`Connected as ${myName}.`);
      updatePeerCount();
      identity.lastServerAddr = lastAttemptedAddr;
      saveIdentity(identity);
      break;

    case 'peer-joined':
      peers.set(msg.id, { name: msg.name, pc: null, audioEl: null, videoEl: null, videoTileEl: null });
      appendSystemMessage(`${msg.name} joined.`);
      updatePeerCount();
      break;

    case 'peer-left': {
      const entry = peers.get(msg.id);
      const name = entry ? entry.name : 'Someone';
      closePeerConnection(msg.id);
      peers.delete(msg.id);
      appendSystemMessage(`${name} left.`);
      updatePeerCount();
      break;
    }

    case 'chat':
      appendChatMessage(msg.name, msg.text, msg.clientId === identity.clientId, msg.ts);
      break;

    case 'signal': {
      const entry = peers.get(msg.from);
      if (!entry) break;
      // Serialize per-peer signaling. The WebSocket delivers messages in
      // order, but without this, a fast-following ICE candidate can start
      // processing before the offer/answer right before it has finished
      // (both are async) — which is exactly how "remote description was
      // null" happens even though nothing was actually reordered or lost.
      entry.signalChain = (entry.signalChain || Promise.resolve())
        .then(() => handleSignal(msg.from, msg.data))
        .catch((err) => console.error(`[voice] queued signal failed for ${entry.name}:`, err.message));
      break;
    }

    // Reply to our own 'voice-join': everyone already in voice, so we
    // initiate a connection to each of them.
    case 'voice-peers':
      for (const id of msg.peers) {
        if (peers.has(id)) createPeerConnection(id, true);
      }
      break;

    // Someone else just turned voice on. If we're in voice too, wait
    // for their offer — they're the one initiating, mirroring how
    // 'voice-peers' works from their side.
    case 'peer-voice-on':
      if (voiceActive && peers.has(msg.id)) createPeerConnection(msg.id, false);
      break;

    // Someone turned voice off without leaving the server entirely —
    // tear down just the media connection, keep them in the chat roster.
    case 'peer-voice-off':
      closePeerConnection(msg.id);
      break;

    case 'chat-history':
      for (const m of msg.messages) {
        appendChatMessage(m.name, m.text, m.clientId === identity.clientId, m.ts);
      }
      break;

    case 'chat-search-results':
      if (msg.requestId === lastSearchRequestId) renderSearchResults(msg.results);
      break;
  }
}

function showChatScreen() {
  connectScreen.style.display = 'none';
  chatScreen.style.display = '';
  chatInput.focus();
}

function updatePeerCount() {
  const count = peers.size + 1; // +1 for yourself
  peerCountEl.textContent = `${count} online`;
}

// --- voice -------------------------------------------------------------
// One RTCPeerConnection per other participant (full mesh). The relay
// server only ever sees the signaling messages below (SDP + ICE
// candidates) — once a connection is up, audio flows directly between
// the two machines.

function createPeerConnection(id, isInitiator) {
  const entry = peers.get(id);
  if (!entry || entry.pc) return; // unknown peer, or connection already exists

  const pc = new RTCPeerConnection(ICE_CONFIG);
  entry.pc = pc;

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }
  // Someone joining voice after we already started sharing still needs
  // the screen track added to their (new) connection specifically.
  if (sharing && screenStream) {
    for (const track of screenStream.getTracks()) pc.addTrack(track, screenStream);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(id, { candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    if (e.track.kind === 'audio') {
      attachRemoteAudio(id, e.streams[0]);
    } else if (e.track.kind === 'video') {
      attachRemoteVideo(id, e.streams[0]);
    }
  };

  entry.polite = !isInitiator;
  entry.makingOffer = false;

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      console.warn(`[voice] connection to ${entry.name} failed`);
    }
  };

  // The single place offers get created now — for the initial
  // handshake, for adding/removing the screen track, and for a peer
  // who joins after we're already sharing (their first answer can't
  // carry our extra video track; the browser flags that here).
  pc.onnegotiationneeded = async () => {
    if (pc.signalingState !== 'stable') return;
    try {
      entry.makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(id, { sdp: pc.localDescription });
    } catch (err) {
      console.error(`[voice] negotiation failed for ${entry.name}:`, err.message);
    } finally {
      entry.makingOffer = false;
    }
  };
}

function sendSignal(to, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'signal', to, data }));
}

async function handleSignal(fromId, data) {
  const entry = peers.get(fromId);
  if (!entry) return;
  if (!entry.pc) createPeerConnection(fromId, false);
  const pc = entry.pc;

  try {
    if (data.sdp) {
      const isOffer = data.sdp.type === 'offer';
      const collision = isOffer && (entry.makingOffer || pc.signalingState !== 'stable');
      entry.ignoredOffer = collision && !entry.polite;
      if (entry.ignoredOffer) return;
      if (collision) await pc.setLocalDescription({ type: 'rollback' });

      await pc.setRemoteDescription(data.sdp);
      if (isOffer) {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(fromId, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        // Expected/benign if this candidate belonged to an offer we
        // just deliberately ignored — anything else is worth knowing about.
        if (!entry.ignoredOffer) {
          console.warn(`[voice] ICE candidate error for ${entry.name}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error(`[voice] signal handling failed for ${entry.name}:`, err.message);
  }
}

function attachRemoteAudio(id, stream) {
  const entry = peers.get(id);
  if (!entry) return;
  if (!entry.audioEl) {
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.muted = deafened;
    audioContainerEl.appendChild(audioEl);
    entry.audioEl = audioEl;
  }
  entry.audioEl.srcObject = stream;
}

function attachRemoteVideo(id, stream) {
  const entry = peers.get(id);
  if (!entry) return;

  if (!entry.videoEl) {
    const tile = document.createElement('div');
    tile.className = 'screen-tile';
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-label"></div>
      <div class="tile-controls">
        <button class="tile-btn fullscreen-btn" title="Fullscreen">⛶</button>
        <button class="tile-btn pip-btn" title="Pop out">🗗</button>
      </div>
    `;
    tile.querySelector('.tile-label').textContent = `${entry.name}'s screen`;

    const videoEl = tile.querySelector('video');

    // This is a live stream, not a recording — there's no meaningful
    // paused state. Fullscreen adds native click/spacebar pause handling
    // automatically that we don't want, so just resume immediately
    // whenever anything pauses it.
    videoEl.addEventListener('pause', () => {
      // Jump to the live edge before resuming — in case anything buffered
      // up while paused, this stops repeated pause/resume from letting the
      // displayed frame drift further behind real time each time.
      if (videoEl.buffered.length > 0) {
        videoEl.currentTime = videoEl.buffered.end(videoEl.buffered.length - 1);
      }
      videoEl.play().catch(() => {});
    });

    tile.querySelector('.fullscreen-btn').onclick = () => toggleFullscreen(videoEl);

    tile.querySelector('.pip-btn').onclick = () => togglePopout(entry, tile);

    screenTilesEl.appendChild(tile);
    entry.videoEl = videoEl;
    entry.videoTileEl = tile;
  }
  entry.videoEl.srcObject = stream;
  updateScreenTilesVisibility();

  // A track can be removed from an already-connected peer via
  // renegotiation (they stopped sharing) without a new 'track' event
  // ever firing — that only fires when a track is added. Watching the
  // stream itself for 'removetrack' is how we notice it's gone.
  stream.addEventListener('removetrack', () => {
    if (stream.getVideoTracks().length === 0) removeRemoteVideoTile(id);
  });
}

function toggleFullscreen(videoEl) {
  if (document.fullscreenElement === videoEl) {
    document.exitFullscreen();
  } else {
    videoEl.requestFullscreen().catch((err) => {
      console.error('[screen share] fullscreen failed:', err.message);
    });
  }
}


// A genuine separate OS window can't carry a live WebRTC video track in
// Electron (each BrowserWindow is its own process, nothing serializes a
// MediaStream across that boundary), and Document Picture-in-Picture
// doesn't reliably work inside an Electron window either — the request
// just hangs forever with no error, which is why nothing happened
// before. This is a floating panel in the same window instead: it can
// still be dragged, maximized, and made fullscreen, and closing it just
// puts the video back in its tile.
function togglePopout(entry, tile) {
  if (entry.popoutEl) {
    closePopout(entry);
    return;
  }

  const videoEl = entry.videoEl;
  const popout = document.createElement('div');
  popout.className = 'popout';
  popout.innerHTML = `
    <div class="popout-header">
      <span class="popout-title"></span>
      <div class="popout-actions">
        <button class="popout-fs-btn" title="Fullscreen">⛶</button>
        <button class="popout-max-btn" title="Maximize">⬜</button>
        <button class="popout-close-btn" title="Close">✕</button>
      </div>
    </div>
    <div class="popout-body"></div>
  `;
  popout.querySelector('.popout-title').textContent = `${entry.name}'s screen`;
  popout.querySelector('.popout-body').appendChild(videoEl);
  document.body.appendChild(popout);
  entry.popoutEl = popout;

  popout.style.top = '60px';
  popout.style.left = '60px';

  makeDraggable(popout, popout.querySelector('.popout-header'));

  popout.querySelector('.popout-fs-btn').onclick = () => toggleFullscreen(videoEl);
  popout.querySelector('.popout-max-btn').onclick = () => {
    popout.classList.toggle('maximized');
  };
  popout.querySelector('.popout-close-btn').onclick = () => closePopout(entry);
}

function closePopout(entry) {
  if (!entry.popoutEl) return;
  const videoEl = entry.videoEl;
  entry.popoutEl.remove();
  entry.popoutEl = null;
  if (entry.videoTileEl) entry.videoTileEl.insertBefore(videoEl, entry.videoTileEl.firstChild);
}

function makeDraggable(el, handle) {
  let dragging = false, startX, startY, startLeft, startTop;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = el.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    el.style.left = `${startLeft + (e.clientX - startX)}px`;
    el.style.top = `${startTop + (e.clientY - startY)}px`;
  });
  window.addEventListener('mouseup', () => { dragging = false; });
}

function removeRemoteVideoTile(id) {
  const entry = peers.get(id);
  if (!entry || !entry.videoTileEl) return;
  entry.videoTileEl.remove();
  entry.videoEl = null;
  entry.videoTileEl = null;
  updateScreenTilesVisibility();
}

function updateScreenTilesVisibility() {
  screenTilesEl.style.display = screenTilesEl.children.length > 0 ? 'flex' : 'none';
}

function closePeerConnection(id) {
  const entry = peers.get(id);
  if (!entry) return;
  if (entry.pc) entry.pc.close();
  if (entry.audioEl) entry.audioEl.remove();
  if (entry.videoTileEl) entry.videoTileEl.remove();
  // Reset so a later voice-on for this same peer can open a fresh
  // connection instead of being skipped as "already exists".
  if (entry.popoutEl) { entry.popoutEl.remove(); entry.popoutEl = null; }
  entry.pc = null;
  entry.audioEl = null;
  entry.videoEl = null;
  entry.videoTileEl = null;
  updateScreenTilesVisibility();
}

// --- voice join/leave (separate from chat join) -------------------

voiceBtn.onclick = () => {
  if (voiceActive) leaveVoice();
  else joinVoice();
};

// Chromium's own audio processing pipeline, requested as constraints —
// no extra dependency, works because Electron's renderer is Chromium.
// noiseSuppression here is Chromium's built-in ML-based suppressor.
//
// Planned: make this switchable in the UI between "Built-in" / "RNNoise"
// / "DeepFilterNet" (and off). Whichever is picked would replace this
// constraint with an AudioWorklet stage inserted between the raw mic
// stream and localStream — nothing downstream (signaling, peer
// connections, roster) needs to know or care which one is active, since
// they only ever consume whatever localStream ends up being.
// Planned: expose these three as individual toggles in a settings panel
// instead of hardcoding all-on. Also planned from that same panel: an
// input gain stage before localStream, a master/app output volume, and
// per-peer volume (each remote <audio> element in attachRemoteAudio
// already has its own independently drivable .volume for that last one).
const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

async function joinVoice() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  voiceBtn.disabled = true;
  voiceBtn.textContent = 'Requesting mic…';

  try {
    localStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (err) {
    appendSystemMessage(`Microphone access failed: ${err.message}`);
    voiceBtn.disabled = false;
    voiceBtn.textContent = 'Join Voice';
    return;
  }

  voiceActive = true;
  voiceBtn.disabled = false;
  voiceBtn.textContent = 'Leave Voice';
  voiceBtn.classList.add('active');
  muteBtn.style.display = '';
  deafBtn.style.display = '';
  shareBtn.style.display = '';

  ws.send(JSON.stringify({ type: 'voice-join' }));
  appendSystemMessage('You joined voice.');
  // The server replies with 'voice-peers' — that's what actually
  // triggers connecting to whoever else already has voice on.
}

function leaveVoice() {
  if (sharing) stopScreenShare();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'voice-leave' }));
  }

  for (const id of peers.keys()) closePeerConnection(id);

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  voiceActive = false;
  muted = false;
  deafened = false;
  voiceBtn.textContent = 'Join Voice';
  voiceBtn.classList.remove('active');
  muteBtn.style.display = 'none';
  muteBtn.textContent = 'Mute';
  muteBtn.classList.remove('active');
  deafBtn.style.display = 'none';
  deafBtn.textContent = 'Deafen';
  deafBtn.classList.remove('active');
  shareBtn.style.display = 'none';
  appendSystemMessage('You left voice.');
}

muteBtn.onclick = () => {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  muteBtn.textContent = muted ? 'Unmute' : 'Mute';
  muteBtn.classList.toggle('active', muted);
};

deafBtn.onclick = () => {
  deafened = !deafened;
  deafBtn.textContent = deafened ? 'Undeafen' : 'Deafen';
  deafBtn.classList.toggle('active', deafened);

  for (const entry of peers.values()) {
    if (entry.audioEl) entry.audioEl.muted = deafened;
  }

  // Deafening also mutes your own mic (matches common voice-chat
  // convention elsewhere) — un-deafening does NOT auto-unmute, same
  // convention, you have to do that explicitly.
  if (deafened && !muted) {
    muted = true;
    if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
    muteBtn.textContent = 'Unmute';
    muteBtn.classList.add('active');
  }
};

// --- screen share --------------------------------------------------
// Rides on the same peer connections voice already opened — sharing
// requires being in voice, since that's what the mesh is built from.
// A local track is added to every existing connection and each gets
// re-offered; nothing new is needed on the server, the same generic
// 'signal' relay used for the initial handshake carries this too.

shareBtn.onclick = () => {
  if (sharing) stopScreenShare();
  else startScreenShare();
};

async function startScreenShare() {
  if (!voiceActive || sharing || sharePending) return;
  sharePending = true;
  shareBtn.disabled = true;

  shareBtn.textContent = 'Choose window/screen…';
  try {
    screenStream = await Promise.race([
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Picker timed out — this can happen on Wayland if the OS picker was closed without choosing anything. Try again.')), 30000)
      ),
    ]);
  } catch (err) {
    // NotAllowedError covers both "user cancelled" and "denied" —
    // don't nag for a plain cancel, but surface anything unexpected,
    // including the timeout above (which fires as a plain Error, not
    // a DOMException, so it won't have this name).
    if (err.name !== 'NotAllowedError') {
      appendSystemMessage(`Screen share failed: ${err.message}`);
    }
    sharePending = false;
    shareBtn.disabled = false;
    shareBtn.textContent = 'Share Screen';
    return;
  }

  sharePending = false;
  shareBtn.disabled = false;

  const track = screenStream.getVideoTracks()[0];
  // Fires when the user stops sharing via the OS's own "stop sharing"
  // control, not just via our button.
  track.onended = () => stopScreenShare();

  for (const entry of peers.values()) {
    if (!entry.pc) continue;
    entry.pc.addTrack(track, screenStream);
  }

  sharing = true;
  shareBtn.textContent = 'Stop Sharing';
  shareBtn.classList.add('active');
}

function stopScreenShare() {
  if (!sharing) return;

  const track = screenStream ? screenStream.getVideoTracks()[0] : null;
  if (track) {
    for (const entry of peers.values()) {
      if (!entry.pc) continue;
      const sender = entry.pc.getSenders().find((s) => s.track === track);
      if (sender) entry.pc.removeTrack(sender);
    }
  }

  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  sharing = false;
  shareBtn.textContent = 'Share Screen';
  shareBtn.classList.remove('active');
}

// --- chat search ---

searchToggleBtn.onclick = () => {
  const showing = searchPanelEl.style.display !== 'none';
  searchPanelEl.style.display = showing ? 'none' : '';
  if (!showing) searchInputEl.focus();
};

searchCloseBtn.onclick = () => {
  searchPanelEl.style.display = 'none';
};

searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchChat(searchInputEl.value.trim());
});

function searchChat(query) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  lastSearchRequestId = Date.now() + Math.random();
  ws.send(JSON.stringify({ type: 'chat-search', query, requestId: lastSearchRequestId }));
}

function renderSearchResults(results) {
  searchResultsEl.innerHTML = '';
  if (results.length === 0) {
    searchResultsEl.innerHTML = '<div class="hint">No matches.</div>';
    return;
  }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'search-result';
    const nameEl = document.createElement('span');
    nameEl.className = 'chat-name';
    nameEl.textContent = `${r.name} — ${new Date(r.ts).toLocaleString()}`;
    div.appendChild(nameEl);
    div.appendChild(document.createElement('br'));
    div.appendChild(document.createTextNode(r.text));
    searchResultsEl.appendChild(div);
  }
}

// --- chat send/receive ---

chatSendBtn.onclick = sendChat;
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
  chatInput.value = '';
}

// Tracks the calendar day of the last rendered message so a divider
// only gets inserted when the day actually changes — works the same
// way whether messages are arriving live or being replayed as history,
// since history always renders first and in chronological order.
let lastMessageDateKey = null;

function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function maybeInsertDateDivider(ts) {
  const key = dateKey(ts);
  if (key === lastMessageDateKey) return;
  lastMessageDateKey = key;

  const divider = document.createElement('div');
  divider.className = 'date-divider';
  divider.textContent = formatDateDividerLabel(ts);
  chatLog.appendChild(divider);
}

function formatDateDividerLabel(ts) {
  const now = Date.now();
  const yesterday = now - 24 * 60 * 60 * 1000;
  if (dateKey(ts) === dateKey(now)) return 'Today';
  if (dateKey(ts) === dateKey(yesterday)) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatFullDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function appendChatMessage(name, text, isMe, ts) {
  if (ts) maybeInsertDateDivider(ts);

  const div = document.createElement('div');
  div.className = 'chat-msg' + (isMe ? ' me' : '');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'chat-name';
  nameSpan.textContent = `${name}: `;
  div.appendChild(nameSpan);
  div.appendChild(document.createTextNode(text));

  if (ts) {
    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = formatTime(ts);
    timeSpan.title = formatFullDateTime(ts);
    div.appendChild(timeSpan);
  }

  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
