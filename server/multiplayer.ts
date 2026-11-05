// The game's front door, one port for everything (easy to tunnel):
//   /mp      multiplayer: everybody in one shared world. Clients report their
//            car ~10 times a second; every client gets a snapshot of all
//            players at the same rate, plus chat. No accounts: any name will do.
//   anything else is passed through to the Next.js server (dev or prod),
//            websockets included (dev hot reload).
//
//   npm run build && npm start   (or npm run dev)   → Next on :3000
//   npm run server                                  → open http://localhost:3001
//   tunnel port 3001, e.g.  cloudflared tunnel --url http://localhost:3001
//
// Env: MP_PORT (3001), MP_NEXT_PORT / MP_NEXT_HOST (127.0.0.1:3000), MP_MAX_PLAYERS (100);
// MP_TUNNEL=1 opens a Cloudflare tunnel and tells the public site (server/tunnel.ts).

import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { startTunnel } from './tunnel.ts';
import { cleanChat, cleanName, HIT_DAMAGE, HIT_RANGE, NET_HZ, NET_PATH, NET_PORT, NET_VERSION, PLAYER_HP, TRAFFIC_MAX, type ClientMessage, type NetPlayer, type ServerMessage, type TrafficCar } from '../src/net/protocol.ts';

const port = Number(process.env.MP_PORT) || NET_PORT;
const next = { host: process.env.MP_NEXT_HOST || '127.0.0.1', port: Number(process.env.MP_NEXT_PORT) || 3000 };
const MAX_PLAYERS = Number(process.env.MP_MAX_PLAYERS) || 100;
/** connections from one address at most (a few tabs, not a flood) */
const MAX_PER_ADDRESS = 8;
/** a page that has not said hello within this long is dropped */
const SILENT_MS = 15_000;
/** messages per second a client may send (10 states + renames + chat, with slack) */
const RATE = 45;
/** bullet hits a client may claim a second (the gun fires 20) */
const HITS_PER_SECOND = 25;
/** past this many in one second it is not a game any more: disconnect */
const FLOOD = 120;
const CHAT_EVERY_MS = 700;
const RENAME_EVERY_MS = 1000;

// ---- multiplayer -------------------------------------------------------------

type Client = {
  socket: WebSocket;
  address: string;
  player: NetPlayer | null;
  heardAt: number;
  alive: boolean;
  /** messages in the current second */
  window: number;
  count: number;
  chatAt: number;
  /** hits claimed this second */
  hitWindow: number;
  hits: number;
  /** a "down" is believed only from a player who was hit lately, by the one who hit them */
  lastHitBy: string;
  lastHitAt: number;
  helloAt: number;
};

const clients = new Map<string, Client>();
/** when a shooter → victim pair was last logged */
const loggedHits = new Map<string, number>();
let nextId = 1;
// a traffic message is the biggest: up to TRAFFIC_MAX cars of ~110 bytes each
const players = new WebSocketServer({ noServer: true, maxPayload: 8192 });

const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Ground distance between two lng/lat points (m). */
function meters(a: [number, number], b: [number, number]) {
  const k = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 111320);
}

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage) {
  const text = JSON.stringify(message);
  for (const client of clients.values()) if (client.player && client.socket.readyState === client.socket.OPEN) client.socket.send(text);
}

const addressOf = (request: http.IncomingMessage) =>
  String(request.headers['cf-connecting-ip'] ?? request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? '').split(',')[0].trim();

