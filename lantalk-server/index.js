// LanTalk relay server — prototype 1: text chat only, plus UDP discovery.
//
// This is intentionally the whole system reduced to its simplest form:
// a WebSocket server that tracks who's connected and forwards chat
// messages to everyone. No voice, no screen share, no auth, no TLS.
// Run this on the dedicated Linux box.

const { WebSocketServer } = require('ws');
const dgram = require('dgram');
const os = require('os');

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'chat.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    name, text, content='messages', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, name, text) VALUES (new.id, new.name, new.text);
  END;
`);

const insertMessage = db.prepare('INSERT INTO messages (client_id, name, text, ts) VALUES (?, ?, ?, ?)');
const recentMessages = db.prepare('SELECT client_id AS clientId, name, text, ts FROM messages ORDER BY id DESC LIMIT ?');
const searchMessages = db.prepare(`
  SELECT m.client_id AS clientId, m.name, m.text, m.ts
  FROM messages_fts f JOIN messages m ON m.id = f.rowid
  WHERE messages_fts MATCH ?
  ORDER BY m.id DESC LIMIT ?
`);

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });



const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 51000;
const DISCOVERY_PORT = process.env.DISCOVERY_PORT ? parseInt(process.env.DISCOVERY_PORT, 10) : 51001;

// clients: id -> { ws, name, voiceActive, clientId }
const clients = new Map();
let nextId = 1;

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });

console.log(`LanTalk relay listening on port ${PORT}`);

// --- UDP discovery -------------------------------------------------------
// Clients broadcast a small "lantalk-discover" packet on this port and
// this socket answers directly back to whoever asked, telling them our
// hostname and the actual WebSocket port above. This is the whole
// mechanism — no registry, no persistence, just "ping, I'm here".

const discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

discoverySocket.on('message', (raw, rinfo) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type !== 'lantalk-discover') return;

  const reply = JSON.stringify({
    type: 'lantalk-announce',
    name: os.hostname(),
    port: PORT,
  });
  discoverySocket.send(reply, rinfo.port, rinfo.address, (err) => {
    if (err) console.error(`[discovery] failed to reply to ${rinfo.address}:`, err.message);
  });
});

discoverySocket.on('error', (err) => {
  console.error('[discovery] socket error:', err.message);
});

discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
  console.log(`Discovery listener on UDP ${DISCOVERY_PORT}`);
});

function broadcast(payloadObj, exceptId = null) {
  const raw = JSON.stringify(payloadObj);
  for (const [id, client] of clients) {
    if (id !== exceptId) client.ws.send(raw);
  }
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  clients.set(id, { ws, name: null, voiceActive: false, clientId: null });
  console.log(`[connect] client ${id}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore anything that isn't valid JSON
    }

    if (msg.type === 'join') {
      const name = (msg.name || 'Anonymous').slice(0, 32);
      const client = clients.get(id);
      client.name = name;
      client.clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : null;
      console.log(`[join] ${id} as "${name}"`);

      const history = recentMessages.all(50).reverse(); // oldest first for correct display order
      ws.send(JSON.stringify({ type: 'chat-history', messages: history }));

      // Tell the new client who's already here.
      ws.send(JSON.stringify({
        type: 'welcome',
        yourId: id,
        peers: [...clients.entries()]
          .filter(([pid]) => pid !== id)
          .map(([pid, c]) => ({ id: pid, name: c.name })),
      }));

      // Tell everyone else the new client arrived.
      broadcast({ type: 'peer-joined', id, name }, id);
    }

    else if (msg.type === 'chat') {
      const sender = clients.get(id);
      if (!sender || !sender.name) return; // must have joined first
      const text = String(msg.text || '').slice(0, 2000);
      if (!text.trim()) return;

      console.log(`[chat] ${sender.name}: ${text}`);
      const ts = Date.now();
      broadcast({ type: 'chat', from: id, clientId: sender.clientId, name: sender.name, text, ts });
      insertMessage.run(sender.clientId, sender.name, text, ts);
    }

    // WebRTC signaling relay: we never look inside `data` (it's SDP or
    // an ICE candidate) — just forward it to the named recipient. The
    // actual audio never touches this server once two peers connect.
    else if (msg.type === 'signal') {
      const target = clients.get(msg.to);
      if (!target) return;
      target.ws.send(JSON.stringify({ type: 'signal', from: id, data: msg.data }));
    }

    // Voice is opt-in and separate from chat presence — joining the
    // server never implies joining voice. A client only shows up as a
    // voice participant after explicitly sending this.
    else if (msg.type === 'voice-join') {
      const sender = clients.get(id);
      if (!sender || !sender.name) return;
      sender.voiceActive = true;
      console.log(`[voice] ${sender.name} joined voice`);

      // Tell the joiner who else already has voice on, so they know
      // who to open connections to.
      ws.send(JSON.stringify({
        type: 'voice-peers',
        peers: [...clients.entries()]
          .filter(([pid, c]) => pid !== id && c.voiceActive)
          .map(([pid]) => pid),
      }));

      broadcast({ type: 'peer-voice-on', id }, id);
    }

    else if (msg.type === 'voice-leave') {
      const sender = clients.get(id);
      if (!sender) return;
      sender.voiceActive = false;
      console.log(`[voice] ${sender.name} left voice`);
      broadcast({ type: 'peer-voice-off', id }, id);
    }
    
    else if (msg.type === 'chat-search') {
      const query = String(msg.query || '').trim();
      let results = [];
      if (query) {
        try {
          // Prefix-match each word so partial typing still finds things.
          const ftsQuery = query.split(/\s+/).filter(Boolean).map((w) => w.replace(/"/g, '') + '*').join(' ');
          results = searchMessages.all(ftsQuery, 100);
        } catch (err) {
          console.error('[search] query failed:', err.message);
        }
      }
      ws.send(JSON.stringify({ type: 'chat-search-results', requestId: msg.requestId, query, results }));
    }
  });

  ws.on('close', () => {
    const client = clients.get(id);
    console.log(`[disconnect] ${id}${client?.name ? ` (${client.name})` : ''}`);
    clients.delete(id);
    broadcast({ type: 'peer-left', id });
  });

  ws.on('error', (err) => {
    console.error(`[error] client ${id}:`, err.message);
  });
});
