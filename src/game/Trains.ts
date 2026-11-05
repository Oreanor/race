import type { Position } from './VehicleController.ts';

// Trains and trams on the real tracks. The network is built from the
// `transportation` features (main lines only, no tunnels); trains are born and
// retired only where the player can't see them (deep in the haze or behind the
// camera), pick a random fork at switches, never run into each other, and turn
// back at dead ends or stand-offs.

type Feature = { geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> | null };
export type TrackKind = 'rail' | 'tram';
type Node = { id: string; position: Position; kind: TrackKind; links: Set<string> };

const M = 111319.49;
function meters(a: Position, b: Position) {
  const cos = Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * M * cos, (b[1] - a[1]) * M);
}

/** Track kind of a transportation feature, or null when trains don't run there. */
export function trackKind(props: Record<string, unknown> | null | undefined): TrackKind | null {
  const p = props ?? {};
  if (p.brunnel === 'tunnel' || p.service) return null; // tunnels, yards, sidings, crossovers
  const sub = String(p.subclass ?? '');
  if (p.class === 'transit' && sub === 'tram') return 'tram';
  if ((p.class === 'rail' || p.class === 'transit') && /^(rail|narrow_gauge|light_rail|preserved|subway)$/.test(sub)) return 'rail';
  return null;
}

export class RailNetwork {
  nodes = new Map<string, Node>();

  private key(p: Position) {
    // ~0.5 m: lines cut at tile borders meet again
    return `${Math.round(p[0] * 2e5)}:${Math.round(p[1] * 2e5)}`;
  }

  addFeatures(features: Iterable<Feature>) {
    for (const feature of features) {
      const kind = trackKind(feature.properties);
      if (!kind) continue;
      const g = feature.geometry;
      const lines = (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []) as Position[][];
      for (const line of lines) {
        let prev: Node | null = null;
        for (const point of line) {
          const id = this.key(point);
          let node = this.nodes.get(id);
          if (!node) this.nodes.set(id, node = { id, position: [point[0], point[1]], kind, links: new Set() });
          if (prev && prev !== node) { prev.links.add(id); node.links.add(prev.id); }
          prev = node;
        }
      }
    }
  }

  /** Forget track far from here (long drives). */
  prune(center: Position, radius: number) {
    for (const [id, node] of this.nodes) {
      if (meters(center, node.position) <= radius) continue;
      for (const link of node.links) this.nodes.get(link)?.links.delete(id);
      this.nodes.delete(id);
    }
  }

  /** Next node from prev → at: a random fork (never back the way we came; that is a dead end). */
  next(prevId: string, atId: string): string | null {
    const at = this.nodes.get(atId);
    if (!at) return null;
    const options = [...at.links].filter((link) => link !== prevId && this.nodes.has(link));
    if (!options.length) return null;
    return options[Math.floor(Math.random() * options.length)];
  }
}

export type CarPose = { trainId: string; index: number; kind: TrackKind; front: Position; back: Position };

type Train = {
  id: string;
  kind: TrackKind;
  path: string[];
  points: Position[];
  cum: number[];
  /** distance of the nose along the path */
  head: number;
  speed: number;
  cars: number;
  /** each car's own length (the models differ) */
  lengths: number[];
  gap: number;
  maxSpeed: number;
  deadEnd: boolean;
  stoppedFor: number;
  /** seconds spent wholly inside the haze */
  hazedFor: number;
};

const SPEC: Record<TrackKind, { carLength: number; gap: number; maxSpeed: number; cars: [number, number]; max: number }> = {
  rail: { carLength: 13, gap: 0.35, maxSpeed: 22, cars: [4, 9], max: 2 }, // a locomotive and 3–8 wagons
  tram: { carLength: 14, gap: 0.5, maxSpeed: 14, cars: [1, 2], max: 1 }, // one (sometimes two coupled) tram cars
};
const ACCEL = 0.8;
const BRAKE = 1.3;
/** where trains may appear and vanish: beyond this the haze hides them */
const HIDDEN = 1950;
const FAR = 2400;
/** behind the camera: born closer than this, retired further than the next (a gap, so they don't flicker in and out) */
const HIDDEN_SPAWN = 900;
const HIDDEN_RETIRE = 1000;
/** a train this long (s) wholly in the haze has gone off somewhere: it frees its slot */
const HAZED_RETIRE = 40;

export class TrainTraffic {
  trains: Train[] = [];
  private serial = 0;
  private spawnClock = 0;

