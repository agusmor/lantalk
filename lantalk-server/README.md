# lantalk-server

Headless relay for LanTalk. Runs on the dedicated Linux box, always on.

## Ports

Every port below needs its own firewall rule — opening one does **not**
open the others. This list will grow as voice and screen share get added,
so update it here when that happens rather than re-discovering it via a
"why can't clients find me" debugging session.

| Port    | Protocol | Purpose                          | Firewall rule (ufw)         |
|---------|----------|-----------------------------------|------------------------------|
| 51000   | TCP      | WebSocket: chat relay + voice signaling | `sudo ufw allow 51000/tcp`  |
| 51001   | UDP      | Discovery (broadcast ping/reply)  | `sudo ufw allow 51001/udp`  |

Voice didn't need a new server port — the SDP/ICE signaling messages
ride the same WebSocket connection as chat. The actual audio never
touches this server at all: once two clients have exchanged signaling
through here, they open a direct connection to each other and this
machine is out of the loop. That also means this server's firewall has
nothing to do with whether voice itself works — if audio doesn't
connect, check the *client* machines' own firewalls instead, since
that's where the direct peer-to-peer traffic actually lands.

Check what's currently open with `sudo ufw status`.

Both ports need to be reachable from every network clients might connect
over — plain LAN and the ZeroTier interface alike. `ufw` rules are
interface-agnostic by default, so a single `allow` rule covers both unless
rules have been scoped to a specific interface.

## Running

```bash
npm install
node index.js
```

Look for both of these lines on startup — if either is missing, that
piece failed to bind (port already in use is the usual cause):

```
LanTalk relay listening on port 51000
Discovery listener on UDP 51001
```

## Running as a systemd service

Not set up yet, but the plan: a unit file with `Restart=on-failure` and
`WantedBy=multi-user.target` so it survives reboots and crashes without
manual intervention. Revisit once the app is further along.

## Debugging connectivity

`sudo tcpdump -i any udp port 51001` on this machine while a client
attempts discovery shows directly whether packets are arriving at all —
useful for telling "client never sent it" apart from "server isn't
replying" apart from "firewall ate it in between."