players.on('connection', (socket: WebSocket, request: http.IncomingMessage) => {
  const address = addressOf(request);
  if (clients.size >= MAX_PLAYERS || [...clients.values()].filter((c) => c.address === address).length >= MAX_PER_ADDRESS) {
    send(socket, { t: 'reject', reason: 'full' });
    socket.close();
    return;
  }
  const id = `p${nextId++}`;
  const client: Client = { socket, address, player: null, heardAt: Date.now(), alive: true, window: 0, count: 0, chatAt: 0, helloAt: 0, hitWindow: 0, hits: 0, lastHitBy: '', lastHitAt: 0 };
  clients.set(id, client);
  send(socket, { t: 'welcome', id });
  console.log(`[mp] ${id} connected from ${address} (${clients.size} online)`);

  socket.on('pong', () => { client.alive = true; });
  socket.on('message', (raw) => {
    const now = Date.now();
    // rate limit: drop past RATE a second, hang up past FLOOD
    const second = Math.floor(now / 1000);
    if (second !== client.window) { client.window = second; client.count = 0; }
    if (++client.count > FLOOD) { console.log(`[mp] ${id} flooding, disconnected`); socket.terminate(); return; }
    if (client.count > RATE) return;
    let message: ClientMessage;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message !== 'object') return;
    client.heardAt = now;
    if (message.t === 'hello') {
      if (message.v !== NET_VERSION) { send(socket, { t: 'reject', reason: 'version' }); socket.close(); return; }
      if (client.player && now - client.helloAt < RENAME_EVERY_MS) return;
      client.helloAt = now;
      const name = cleanName(message.name, `Player ${id.slice(1)}`);
      const car = String(message.car ?? '01').slice(0, 8);
      // a second hello is a rename: keep the place
      if (client.player) Object.assign(client.player, { name, car });
      else client.player = { id, name, car, p: [0, 0], a: 0, h: 0, s: 0, pt: 0, rl: 0, busy: false, hp: PLAYER_HP };
      console.log(`[mp] ${id} is "${name}"`);
      return;
    }
    if (!client.player) return; // nothing before hello
    if (message.t === 'state') {
      const p = message.p;
      if (!Array.isArray(p) || !finite(p[0], -180, 180) || !finite(p[1], -85.1, 85.1)) return;
      const player = client.player;
      player.p = [p[0], p[1]];
      if (finite(message.a, -1000, 20000)) player.a = message.a;
      if (finite(message.h, -100, 100)) player.h = message.h;
      if (finite(message.s, -200, 200)) player.s = message.s;
      player.pt = finite(message.pt, -1.6, 1.6) ? message.pt : 0;
      player.rl = finite(message.rl, -1.6, 1.6) ? message.rl : 0;
      if (typeof message.car === 'string') player.car = message.car.slice(0, 8);
      player.busy = message.busy === true;
      player.hp = finite(message.hp, 0, PLAYER_HP) ? Math.round(message.hp) : PLAYER_HP;
      return;
    }
    if (message.t === 'hit') {
      // the shooter's word, checked: not too often, not too far, not a player on a mission
      const victim = clients.get(String(message.id));
      const shooter = client.player;
      if (!victim?.player || victim === client || victim.player.busy || shooter.busy) return;
      const second = Math.floor(now / 1000);
      if (second !== client.hitWindow) { client.hitWindow = second; client.hits = 0; }
      if (++client.hits > HITS_PER_SECOND) return;
      if (meters(shooter.p, victim.player.p) > HIT_RANGE) return;
      victim.lastHitBy = id;
      victim.lastHitAt = now;
      send(victim.socket, { t: 'hit', from: id, name: shooter.name, dmg: HIT_DAMAGE });
      // a line in the log now and then: who is shooting whom
      if (now - (loggedHits.get(id + '>' + victim.player.id) ?? 0) > 5000) {
        loggedHits.set(id + '>' + victim.player.id, now);
        console.log(`[mp] ${shooter.name} (${id}) hits ${victim.player.name} (${victim.player.id})`);
      }
      return;
    }
    if (message.t === 'traffic') {
      // a player's traffic, to everybody else: a few cars, sane numbers, ids of their own
      if (!Array.isArray(message.cars)) return;
      const cars: TrafficCar[] = [];
      for (const c of message.cars.slice(0, TRAFFIC_MAX)) {
        if (!c || typeof c.id !== 'string' || !c.id.startsWith(id + ':') || c.id.length > 24) continue;
        if (!Array.isArray(c.p) || !finite(c.p[0], -180, 180) || !finite(c.p[1], -85.1, 85.1)) continue;
        if (meters(c.p, client.player.p) > 3000) continue;
        cars.push({ id: c.id, car: String(c.car ?? '01').slice(0, 8), p: [c.p[0], c.p[1]], h: finite(c.h, -100, 100) ? c.h : 0, s: finite(c.s, -200, 200) ? c.s : 0, hp: finite(c.hp, 0, 10000) ? c.hp : 0, ...(c.pk === 1 ? { pk: 1 as const } : {}) });
      }
      const out = JSON.stringify({ t: 'traffic', from: id, at: now, cars } satisfies ServerMessage);
      for (const [other, c] of clients) if (other !== id && c.player && c.socket.readyState === c.socket.OPEN) c.socket.send(out);
      return;
    }
    if (message.t === 'take') {
      // a hijack: to the player who parked that car, if the thief stands near it
      const carId = String(message.id);
      const owner = clients.get(carId.split(':')[0]);
      if (!owner?.player || owner === client) return;
      if (meters(client.player.p, owner.player.p) > 3000) return;
      send(owner.socket, { t: 'take', id: carId, from: id });
      return;
    }
    if (message.t === 'thit') {
      // to the player driving that car, if the shooter could see it
      const carId = String(message.id);
      const owner = clients.get(carId.split(':')[0]);
      if (!owner?.player || owner === client) return;
      const second = Math.floor(now / 1000);
      if (second !== client.hitWindow) { client.hitWindow = second; client.hits = 0; }
      if (++client.hits > HITS_PER_SECOND) return;
      if (meters(client.player.p, owner.player.p) > 3000) return;
      send(owner.socket, { t: 'thit', id: carId, from: id });
      return;
    }
    if (message.t === 'down') {
      const by = clients.get(String(message.by));
      if (!by?.player || client.lastHitBy !== by.player.id || now - client.lastHitAt > 5000) return;
      client.lastHitAt = 0;
      broadcast({ t: 'down', id, name: client.player.name, by: by.player.id, byName: by.player.name });
      console.log(`[mp] ${by.player.name} blew up ${client.player.name}`);
      return;
    }
    if (message.t === 'chat') {
      if (now - client.chatAt < CHAT_EVERY_MS) return;
      const text = cleanChat(message.text);
      if (!text) return;
      client.chatAt = now;
      broadcast({ t: 'chat', id, name: client.player.name, text, at: now });
      console.log(`[mp] ${client.player.name}: ${text}`);
    }
  });
  socket.on('close', (code) => {
    clients.delete(id);
    for (const pair of loggedHits.keys()) if (pair.startsWith(id + '>') || pair.endsWith('>' + id)) loggedHits.delete(pair);
    // 1001: tab closed; 1006: connection lost; 1009: message too big
    console.log(`[mp] ${id} left (${clients.size} online)${code === 1000 || code === 1001 ? '' : `, code ${code}`}`);
  });
  socket.on('error', () => socket.close());
});

setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    // a page that never said hello is dropped; a player whose tab is in the background
    // sends nothing (the browser stops drawing) but answers pings: their car stays where it was
    if (!client.player && now - client.heardAt > SILENT_MS) { client.socket.terminate(); clients.delete(id); }
  }
  // only players who have said hello and reported a place
  const list = [...clients.values()].map((c) => c.player).filter((p): p is NetPlayer => !!p && (p.p[0] !== 0 || p.p[1] !== 0));
  const snapshot = JSON.stringify({ t: 'snap', at: now, players: list } satisfies ServerMessage);
  for (const client of clients.values()) if (client.socket.readyState === client.socket.OPEN) client.socket.send(snapshot);
}, 1000 / NET_HZ);

// dead connections (a laptop lid closed, a tunnel dropped) answer no pings
setInterval(() => {
  for (const [id, client] of clients) {
    if (!client.alive) { client.socket.terminate(); clients.delete(id); continue; }
    client.alive = false;
    client.socket.ping();
  }
}, 10_000);

// ---- everything else goes to Next.js -------------------------------------------

const server = http.createServer((req, res) => {
  // the public site checks we are up before sending players here
  if ((req.url ?? '').split('?')[0] === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, version: NET_VERSION, players: clients.size }));
    return;
  }
  const upstream = http.request({ host: next.host, port: next.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`The game (Next.js on port ${next.port}) is not running: start it with "npm run dev" or "npm start".`);
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === NET_PATH) {
    players.handleUpgrade(req, socket, head, (ws) => players.emit('connection', ws, req));
    return;
  }
  // other websockets (Next dev hot reload): pass the raw bytes both ways
  const upstream = net.connect(next.port, next.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(port, () => { // all addresses, IPv4 and IPv6 (localhost may be ::1)
  console.log(`[mp] game + multiplayer on http://0.0.0.0:${port} (multiplayer at ${NET_PATH}, game from Next on ${next.host}:${next.port})`);
  if (process.env.MP_TUNNEL === '1' || process.argv.includes('--tunnel')) startTunnel(port);
});
