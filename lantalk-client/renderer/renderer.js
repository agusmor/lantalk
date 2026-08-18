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
let localStreamCleanup = null;
let activeSetSuppressionLevel = null; // only set when the active pipeline supports it (DeepFilterNet)
let screenStream = null;
let muted = false;
let deafened = false;
let voiceActive = false;
let sharing = false;
let sharePending = false;
let lastSearchRequestId = 0;
// peers: live connection-session state, keyed by the server's transient
// connection id (resets to 1 on every server restart, and changes every
// time someone reconnects — so a RTCPeerConnection/audioEl/etc belongs
// here, since those genuinely die and get rebuilt on reconnect too).
const peers = new Map(); // connectionId -> { clientId, pc, audioEl, videoEl, videoTileEl, ... }

// peerSettings: persistent per-person data, keyed by the stable UUID
// each client sends on join — survives a peer disconnecting and
// reconnecting, unlike `peers` above. Currently just name + local
// volume; the natural place to add more per-person preferences later.
const peerSettings = new Map(); // clientId -> { name, volume }

function ensurePeerSettings(clientId, name) {
  let s = peerSettings.get(clientId);
  if (!s) {
    s = { name, volume: 1.0 };
    peerSettings.set(clientId, s);
  } else if (name) {
    s.name = name; // keep it current in case they changed it since last seen
  }
  return s;
}

function peerDisplayName(entry) {
  if (!entry || !entry.clientId) return 'Someone';
  return peerSettings.get(entry.clientId)?.name || 'Someone';
}

// Updates the stored preference (so it survives a reconnect) and, if
// this person currently has a live connection, applies it immediately
// too — the two can be out of sync since settings persist but
// connections don't.
function setPeerVolume(clientId, volume) {
  ensurePeerSettings(clientId).volume = volume;
  for (const entry of peers.values()) {
    if (entry.clientId === clientId && entry.audioEl) {
      entry.audioEl.volume = volume;
    }
  }
}

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
const contextMenu = document.getElementById("peer-context-menu");
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
const settingsBtnConnect = document.getElementById('settings-btn-connect');
const settingsBtnChat = document.getElementById('settings-btn-chat');
const settingsOverlayEl = document.getElementById('settings-overlay');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const streamList = document.querySelector(".stream-list");
const noiseSuppressionSelect = document.getElementById('noise-suppression-select');
const suppressionLevelRow = document.getElementById('suppression-level-row');
const suppressionLevelInput = document.getElementById('suppression-level-input');
const suppressionLevelValueEl = document.getElementById('suppression-level-value');
const vcVolume = document.getElementById("vc-volume");
const streamVolume = document.getElementById("stream-volume");

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
// The config directory lives beside the app's executable, which only
// the main process can actually determine (app.isPackaged / the real
// process.execPath aren't available in the renderer) — so everything
// here starts with one shared IPC round-trip, and anything that
// depends on identity/settings awaits the relevant *Ready promise.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcRenderer } = require('electron');

let identity = null;
let identityFilePath = null;
let settings = null;
let settingsFilePath = null;

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveJsonFile(filePath, value) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`[config] failed to save ${filePath}:`, err.message);
  }
}

function saveIdentity(value) { saveJsonFile(identityFilePath, value); }
function saveSettings(value) { saveJsonFile(settingsFilePath, value); }

const configReady = (async () => {
  const configDir = await ipcRenderer.invoke('get-config-dir');
  identityFilePath = path.join(configDir, 'identity.json');
  settingsFilePath = path.join(configDir, 'settings.json');

  identity = loadJsonFile(identityFilePath);
  if (!identity) {
    identity = { clientId: crypto.randomUUID(), lastUsername: '' };
    saveIdentity(identity);
  }
  nameInput.value = identity.lastUsername || '';

  settings = loadJsonFile(settingsFilePath);
  if (!settings) {
    settings = { noiseSuppression: 'builtin', suppressionLevel: 50 };
    saveSettings(settings);
  }
  noiseSuppressionSelect.value = settings.noiseSuppression;
  suppressionLevelInput.value = settings.suppressionLevel ?? 50;
  suppressionLevelValueEl.textContent = suppressionLevelInput.value;
  updateSuppressionLevelRowVisibility();
})();

