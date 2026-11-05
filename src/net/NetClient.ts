import { NET_HZ, NET_PATH, NET_PORT, NET_VERSION, PLAYER_HP, type ClientMessage, type NetPlayer, type ServerMessage, type TrafficCar } from './protocol';

// Client side of multiplayer, through our relay (server/multiplayer.ts): we
// report our car ten times a second, keep the last snapshots of everybody else
// and play them back a little behind real time, so remote cars glide between
// updates. Chat goes the same way. Reconnects on its own; with no relay the
// game plays alone.

export type RemotePlayer = {
  id: string; name: string; car: string;
  position: [number, number]; altitude: number; heading: number; speed: number;
  pitch: number; roll: number; busy: boolean;
  /** health, out of PLAYER_HP */
  hp: number;
};
export type ChatLine = { id: string; name: string; text: string; at: number; mine: boolean };
/** what the server told us about the connection itself */
export type NetNotice = 'online' | 'offline' | 'outdated' | 'full';

export interface Net {
  readonly online: boolean;
  /** our car; sent at most NET_HZ times a second */
  report(position: [number, number], altitude: number, heading: number, speed: number, pitch: number, roll: number, car: string, busy: boolean, hp: number): void;
  rename(name: string): void;
  say(text: string): void;
  /** everybody else, smoothly placed for this moment */
  players(): RemotePlayer[];
  onChat: (line: ChatLine) => void;
  onNotice: (notice: NetNotice) => void;
  /** our bullet hit player `id` */
  hit(id: string): void;
  /** we were blown up by player `by` */
  down(by: string): void;
  /** a bullet of another player hit us */
  onHit: (from: string, name: string, damage: number) => void;
  /** our id on the server, null while not connected */
  readonly id: string | null;
  /** the traffic we drive, for everybody around */
  traffic(cars: TrafficCar[]): void;
  /** our bullet hit a traffic car somebody else drives */
  trafficHit(id: string): void;
  /** the traffic another player drives */
  onTraffic: (from: string, cars: TrafficCar[]) => void;
  /** a bullet hit a traffic car we drive */
  onTrafficHit: (id: string) => void;
  /** somebody was blown up by somebody (`mine`: by us) */
  onDown: (event: { id: string; name: string; by: string; byName: string; mine: boolean; me: boolean }) => void;
  close(): void;
}

const KEEP = 12;

const lerpAngle = (a: number, b: number, t: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** Recent samples per player, played back `delay` ms behind the sender's clock. */
class Playback {
  private history = new Map<string, { at: number; p: NetPlayer }[]>();
  /** sender clock minus ours */
  private skew = 0;
  constructor(private delay: number) {}

  /** One player's sample, stamped by the server (ms). */
  add(at: number, p: NetPlayer) {
    const list = this.history.get(p.id) ?? [];
    if (list.length && list[list.length - 1].at >= at) return; // nothing new
    list.push({ at, p });
    if (list.length > KEEP) list.shift();
    this.history.set(p.id, list);
  }
  clock(at: number) { this.skew = this.skew ? this.skew * 0.9 + (at - Date.now()) * 0.1 : at - Date.now(); }
  keepOnly(ids: Set<string>) { for (const id of [...this.history.keys()]) if (!ids.has(id)) this.history.delete(id); }
  clear() { this.history.clear(); }

  players(): RemotePlayer[] {
    const t = Date.now() + this.skew - this.delay;
    const out: RemotePlayer[] = [];
    for (const list of this.history.values()) {
      if (!list.length) continue;
      let a = list[0], b = list[list.length - 1];
      for (let i = 0; i + 1 < list.length; i++) if (list[i].at <= t && list[i + 1].at >= t) { a = list[i]; b = list[i + 1]; break; }
      // past the newest sample: hold it (a moment of lag must not fling the car on)
      const k = b.at > a.at ? Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at))) : 1;
      const p = b.p, q = a.p;
      const mix = (x: number | undefined, y: number | undefined) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * k;
      out.push({
        id: p.id, name: p.name, car: p.car,
        position: [q.p[0] + (p.p[0] - q.p[0]) * k, q.p[1] + (p.p[1] - q.p[1]) * k],
        altitude: mix(q.a, p.a),
        heading: lerpAngle(q.h, p.h, k),
        speed: p.s,
        pitch: mix(q.pt, p.pt),
        roll: mix(q.rl, p.rl),
        busy: p.busy,
        hp: p.hp ?? PLAYER_HP,
      });
    }
    return out;
  }
}

/**
 * Default relay. Through the relay's own port (or a tunnel to it) the game and
 * the multiplayer share one origin: `/mp` on the same host. Opened straight from
 * the Next dev server (port 3000), it goes to the relay's port on the same host.
 */
