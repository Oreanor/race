// Multiplayer wire format, shared by the server (server/multiplayer.ts) and
// the client (net/NetClient). The world itself needs no syncing: every client
// builds it from the same map tiles. Only the players travel over the wire.

/** bump when the messages change: an old tab is told to reload instead of sending junk */
export const NET_VERSION = 3;
/** the relay's port: it serves the game (proxying Next) and the multiplayer socket */
export const NET_PORT = 3001;
/** the multiplayer socket's path on that port */
export const NET_PATH = '/mp';
/** how often a client reports its car, and the server sends everyone a snapshot */
export const NET_HZ = 10;
/** chat line length */
export const CHAT_MAX = 160;
/** one bullet's damage to another player (the same as to a bot) */
export const HIT_DAMAGE = 15;
/** a player's health */
export const PLAYER_HP = 1000;
/** farther than this, a hit is not believed (m) */
export const HIT_RANGE = 250;
/** shared traffic: cars one player drives for everybody around */
export const TRAFFIC_MAX = 3;

/** A car of the shared traffic. Its id starts with the driving player's id and a colon. */
export type TrafficCar = { id: string; car: string; p: [number, number]; h: number; s: number; hp: number };

/** One player as everybody sees them. Position is lng/lat, altitude in meters (as drawn). */
export type NetPlayer = {
  id: string;
  name: string;
  /** car id from config/vehicle.config */
  car: string;
  p: [number, number];
  a: number;
  /** heading (radians, 0 = north, clockwise) and speed (m/s) */
  h: number;
  s: number;
  /** body pitch (nose up +) and roll, radians: the car leans on slopes */
  pt: number;
  rl: number;
  /** busy with a mission: others see the car parked at the mission's marker */
  busy: boolean;
  /** health, out of PLAYER_HP */
  hp: number;
};

export type ClientMessage =
  | { t: 'hello'; v: number; name: string; car: string }
  | { t: 'state'; p: [number, number]; a: number; h: number; s: number; pt: number; rl: number; car: string; busy: boolean; hp: number }
  | { t: 'chat'; text: string }
  /** our bullet hit player `id` */
  | { t: 'hit'; id: string }
  /** we were blown up by player `by` */
  | { t: 'down'; by: string }
  /** the traffic we drive, NET_HZ times a second */
  | { t: 'traffic'; cars: TrafficCar[] }
  /** our bullet hit a traffic car (goes to the player driving it) */
  | { t: 'thit'; id: string };

export type ServerMessage =
  | { t: 'welcome'; id: string }
  | { t: 'snap'; at: number; players: NetPlayer[] }
  | { t: 'chat'; id: string; name: string; text: string; at: number }
  /** a bullet of player `from` hit us */
  | { t: 'hit'; from: string; name: string; dmg: number }
  /** player `id` was blown up by player `by` (to everybody) */
  | { t: 'down'; id: string; name: string; by: string; byName: string }
  /** the traffic player `from` drives */
  | { t: 'traffic'; from: string; at: number; cars: TrafficCar[] }
  /** somebody's bullet hit one of our traffic cars */
  | { t: 'thit'; id: string; from: string }
  /** the server will not take us: an outdated page, or no room */
  | { t: 'reject'; reason: 'version' | 'full' };

const plain = (raw: unknown, max: number) => String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Names are short and plain: no markup, no control characters. */
export function cleanName(raw: unknown, fallback: string) {
  return plain(raw, 24) || fallback;
}

/** A chat line: plain text, one line, CHAT_MAX characters at most. */
export function cleanChat(raw: unknown) {
  return plain(raw, CHAT_MAX);
}