// Kept as an alias — same promise, just the name used elsewhere in the
// file so far for anything that only actually needs identity to be ready.
const identityReady = configReady;

// Reachable from both screens — someone might want to set their
// preferences before ever connecting, not just mid-call.
settingsBtnConnect.onclick = () => { settingsOverlayEl.style.display = ''; };
settingsBtnChat.onclick = () => { settingsOverlayEl.style.display = ''; };
settingsCloseBtn.onclick = () => { settingsOverlayEl.style.display = 'none'; };
settingsOverlayEl.addEventListener('click', (e) => {
  if (e.target === settingsOverlayEl) settingsOverlayEl.style.display = 'none';
});

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
};

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.yourId;
      for (const p of msg.peers) {
        ensurePeerSettings(p.clientId, p.name);
        peers.set(p.id, { clientId: p.clientId, name: p.name, pc: null, audioEl: null, videoEl: null, videoTileEl: null });
      }
      showChatScreen();
      appendSystemMessage(`Connected as ${myName}.`);
      updatePeerCount();
      break;

    case 'peer-joined':
      ensurePeerSettings(msg.clientId, msg.name);
      peers.set(msg.id, { clientId: msg.clientId, name: msg.name, pc: null, audioEl: null, videoEl: null, videoTileEl: null });
      appendSystemMessage(`${msg.name} joined.`);
      updatePeerCount();
      break;

    case 'peer-left': {
      const entry = peers.get(msg.id);
      const name = peerDisplayName(entry);
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
        .catch((err) => console.error(`[voice] queued signal failed for ${peerDisplayName(entry)}:`, err.message));
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
  updatePeerScreen();
}

function updatePeerScreen() {
  streamList.replaceChildren();

  for (const [uuid, data] of peers) {
    const li = document.createElement("li");
    li.className = "stream-user";
    li.dataset.peerId = uuid;

    const button = document.createElement("button");
    button.textContent = data.name;

    li.appendChild(button);
    streamList.appendChild(li);
  }
}

streamList.addEventListener("contextmenu", (event) => {
  event.preventDefault();

  const button = event.target.closest("button");

  if (!button) return;

  const user = button.closest(".stream-user");
  const uuid = user.dataset.peerId;
  

  // Remember who the menu belongs to
  contextMenu.dataset.peerId = uuid;

  // Position the menu at the mouse
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;

  contextMenu.style.display = "flex";
});

contextMenu.addEventListener("click", (event) => {
  const action = event.target.dataset.action;

  if (!action) return;

  const peerId = contextMenu.dataset.peerId;

  console.log("Action:", action);
  console.log("Peer:", peerId);

  switch (action) {
    case "vc-volume":
      console.log("Adjust VC volume for", peerId);
      break;

    case "stream-volume":
      console.log("Adjust stream volume for", peerId);
      break;

    case "stop-viewing":
      console.log("Stop viewing stream from", peerId);
      break;
  }

  contextMenu.style.display = "none";
});

document.addEventListener("click", (event) => {
  if (!contextMenu.contains(event.target)) {
    contextMenu.style.display = "none";
  }
});

vcVolume.addEventListener("input", () => {
  const uuid = contextMenu.dataset.peerId;
  setPeerVolume(uuid, vcVolume.value)
});