export function defaultServerUrl() {
  const env = (process.env.NEXT_PUBLIC_MP_URL ?? '').trim();
  // 'off': a single-player build (e.g. on Vercel, with no relay): no socket, no reconnect notices
  if (env === 'off') return '';
  if (env) return env;
  if (typeof location === 'undefined') return '';
  const ws = location.protocol === 'https:' ? 'wss' : 'ws';
  if (location.port === '3000') return `${ws}://${location.hostname}:${NET_PORT}${NET_PATH}`;
  return `${ws}://${location.host}${NET_PATH}`;
}

export class SocketNet implements Net {
  id: string | null = null;
  private socket: WebSocket | null = null;
  private playback = new Playback(160);
  private lastSent = 0;
  private retry = 1000;
  private closed = false;
  /** the server said this page is outdated: no point knocking again */
  private refused = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  onChat: (line: ChatLine) => void = () => {};
  onNotice: (notice: NetNotice) => void = () => {};
  onHit: Net['onHit'] = () => {};
  onTraffic: Net['onTraffic'] = () => {};
  onTrafficHit: Net['onTrafficHit'] = () => {};
  onDown: Net['onDown'] = () => {};

  constructor(private url: string, private name: string, private car: string) { this.open(); }

  get online() { return this.socket?.readyState === WebSocket.OPEN && this.id != null; }

  private open() {
    if (this.closed || this.refused) return;
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); } catch { this.later(); return; }
    this.socket = socket;
    socket.onopen = () => {
      this.send({ t: 'hello', v: NET_VERSION, name: this.name, car: this.car });
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.t === 'welcome') { this.id = message.id; this.retry = 1000; this.onNotice('online'); return; }
      if (message.t === 'reject') {
        if (message.reason === 'version') this.refused = true;
        else this.retry = 30000; // full: try again in a while
        this.onNotice(message.reason === 'version' ? 'outdated' : 'full');
        return;
      }
      if (message.t === 'chat') {
        this.onChat({ id: message.id, name: message.name, text: message.text, at: message.at, mine: message.id === this.id });
        return;
      }
      if (message.t === 'hit') { this.onHit(message.from, message.name, message.dmg); return; }
      if (message.t === 'traffic') { this.onTraffic(message.from, message.cars); return; }
      if (message.t === 'thit') { this.onTrafficHit(message.id); return; }
      if (message.t === 'down') {
        this.onDown({ id: message.id, name: message.name, by: message.by, byName: message.byName, mine: message.by === this.id, me: message.id === this.id });
        return;
      }
      if (message.t !== 'snap') return;
      this.playback.clock(message.at);
      const seen = new Set<string>();
      for (const p of message.players) if (p.id !== this.id) { seen.add(p.id); this.playback.add(message.at, p); }
      this.playback.keepOnly(seen);
    };
    socket.onclose = () => {
      const was = this.id != null;
      this.id = null;
      this.playback.clear();
      if (was) this.onNotice('offline');
      this.later();
    };
    socket.onerror = () => socket.close();
  }

  private later() {
    if (this.closed || this.refused) return;
    this.timer = setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(30000, this.retry * 2);
  }

  private send(message: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  report(position: [number, number], altitude: number, heading: number, speed: number, pitch: number, roll: number, car: string, busy: boolean, hp: number) {
    const now = performance.now();
    if (now - this.lastSent < 1000 / NET_HZ) return;
    this.lastSent = now;
    this.car = car;
    const r = (v: number, k = 1000) => Math.round(v * k) / k; // a smaller message
    this.send({ t: 'state', p: [r(position[0], 1e7), r(position[1], 1e7)], a: r(altitude, 100), h: r(heading), s: r(speed, 100), pt: r(pitch), rl: r(roll), car, busy, hp: Math.round(hp) });
  }

  rename(name: string) { this.name = name; this.send({ t: 'hello', v: NET_VERSION, name, car: this.car }); }
  say(text: string) { this.send({ t: 'chat', text }); }
  hit(id: string) { this.send({ t: 'hit', id }); }
  traffic(cars: TrafficCar[]) { this.send({ t: 'traffic', cars }); }
  trafficHit(id: string) { this.send({ t: 'thit', id }); }
  down(by: string) { this.send({ t: 'down', by }); }
  players() { return this.playback.players(); }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }
}

/** The relay this page talks to, or null to play alone. */
export function createNet(name: string, car: string): Net | null {
  const url = defaultServerUrl();
  return url ? new SocketNet(url, name, car) : null;
}