  private network: RailNetwork;
  private limits: Record<TrackKind, number>;
  /** the length of a car as it is drawn (models differ); null: the default for its kind */
  carLength: (trainId: string, index: number, kind: TrackKind) => number | null = () => null;

  /** `limits`: how many trains / trams run at once (one train by default) */
  constructor(network: RailNetwork, limits: Partial<Record<TrackKind, number>> = {}) {
    this.network = network;
    this.limits = { rail: limits.rail ?? SPEC.rail.max, tram: limits.tram ?? SPEC.tram.max };
  }

  private length(train: Train) {
    return train.lengths.reduce((sum, l) => sum + l, 0) + (train.cars - 1) * train.gap;
  }

  /** pick up each car's drawn length once its model is in (falls back until then) */
  private syncLengths(train: Train) {
    const fallback = SPEC[train.kind].carLength;
    for (let i = 0; i < train.cars; i++) train.lengths[i] = this.carLength(train.id, i, train.kind) ?? fallback;
  }

  private rebuild(train: Train) {
    train.points = train.path.map((id) => this.network.nodes.get(id)?.position ?? [0, 0]);
    train.cum = [0];
    for (let i = 1; i < train.points.length; i++) train.cum.push(train.cum[i - 1] + meters(train.points[i - 1], train.points[i]));
  }