streamVolume.addEventListener("input", () => {
  const peerId = contextMenu.dataset.peerId;

  console.log("Stream volume:", streamVolume.value);
  console.log("For peer:", peerId);
});

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
      console.warn(`[voice] connection to ${peerDisplayName(entry)} failed`);
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
      console.error(`[voice] negotiation failed for ${peerDisplayName(entry)}:`, err.message);
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
          console.warn(`[voice] ICE candidate error for ${peerDisplayName(entry)}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error(`[voice] signal handling failed for ${peerDisplayName(entry)}:`, err.message);
  }
}

function attachRemoteAudio(id, stream) {
  const entry = peers.get(id);
  if (!entry) return;
  if (!entry.audioEl) {
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.muted = deafened;
    audioEl.volume = peerSettings.get(entry.clientId)?.volume ?? 1.0;
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
    tile.querySelector('.tile-label').textContent = `${peerDisplayName(entry)}'s screen`;

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
  popout.querySelector('.popout-title').textContent = `${peerDisplayName(entry)}'s screen`;
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

// --- microphone noise suppression --------------------------------------
// Four modes, picked in Settings and persisted to settings.json:
//   'off'          — raw mic, only echo cancellation + auto gain.
//   'builtin'      — Chromium's own ML-based suppressor, via constraints.
//   'rnnoise'      — the actual RNNoise model, via @sapphi-red/web-noise-
//                    suppressor's RnnoiseWorkletNode. Runs in place of
//                    the built-in suppressor, not stacked on top of it —
//                    running both tends to fight each other and sound
//                    worse than either alone.
//   'deepfilternet'— DeepFilterNet3, via deepfilternet3-noise-filter.
//                    Generally stronger on non-stationary noise (typing,
//                    barking, traffic) than RNNoise, at more CPU cost.
//                    Fetches its WASM + ONNX model (~22MB total) from a
//                    CDN by default — self-hosted here instead, see the
//                    assetConfig below and the file placement note next
//                    to it.
//
// Whichever mode is active, everything downstream — mute, peer
// connections, signaling — only ever consumes `localStream`, and has
// no idea which pipeline built it. That's on purpose: it's what makes
// the live hot-swap in the settings dropdown possible without having
// to touch anything else.

const { RnnoiseWorkletNode, loadRnnoise } = require('@sapphi-red/web-noise-suppressor');
// deepfilternet3-noise-filter has a real packaging bug: its package.json
// declares "type": "module", which makes Node treat every plain .js file
// inside it — including dist/index.js, which is actually written in
// CommonJS syntax — as an ES module. require() on it throws
// "exports is not defined in ES module scope" as a direct result.
//
// Loading the real ESM build via import() instead of require() sidesteps
// that — but import() in Electron's renderer goes through Chromium's own
// module loader, not Node's, so it has no concept of a bare npm
// specifier the way require() does. It needs an actual URL. The fix
// combines both: require.resolve() to find where the package physically
// lives on disk (this still works fine, it just resolves to the broken
// CJS file), then point at that file's sibling ESM build instead, turned
// into a proper file:// URL via pathToFileURL (handles Windows drive
// letters/backslashes correctly, unlike hand-built string concatenation).
//
// Lazy + cached since import() is async and this only needs to happen once.
const { pathToFileURL } = require('url');
let DeepFilterNet3CoreClass = null;
async function getDeepFilterNet3Core() {
  if (!DeepFilterNet3CoreClass) {
    const cjsPath = require.resolve('deepfilternet3-noise-filter');
    const esmPath = cjsPath.replace(/index\.js$/, 'index.esm.js');
    const mod = await import(pathToFileURL(esmPath).href);
    DeepFilterNet3CoreClass = mod.DeepFilterNet3Core;
  }
  return DeepFilterNet3CoreClass;
}

// Builds a fresh processed mic stream for the given mode. Returns both
// the stream and a matching cleanup function, rather than mutating any
// shared state directly — that's what lets the settings hot-swap build
// the *new* pipeline before tearing down the *old* one, instead of the
// two colliding over shared variables.
async function buildLocalStream(mode) {
  if (mode === 'rnnoise') {
    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      video: false,
    });

    // RNNoise operates on fixed 480-sample/10ms frames — the context
    // has to actually run at 48kHz, not just resample on the way in.
    const ctx = new AudioContext({ sampleRate: 48000 });
    const wasmBinary = await loadRnnoise({
      url: 'audio/rnnoise.wasm',
      simdUrl: 'audio/rnnoise_simd.wasm',
    });
    await ctx.audioWorklet.addModule('audio/rnnoise-worklet.js');

    const source = ctx.createMediaStreamSource(rawStream);
    const node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    const dest = ctx.createMediaStreamDestination();
    source.connect(node);
    node.connect(dest);

    return {
      stream: dest.stream,
      cleanup: () => {
        node.destroy();
        ctx.close();
        rawStream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  if (mode === 'deepfilternet') {
    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      video: false,
    });

    const ctx = new AudioContext({ sampleRate: 48000 });

    // cdnUrl points at the two asset files self-hosted locally instead
    // of the package's default (a public CDN, which we don't want —
    // this app is meant to work with zero internet dependency). It
    // fetches, relative to this path:
    //   v3/pkg/df_bg.wasm
    //   v3/models/DeepFilterNet3_onnx.tar.gz
    // Both need to physically exist at
    // renderer/audio/deepfilternet/v3/pkg/df_bg.wasm and
    // renderer/audio/deepfilternet/v3/models/DeepFilterNet3_onnx.tar.gz
    // — download them once and place them there; nothing in this repo
    // ships the ~22MB of model weights itself.
    const DeepFilterNet3Core = await getDeepFilterNet3Core();
    const core = new DeepFilterNet3Core({
      sampleRate: 48000,
      noiseReductionLevel: settings.suppressionLevel ?? 50,
      assetConfig: { cdnUrl: 'audio/deepfilternet' },
    });
    await core.initialize();
    const node = await core.createAudioWorkletNode(ctx);

    const source = ctx.createMediaStreamSource(rawStream);
    const dest = ctx.createMediaStreamDestination();
    source.connect(node);
    node.connect(dest);

    return {
      stream: dest.stream,
      cleanup: () => {
        core.destroy();
        ctx.close();
        rawStream.getTracks().forEach((t) => t.stop());
      },
      setSuppressionLevel: (level) => core.setSuppressionLevel(level),
    };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: mode === 'builtin',
      autoGainControl: true,
    },
    video: false,
  });

  return {
    stream,
    cleanup: () => { stream.getTracks().forEach((t) => t.stop()); },
  };
}

// Changing this mid-call swaps the live audio via replaceTrack() rather
// than tearing the connection down — no renegotiation, no
// onnegotiationneeded firing, peers experience a seamless swap instead
// of a reconnect blip.
noiseSuppressionSelect.onchange = async () => {
  await configReady;
  const newMode = noiseSuppressionSelect.value;

  if (!voiceActive) {
    settings.noiseSuppression = newMode;
    saveSettings(settings);
    return;
  }

  let built;
  try {
    built = await buildLocalStream(newMode);
  } catch (err) {
    appendSystemMessage(`Switching noise suppression failed: ${err.message}`);
    noiseSuppressionSelect.value = settings.noiseSuppression; // nothing changed, revert the dropdown
    return;
  }

  const newTrack = built.stream.getAudioTracks()[0];
  newTrack.enabled = !muted; // carry current mute state onto the new track

  for (const entry of peers.values()) {
    if (!entry.pc) continue;
    const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (sender) sender.replaceTrack(newTrack);
  }

  const oldCleanup = localStreamCleanup;
  localStream = built.stream;
  localStreamCleanup = built.cleanup;
  activeSetSuppressionLevel = built.setSuppressionLevel || null;
  oldCleanup(); // tear down the old pipeline only after the new one is live

  settings.noiseSuppression = newMode;
  saveSettings(settings);
};

noiseSuppressionSelect.addEventListener('change', updateSuppressionLevelRowVisibility);

function updateSuppressionLevelRowVisibility() {
  suppressionLevelRow.style.display = noiseSuppressionSelect.value === 'deepfilternet' ? '' : 'none';
}

// Applies live via the worklet's own message port (no rebuild needed)
// when DeepFilterNet is the active pipeline; otherwise this just
// persists the choice for whenever it's selected next.
suppressionLevelInput.oninput = () => {
  const level = parseInt(suppressionLevelInput.value, 10);
  suppressionLevelValueEl.textContent = level;
  settings.suppressionLevel = level;
  saveSettings(settings);
  if (activeSetSuppressionLevel) activeSetSuppressionLevel(level);
};

async function joinVoice() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  voiceBtn.disabled = true;
  voiceBtn.textContent = 'Requesting mic…';

  try {
    const built = await buildLocalStream(settings.noiseSuppression);
    localStream = built.stream;
    localStreamCleanup = built.cleanup;
    activeSetSuppressionLevel = built.setSuppressionLevel || null;
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

  if (localStreamCleanup) {
    localStreamCleanup();
    localStreamCleanup = null;
  }
  localStream = null;
  activeSetSuppressionLevel = null;

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