  /** Point on the path at distance s. */
  private at(train: Train, s: number): Position {
    const { points, cum } = train;
    if (s <= 0) return points[0];
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const span = cum[i] - cum[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / span));
    const a = points[i - 1], b = points[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /** Lay track ahead; drop track far behind the last car. */
  private extend(train: Train, ahead: number) {
    let total = train.cum[train.cum.length - 1];
    while (!train.deadEnd && total - train.head < ahead) {
      const n = train.path.length;
      const next = n >= 2 ? this.network.next(train.path[n - 2], train.path[n - 1]) : null;
      if (!next || train.path.includes(next)) { train.deadEnd = true; break; }
      train.path.push(next);
      const p = this.network.nodes.get(next)!.position;
      train.points.push(p);
      total += meters(train.points[train.points.length - 2], p);
      train.cum.push(total);
    }
    const tail = train.head - this.length(train) - 40;
    let drop = 0;
    while (drop + 1 < train.cum.length && train.cum[drop + 1] < tail) drop++;
    if (drop > 0) {
      const shift = train.cum[drop];
      train.path.splice(0, drop);
      train.points.splice(0, drop);
      train.cum = train.cum.slice(drop).map((c) => c - shift);
      train.head -= shift;
    }
  }

  private turnBack(train: Train) {
    const length = this.length(train);
    const total = train.cum[train.cum.length - 1];
    train.path.reverse();
    this.rebuild(train);
    train.head = Math.min(total, total - (train.head - length));
    train.deadEnd = false;
    train.stoppedFor = 0;
    train.speed = 0;
  }

  /** Every car of a train: front and back on the track. */
  poses(): CarPose[] {
    const out: CarPose[] = [];
    for (const train of this.trains) {
      for (let i = 0; i < train.cars; i++) {
        let front = train.head;
        for (let k = 0; k < i; k++) front -= train.lengths[k] + train.gap;
        out.push({ trainId: train.id, index: i, kind: train.kind, front: this.at(train, front), back: this.at(train, front - train.lengths[i]) });
      }
    }
    return out;
  }

  /** Distance along this train's track ahead to the first car of another train on it (within `look`). */
  private blockedAhead(train: Train, others: CarPose[], look: number) {
    let best = Infinity;
    const from = train.head;
    for (let i = 1; i < train.cum.length; i++) {
      if (train.cum[i] < from) continue;
      if (train.cum[i - 1] > from + look) break;
      const a = train.points[i - 1], b = train.points[i];
      const cos = Math.cos(a[1] * Math.PI / 180);
      const bx = (b[0] - a[0]) * M * cos, by = (b[1] - a[1]) * M;
      const len2 = bx * bx + by * by || 1;
      for (const car of others) {
        if (car.trainId === train.id) continue;
        for (const point of [car.front, car.back]) {
          const px = (point[0] - a[0]) * M * cos, py = (point[1] - a[1]) * M;
          const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
          const off = Math.hypot(px - bx * t, py - by * t);
          if (off > 2.4) continue; // a parallel track is 4–5 m away
          const along = train.cum[i - 1] + t * Math.sqrt(len2) - from;
          if (along > -2 && along < best) best = along;
        }
      }
    }
    return best;
  }

  /**
   * Move the trains. `hidden(p)` tells whether a point can't be seen right now
   * (behind the camera); far beyond the haze always counts as hidden.
   */
  update(dt: number, player: Position, hidden: (p: Position) => boolean) {
    for (const train of this.trains) this.syncLengths(train);
    const poses = this.poses();
    for (const train of this.trains) {
      this.extend(train, 400);
      const stopping = train.speed * train.speed / (2 * BRAKE);
      let target = train.maxSpeed;
      const room = train.cum[train.cum.length - 1] - train.head;
      if (train.deadEnd && room < stopping + 6) target = 0;
      // the other train may be coming this way: count on half the gap as our own room
      const blocked = this.blockedAhead(train, poses, 2 * (stopping + 60)) / 2;
      if (blocked - 12 < stopping + 4) target = 0;
      else if (blocked < stopping + 60) target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, blocked - 14)));
      train.speed = target > train.speed ? Math.min(target, train.speed + ACCEL * dt) : Math.max(target, train.speed - BRAKE * dt);
      train.head = Math.min(train.head + train.speed * dt, train.cum[train.cum.length - 1]);
      if (train.speed < 0.05 && target === 0) {
        train.stoppedFor += dt;
        // dead end: back the other way; stand-off: the later one gives way
        if (train.stoppedFor > (train.deadEnd ? 5 : 12)) this.turnBack(train);
      } else train.stoppedFor = 0;
    }
    // retire trains the player can't see any more
    this.trains = this.trains.filter((train) => {
      const ends = [this.at(train, train.head), this.at(train, train.head - this.length(train))];
      // behind the camera and far enough, or past the haze; a train that stays in the haze
      // (wherever the camera looks) for a while has gone away and frees its slot
      const hazed = ends.every((p) => meters(player, p) > HIDDEN);
      train.hazedFor = hazed ? train.hazedFor + dt : 0;
      const gone = train.hazedFor > HAZED_RETIRE || ends.every((p) => meters(player, p) > FAR || (meters(player, p) > HIDDEN_RETIRE && hidden(p)));
      return !gone;
    });
    this.spawnClock -= dt;
    if (this.spawnClock <= 0) {
      this.spawnClock = 1.5;
      for (const kind of ['rail', 'tram'] as TrackKind[]) {
        if (this.trains.filter((t) => t.kind === kind).length < this.limits[kind]) this.spawn(kind, player, hidden, poses);
      }
    }
  }

  private spawn(kind: TrackKind, player: Position, hidden: (p: Position) => boolean, poses: CarPose[]) {
    const spec = SPEC[kind];
    const spots: Node[] = [];
    for (const node of this.network.nodes.values()) {
      if (node.kind !== kind || node.links.size === 0) continue;
      const d = meters(player, node.position);
      if (d > FAR) continue;
      if (d >= HIDDEN || (d > 350 && d < HIDDEN_SPAWN && hidden(node.position))) spots.push(node);
    }
    if (!spots.length) return;
    const start = spots[Math.floor(Math.random() * spots.length)];
    const links = [...start.links];
    const second = links[Math.floor(Math.random() * links.length)];
    const cars = spec.cars[0] + Math.floor(Math.random() * (spec.cars[1] - spec.cars[0] + 1));
    const train: Train = {
      id: `${kind}-${++this.serial}`, kind, path: [start.id, second], points: [], cum: [], head: 0, speed: spec.maxSpeed * 0.6,
      cars, lengths: [], gap: spec.gap, maxSpeed: spec.maxSpeed, deadEnd: false, stoppedFor: 0, hazedFor: 0,
    };
    train.lengths = Array.from({ length: cars }, () => spec.carLength);
    this.syncLengths(train);
    this.rebuild(train);
    const length = this.length(train);
    this.extend(train, length + 120);
    if (train.cum[train.cum.length - 1] < length + 60) return; // too short a stretch
    train.head = length;
    // the whole train must start out of sight, clear of other trains
    const body = [this.at(train, 0), this.at(train, length / 2), this.at(train, length)];
    if (!body.every((p) => meters(player, p) >= HIDDEN || (meters(player, p) > 350 && meters(player, p) < HIDDEN_SPAWN && hidden(p)))) return;
    for (const p of body) if (poses.some((car) => meters(car.front, p) < 400 || meters(car.back, p) < 400)) return;
    this.trains.push(train);
  }

  clear() {
    this.trains = [];
  }
}
