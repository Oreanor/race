import { offsetPosition, type Position, type VehicleController } from './VehicleController.ts';
import type { VehicleSceneLayer } from '@/rendering/VehicleLayer';
import { DROP_MS } from '@/rendering/VehicleLayer';
import type { ThreeMap } from '@/world3d/map/ThreeMap';
import type { Car } from '@/config/vehicle.config';
import type { SharedTraffic } from './net/SharedTraffic.ts';
import type { TrafficBot } from './TrafficBots.ts';
import type { TrainTraffic } from './Trains.ts';
import type { VehiclePose } from './VehiclePose.ts';
import { metersBetween } from './meters.ts';
import { t } from '@/i18n';
import {
  BATMOBILE_ID, HAULER_ID, METERS_PER_DEGREE,
  HAUL_AIM_M, HAUL_COIN_PX, HAUL_COINS_MS, HAUL_DECK_BACK, HAUL_DECK_UP, HAUL_DROP_MS, HAUL_FLY_MS,
  HAUL_LOAD_M, HAUL_MISS_BACK_MS, HAUL_MISS_HOLD_MS, HAUL_MISS_OUT_MS, HAUL_PULL_MS, HAUL_REACH_M,
  HAUL_REEL_MS, HAUL_SNAP_M, HAUL_TAUT_MS, HAUL_TILT, HAUL_WINCH_MS,
} from './tuning.ts';

/** The cars that carry a cable: the Howler (LMB) and the Batmobile (RMB). */
export const canCable = (id: string) => id === HAULER_ID || id === BATMOBILE_ID;

/**
 * The cable's state. First click: it flies out (fly) and sticks to a car (hooked) or a
 * wall (anchored), or comes back empty (miss). Second click: the car is yanked up onto
 * our back (pull → carry), or we reel ourselves up to the wall and hang there (reel →
 * hang). Third click: the car slides off behind (drop), or we let go and fall.
 */
export type Haul = {
  id: string; kind: 'bot' | 'shared' | 'wall' | 'train' | 'coins'; car: Car;
  phase: 'fly' | 'hooked' | 'anchored' | 'pull' | 'carry' | 'drop' | 'miss' | 'reel' | 'hang' | 'towed';
  at: number; from: Position; fromHeading: number; fromUp: number;
  /** wall: the hook (absolute height), and where we start reeling from */
  hookAlt?: number; self?: Position; selfAlt?: number;
  /** train: which one, the rope's length (m) and whether we reeled in already */
  trainId?: string; rope?: number; ropeFrom?: number; reeled?: boolean;
  /** coins: the ones on the hook and where each lay */
  coins?: { id: string; start: Position }[];
  /** hooked car fighting the winch: first moment the rope hit full stretch */
  tautAt?: number;
  /** last update time for hooked-car drag (ms) */
  dragAt?: number;
};

/** A coin or bundle of cash lying about, as far as the hook cares. */
export type HaulPickup = { position: [number, number]; kind: string; drop?: { at: number } };

/** What the cable needs from the game: our car, the world, and the cars it can take. */
export interface HaulHost {
  readonly vehicle: VehicleController;
  readonly renderVehicle: VehiclePose;
  readonly car: Car;
  /** our height (m), and the body's pitch for a load on the bed */
  readonly altitude: number;
  readonly modelPitch: number;
  readonly map: ThreeMap;
  readonly combatLayer: VehicleSceneLayer | null;
  /** the crosshair on screen (px), when aiming */
  readonly aimScreen: [number, number] | null;
  readonly pickups: Map<string, HaulPickup>;
  readonly trainTraffic: TrainTraffic;
  readonly sharedTraffic: SharedTraffic;
  /** our mission bots (a lost catch is taken out of them) */
  trafficBots: TrafficBot[];
  say(text: string, toast?: boolean): void;
  /** off a wall: we drop from where we hung */
  fall(): void;
  /** the bots changed: tell the shooting layer */
  refreshTargets(): void;
}

/**
 * The Howler's and the Batmobile's cable: throw it, hook a car, a wall, a train or coins;
 * yank the car onto the bed, reel up a wall and hang, ride behind a train; let go.
 */
export class Hauler {
  haul: Haul | null = null;
  /** towed by a train on the cable: the car's own driving is off, the rope pulls it */
  towed = false;
  private towSpeed = 0;
  private towClock = 0;
  /** hanging on (or reeling up) the cable: our height, held; null on the ground or flying */
  hangAltitude: number | null = null;

  constructor(private host: HaulHost) {}

  /** Cars the cable can take: our mission bots and the traffic and parked cars we keep. `speed` is signed (m/s). */
  private candidates() {
    const layer = this.host.combatLayer;
    return [
      ...this.host.trafficBots
        .filter(bot => !layer || layer.isTargetAlive(bot.id))
        .map(bot => ({ id: bot.id, kind: 'bot' as const, car: bot.car, position: bot.position as Position, heading: bot.heading, speed: bot.controller.speed })),
      ...this.host.sharedTraffic.holdable().map(c => ({ ...c, kind: 'shared' as const })),
    ];
  }

  private target(id: string) {
    return this.candidates().find((c) => c.id === id) ?? null;
  }

  /** Howler (LMB) / Batmobile (RMB): throw the cable; yank what it holds; let go. Works mid-jump too. */
  click() {
    if (!canCable(this.host.car.id)) return;
    const now = performance.now();
    const haul = this.haul;
    if (haul) {
      if (haul.phase === 'hooked') { haul.phase = 'pull'; haul.at = now; }
      else if (haul.phase === 'anchored') { haul.phase = 'reel'; haul.at = now; haul.self = [...this.host.vehicle.position] as Position; haul.selfAlt = this.host.altitude; haul.fromHeading = this.host.vehicle.heading; }
      else if (haul.phase === 'carry') { haul.phase = 'drop'; haul.at = now; }
      else if (haul.kind === 'train' && haul.phase === 'towed' && !haul.reeled) { haul.phase = 'reel'; haul.at = now; haul.ropeFrom = haul.rope; haul.reeled = true; }
      else if (haul.kind === 'train' && (haul.phase === 'towed' || haul.phase === 'reel')) this.releaseTrain();
      else if (haul.phase === 'hang' || haul.phase === 'reel') this.letGoWall();
      return; // flying out, or busy pulling
    }
    const here = this.host.vehicle.position;
    const heading = this.host.vehicle.heading;
    // the cable leaves from the middle of the car (its centre of mass)
    const nose = [...here] as Position;
    const noseAlt = this.host.altitude + 0.9;
    const target = this.host.combatLayer?.aimTarget() ?? null;
    const point: Position = target ? [...target.position] as Position : offsetPosition(here, Math.sin(heading) * HAUL_REACH_M, Math.cos(heading) * HAUL_REACH_M) as Position;
    const groundUp = (at: Position) => (this.host.map.groundAt(at) ?? this.host.altitude) - this.host.altitude;
    // a coin (or bundle of cash) right under the crosshair: the hook takes that one and
    // reels it in by itself
    if (this.host.aimScreen) {
      const [sx, sy] = this.host.aimScreen;
      let best: { id: string; at: Position; d: number } | null = null;
      for (const [id, p] of this.host.pickups) {
        if ((p.kind !== 'coin' && p.kind !== 'cash') || (p.drop && now < p.drop.at + DROP_MS)) continue;
        if (metersBetween(nose, p.position) > HAUL_REACH_M) continue;
        const q = this.host.map.project(p.position);
        // how many pixels a metre is there: the coin hovers ~0.6 m up (higher on screen), and
        // near ones get a catch zone as big as ~2.5 m round them
        const r = this.host.map.project(offsetPosition(p.position, 1, 0) as Position);
        const perMeter = Math.hypot(r.x - q.x, r.y - q.y);
        const d = Math.hypot(q.x - sx, q.y - perMeter * 0.5 - sy);
        if (d <= Math.max(HAUL_COIN_PX, perMeter * 2.5) && (!best || d < best.d)) best = { id, at: [...p.position] as Position, d };
      }
      if (best) {
        this.haul = { id: '', kind: 'coins', car: this.host.car, phase: 'fly', at: now, from: best.at, fromHeading: heading, fromUp: groundUp(best.at) + 0.6, coins: [{ id: best.id, start: best.at }] };
        return;
      }
    }
    // a car under the crosshair (on screen, as big as the car looks there), within the
    // cable's reach of us (to its near side)
    let best: ReturnType<Hauler['candidates']>[number] | null = null;
    let bestD = Infinity;
    for (const c of this.candidates()) {
      if (metersBetween(nose, c.position) - c.car.length / 2 > HAUL_REACH_M) continue;
      if (this.host.aimScreen) {
        const q = this.host.map.project(c.position);
        const tip = this.host.map.project(offsetPosition(c.position, Math.sin(c.heading) * c.car.length / 2, Math.cos(c.heading) * c.car.length / 2) as Position);
        const reach = Math.max(14, Math.hypot(tip.x - q.x, tip.y - q.y) * 0.9 + 6);
        const d = Math.hypot(q.x - this.host.aimScreen[0], q.y - 10 - this.host.aimScreen[1]); // aim at the body, a little above its ground point
        if (d <= reach && d < bestD) { bestD = d; best = c; }
      } else {
        const d = metersBetween(point, c.position);
        if (d <= HAUL_AIM_M && d < bestD) { bestD = d; best = c; }
      }
    }
    if (best) {
      if (best.kind === 'shared') this.host.sharedTraffic.hold(best.id);
      this.haul = { id: best.id, kind: best.kind, car: best.car, phase: 'fly', at: now, from: [...best.position] as Position, fromHeading: best.heading, fromUp: groundUp(best.position) };
      return;
    }
    // a train car by the aim: the hook takes it, and the train takes us
    if (!best) {
      let hit: { trainId: string; at: Position; d: number } | null = null;
      const kx = METERS_PER_DEGREE * Math.cos(point[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
      for (const car of this.host.trainTraffic.poses()) {
        const ax = (car.back[0] - point[0]) * kx, ay = (car.back[1] - point[1]) * ky;
        const bx = (car.front[0] - point[0]) * kx, by = (car.front[1] - point[1]) * ky;
        const dx = bx - ax, dy = by - ay;
        const tt = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        const cx = ax + dx * tt, cy = ay + dy * tt, d = Math.hypot(cx, cy);
        const at: Position = [point[0] + cx / kx, point[1] + cy / ky];
        if (d < 3 && (!hit || d < hit.d) && metersBetween(nose, at) <= HAUL_REACH_M) hit = { trainId: car.trainId, at, d };
      }
      if (hit) {
        this.haul = { id: '', kind: 'train', car: this.host.car, phase: 'fly', at: now, from: hit.at, fromHeading: heading, fromUp: groundUp(hit.at) + 1.4, trainId: hit.trainId };
        return;
      }
    }
    // a wall within reach: the hook bites into it
    if (!best && target?.wall) {
      const reach = Math.hypot(metersBetween(nose, target.position), target.altitude - noseAlt);
      if (reach <= HAUL_REACH_M) {
        this.haul = { id: '', kind: 'wall', car: this.host.car, phase: 'fly', at: now, from: [...target.position] as Position, fromHeading: heading, fromUp: target.altitude - this.host.altitude, hookAlt: target.altitude };
        return;
      }
    }
    // nothing it can hold: out to its full length toward the aim (straight ahead if the aim
    // is on the car itself), a moment there, and back
    const far = metersBetween(nose, point);
    const end: Position = far > 1
      ? [nose[0] + (point[0] - nose[0]) * HAUL_REACH_M / far, nose[1] + (point[1] - nose[1]) * HAUL_REACH_M / far]
      : offsetPosition(nose, Math.sin(heading) * HAUL_REACH_M, Math.cos(heading) * HAUL_REACH_M) as Position;
    this.haul = { id: '', kind: 'wall', car: this.host.car, phase: 'miss', at: now, from: end, fromHeading: 0, fromUp: target?.wall ? Math.min(target.altitude - this.host.altitude, 4) : groundUp(end) + 0.4 };
  }

  /**
   * On a train's cable. The hook flies to the car we aimed at; then the rope runs from the
   * back of the last car, so the train drags us along behind it, straightened out on its
   * line; reeling in brings us up to a couple of metres behind it, never into it.
   */
  private updateTow(haul: Haul, now: number, nose: Position) {
    const layer = this.host.combatLayer;
    const cars = this.host.trainTraffic.poses().filter(car => car.trainId === haul.trainId);
    if (!cars.length) { this.releaseTrain(); return; }
    const last = cars.reduce((a, b) => (b.index > a.index ? b : a));
    const kx = METERS_PER_DEGREE * Math.cos(last.back[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const ex = (last.front[0] - last.back[0]) * kx, ny = (last.front[1] - last.back[1]) * ky;
    const len = Math.hypot(ex, ny) || 1;
    const ue = ex / len, un = ny / len; // the train's way, at its tail
    const tail: Position = [...last.back] as Position;
    const tailUp = (this.host.map.groundAt(tail) ?? this.host.altitude) - this.host.altitude + 1.1;
    const dt = this.towClock ? Math.min(0.1, (now - this.towClock) / 1000) : 0;
    this.towClock = now;
    if (haul.phase === 'fly') {
      const t = Math.min(1, (now - haul.at) / HAUL_FLY_MS);
      layer?.setCable({ position: [nose[0] + (haul.from[0] - nose[0]) * t, nose[1] + (haul.from[1] - nose[1]) * t], up: 0.9 + (haul.fromUp - 0.9) * t, wave: 1 });
      if (t < 1) return;
      haul.phase = 'towed';
      haul.at = now;
      haul.rope = Math.max(3, Math.min(HAUL_SNAP_M, metersBetween(this.host.vehicle.position, tail) - this.host.car.length / 2));
      haul.from = tail;
      this.towed = true;
      return;
    }
    if (haul.phase === 'reel') {
      const t = Math.min(1, (now - haul.at) / 1000);
      haul.rope = (haul.ropeFrom ?? 3) + (2.5 - (haul.ropeFrom ?? 3)) * t * t * (3 - 2 * t);
      if (t >= 1) haul.phase = 'towed';
    }
    // where the rope holds us: behind the tail, on the train's line, nose to it
    const back = (haul.rope ?? 3) + this.host.car.length / 2;
    const spot: Position = [tail[0] - ue * back / kx, tail[1] - un * back / ky];
    const k = dt ? 1 - Math.exp(-dt * 6) : 0;
    const before = this.host.vehicle.position;
    const next: Position = [before[0] + (spot[0] - before[0]) * k, before[1] + (spot[1] - before[1]) * k];
    const moved = metersBetween(before, next);
    this.host.vehicle.position = next;
    const want = Math.atan2(ue, un);
    let turn = (want - this.host.vehicle.heading) % (Math.PI * 2);
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    this.host.vehicle.heading += turn * k;
    // as fast as we are dragged (the speedometer shows it; let go and we roll on with it)
    if (dt) this.towSpeed += (moved / dt - this.towSpeed) * Math.min(1, dt * 4);
    this.host.vehicle.speed = this.towSpeed;
    this.host.renderVehicle.reset(this.host.vehicle);
    layer?.setCable({ position: tail, up: tailUp, wave: 0 });
  }

  /** Off the train's cable: we roll on at the speed it dragged us. */
  private releaseTrain() {
    this.haul = null;
    this.towed = false;
    this.towClock = 0;
    this.host.combatLayer?.setCable(null);
    this.host.vehicle.speed = this.towSpeed;
    this.towSpeed = 0;
  }

  /** Off the wall: the cable goes, we fall. */
  private letGoWall() {
    this.haul = null;
    this.hangAltitude = null;
    this.host.combatLayer?.setCable(null);
    this.host.fall();
  }

  /** Once a frame: fly the cable, hold or yank the car, carry it, reel us up a wall, let go. */
  update(now: number) {
    const haul = this.haul;
    const layer = this.host.combatLayer;
    if (!haul) return;
    const here = this.host.renderVehicle.position as Position, heading = this.host.renderVehicle.heading;
    const ease = (k: number) => k * k * (3 - 2 * k);
    const along = (meters: number) => offsetPosition(here, Math.sin(heading) * meters, Math.cos(heading) * meters) as Position;
    const mix = (a: Position, b: Position, k: number): Position => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    const turn = (a: number, b: number, k: number) => {
      let d = (b - a) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return a + d * k;
    };
    const nose = along(0);
    const k = (ms: number) => Math.min(1, (now - haul.at) / ms);
    /** a fresh bite still quivers a moment, then the line is taut */
    const quiver = (since: number) => 0.35 * Math.exp(-(now - since) / 180);

    if (haul.phase === 'miss') {
      // shoots out, hangs there a moment (still quivering), then winds back in
      const ms = now - haul.at;
      const out = ms < HAUL_MISS_OUT_MS ? ms / HAUL_MISS_OUT_MS
        : ms < HAUL_MISS_OUT_MS + HAUL_MISS_HOLD_MS ? 1
        : Math.max(0, 1 - (ms - HAUL_MISS_OUT_MS - HAUL_MISS_HOLD_MS) / HAUL_MISS_BACK_MS);
      const wave = ms < HAUL_MISS_OUT_MS ? 1 : 0.5;
      layer?.setCable({ position: mix(nose, haul.from, out), up: 0.9 + (haul.fromUp - 0.9) * out, wave });
      if (ms >= HAUL_MISS_OUT_MS + HAUL_MISS_HOLD_MS + HAUL_MISS_BACK_MS) { layer?.setCable(null); this.haul = null; }
      return;
    }

    if (haul.kind === 'train') { this.updateTow(haul, now, nose); return; }
    if (haul.kind === 'coins') {
      // out to them, then straight back in with them hanging on (no click needed)
      if (haul.phase === 'fly') {
        const t = k(HAUL_FLY_MS);
        layer?.setCable({ position: mix(nose, haul.from, t), up: 0.9 + (haul.fromUp - 0.9) * t, wave: 1 });
        if (t >= 1) { haul.phase = 'pull'; haul.at = now; }
        return;
      }
      const t = ease(k(HAUL_COINS_MS));
      const here = this.host.vehicle.position as Position;
      for (const coin of haul.coins ?? []) {
        const pickup = this.host.pickups.get(coin.id);
        if (!pickup) continue;
        const at = mix(coin.start, here, t);
        pickup.position = at;
        layer?.movePickup(coin.id, at);
      }
      layer?.setCable(t < 0.95 ? { position: mix(haul.from, here, t), up: haul.fromUp + (0.9 - haul.fromUp) * t, wave: 0 } : null);
      // in reach of the car now: the next step picks them up as if we drove over them
      if (t >= 1) this.haul = null;
      return;
    }

    if (haul.kind === 'wall') {
      const hookUp = (haul.hookAlt ?? this.host.altitude) - this.host.altitude;
      if (haul.phase === 'fly') {
        const t = k(HAUL_FLY_MS);
        layer?.setCable({ position: mix(nose, haul.from, t), up: 0.9 + (hookUp - 0.9) * t, wave: 1 });
        if (t >= 1) { haul.phase = 'anchored'; haul.at = now; }
        return;
      }
      layer?.setCable({ position: haul.from, up: hookUp, wave: haul.phase === 'anchored' ? quiver(haul.at) : 0 });
      if (haul.phase === 'anchored') {
        if (metersBetween(this.host.vehicle.position, haul.from) > HAUL_SNAP_M) { this.haul = null; layer?.setCable(null); }
        return;
      }
      // reel: up to just under the hook, a step out from the wall, and hang there
      const self = haul.self ?? this.host.vehicle.position;
      const away = metersBetween(self, haul.from) || 1;
      const toWall = Math.atan2((haul.from[0] - self[0]) * Math.cos(self[1] * Math.PI / 180), haul.from[1] - self[1]);
      // whichever face of the car needs the least turn goes to the wall: nose, tail or a side;
      // it stands that face's half size (plus a little) off the hook
      const off = (a: number) => Math.abs(Math.atan2(Math.sin(a - haul.fromHeading), Math.cos(a - haul.fromHeading)));
      const faces = [
        { heading: toWall, gap: this.host.car.length / 2 + 0.5 },
        { heading: toWall + Math.PI, gap: this.host.car.length / 2 + 0.5 },
        { heading: toWall + Math.PI / 2, gap: 1.4 },
        { heading: toWall - Math.PI / 2, gap: 1.4 },
      ];
      const face = faces.reduce((a, b) => (off(b.heading) < off(a.heading) ? b : a));
      const out = Math.min(1, face.gap / away);
      const spot: Position = [haul.from[0] + (self[0] - haul.from[0]) * out, haul.from[1] + (self[1] - haul.from[1]) * out];
      const hangAlt = Math.max(this.host.map.groundAt(spot) ?? -Infinity, (haul.hookAlt ?? this.host.altitude) - 1.9);
      const t = haul.phase === 'reel' ? ease(k(HAUL_REEL_MS)) : 1;
      this.host.vehicle.position = mix(self, spot, t);
      this.host.vehicle.heading = turn(haul.fromHeading, face.heading, t);
      this.host.vehicle.speed = 0;
      this.hangAltitude = (haul.selfAlt ?? this.host.altitude) + (hangAlt - (haul.selfAlt ?? this.host.altitude)) * t;
      this.host.renderVehicle.reset(this.host.vehicle);
      if (haul.phase === 'reel' && t >= 1) haul.phase = 'hang';
      return;
    }

    // a car on the cable: shot to pieces or gone, it lets go
    if ((layer && !layer.isTargetAlive(haul.id)) || !this.candidates().some(c => c.id === haul.id)) {
      this.release(null);
      return;
    }
    const deck = along(-this.host.car.length * HAUL_DECK_BACK);
    const deckUp = this.host.car.length * HAUL_DECK_UP;
    const groundUp = (at: Position) => (this.host.map.groundAt(at) ?? this.host.altitude) - this.host.altitude;
    let position: Position, up: number, facing: number;
    let heldSpeed = 0;
    if (haul.phase === 'fly' || haul.phase === 'hooked') {
      // follow the live car while the hook flies / holds (moving targets included)
      const live = this.target(haul.id);
      if (live) {
        haul.from = [...live.position] as Position;
        haul.fromHeading = live.heading;
        haul.fromUp = groundUp(live.position);
        heldSpeed = live.speed;
      }
      position = haul.from; up = haul.fromUp; facing = haul.fromHeading;
      if (haul.phase === 'fly') {
        const t = k(HAUL_FLY_MS);
        layer?.setCable({ position: mix(nose, haul.from, t), up: 0.9 + (haul.fromUp + 0.8 - 0.9) * t, wave: 1 });
        if (t >= 1) { haul.phase = 'hooked'; haul.at = now; haul.tautAt = undefined; haul.dragAt = now; }
      } else {
        // hooked: winch vs car speed along the rope
        const dt = Math.min(0.05, (now - (haul.dragAt ?? now)) / 1000);
        haul.dragAt = now;
        const lat = nose[1] * Math.PI / 180;
        const kx = METERS_PER_DEGREE * Math.cos(lat), ky = METERS_PER_DEGREE;
        let de = (position[0] - nose[0]) * kx, dn = (position[1] - nose[1]) * ky;
        let dist = Math.hypot(de, dn) || 0.01;
        const ue = de / dist, un = dn / dist; // nose → car
        const carSpeed = live?.speed ?? 0;
        const carVe = Math.sin(facing) * carSpeed, carVn = Math.cos(facing) * carSpeed;
        const haulVe = Math.sin(heading) * this.host.vehicle.speed, haulVn = Math.cos(heading) * this.host.vehicle.speed;
        // +sep = car fleeing along the rope (against the winch)
        const sep = (carVe - haulVe) * ue + (carVn - haulVn) * un;
        heldSpeed = carSpeed;
        if (sep > HAUL_WINCH_MS) {
          // car wins: keep its motion, rope stretches toward max reach
          if (dt > 0) {
            position = offsetPosition(position, carVe * dt, carVn * dt) as Position;
            de = (position[0] - nose[0]) * kx; dn = (position[1] - nose[1]) * ky;
            dist = Math.hypot(de, dn) || 0.01;
          }
          if (dist >= HAUL_REACH_M) {
            const scale = HAUL_REACH_M / dist;
            position = [nose[0] + (position[0] - nose[0]) * scale, nose[1] + (position[1] - nose[1]) * scale] as Position;
            dist = HAUL_REACH_M;
            if (haul.tautAt == null) haul.tautAt = now;
            else if (now - haul.tautAt >= HAUL_TAUT_MS) {
              this.host.say(t('haul.snap'), true);
              this.release({ position, heading: facing });
              return;
            }
          } else {
            haul.tautAt = undefined;
          }
        } else {
          // winch wins: reel the car in; clear stretch timer
          haul.tautAt = undefined;
          const close = (HAUL_WINCH_MS - Math.max(0, sep)) * dt;
          const newDist = Math.max(0.5, dist - close);
          position = [nose[0] + ue * newDist / kx, nose[1] + un * newDist / ky] as Position;
          dist = newDist;
          heldSpeed = carSpeed * Math.exp(-dt * 2.2);
          if (dist <= HAUL_LOAD_M) {
            haul.from = position;
            haul.fromHeading = facing;
            haul.fromUp = groundUp(position);
            haul.phase = 'pull';
            haul.at = now;
            heldSpeed = 0;
          }
        }
        up = groundUp(position);
        haul.from = position;
        haul.fromHeading = facing;
        haul.fromUp = up;
        const taut = haul.tautAt != null;
        layer?.setCable({
          position,
          up: up + 0.8,
          wave: taut ? 0.2 : quiver(haul.at),
        });
        // absolute fail-safe if somehow beyond snap range
        if (dist > HAUL_SNAP_M) {
          this.host.say(t('haul.snap'), true);
          this.release({ position, heading: facing });
          return;
        }
      }
    } else if (haul.phase === 'pull') {
      // yanked: a quick high arc, landing square on the deck
      const t = ease(k(HAUL_PULL_MS));
      position = mix(haul.from, deck, t);
      up = haul.fromUp + (deckUp - haul.fromUp) * t + Math.sin(Math.PI * t) * 2.4;
      facing = turn(haul.fromHeading, heading, t);
      layer?.setCable(t < 0.9 ? { position, up: up + 0.8 } : null);
      if (t >= 1) haul.phase = 'carry';
    } else if (haul.phase === 'carry') {
      position = deck; up = deckUp; facing = heading;
    } else {
      // slides off backwards and drops onto the road behind us
      const t = k(HAUL_DROP_MS);
      const end = along(-(this.host.car.length / 2 + haul.car.length / 2 + 0.6));
      const endUp = (this.host.map.groundAt(end) ?? this.host.altitude) - this.host.altitude;
      position = mix(deck, end, ease(t));
      up = deckUp + (endUp - deckUp) * t * t;
      facing = heading;
      if (t >= 1) { this.release({ position: end, heading }); return; }
    }
    this.place(haul, position, facing, heldSpeed);
    // on the bed: tilted a little nose down (its tail would sink into the bed's raised back) and with the truck
    const onBed = haul.phase === 'carry' ? 1 : haul.phase === 'pull' ? Math.min(1, (now - haul.at) / HAUL_PULL_MS) : haul.phase === 'drop' ? 1 - Math.min(1, (now - haul.at) / HAUL_DROP_MS) : 0;
    layer?.setCarried({ id: haul.id, position, heading: facing, up: up + 0.08 * onBed, pitch: (this.host.modelPitch - HAUL_TILT) * onBed });
  }

  /** The catch's place in the world (so it bumps, is shot at and is seen by others where it is). */
  private place(haul: Haul, position: Position, heading: number, speed = 0) {
    if (haul.kind === 'wall') return;
    if (haul.kind === 'shared') { this.host.sharedTraffic.place(haul.id, position, heading, speed); return; }
    const bot = this.host.trafficBots.find(entry => entry.id === haul.id);
    if (!bot) return;
    bot.controller.position = [...position] as Position;
    bot.controller.heading = heading;
    bot.controller.speed = speed;
    bot.position = [...position] as Position;
    bot.heading = heading;
  }

  /** Let the catch go, standing at `at` (or where it is), finding its way again from there. */
  release(at: { position: Position; heading: number } | null) {
    const haul = this.haul;
    this.haul = null;
    this.host.combatLayer?.setCable(null);
    this.host.combatLayer?.setCarried(null);
    // off a wall: fall from where we hang; off a train: roll on
    if (this.hangAltitude != null) { this.hangAltitude = null; this.host.fall(); }
    if (this.towed) { this.towed = false; this.towClock = 0; this.towSpeed = 0; }
    if (!haul || !haul.id) return;
    if (at) this.place(haul, at.position, at.heading);
    if (haul.kind === 'shared') { this.host.sharedTraffic.hold(null); return; }
    const bot = this.host.trafficBots.find(entry => entry.id === haul.id);
    if (bot) { bot.route = []; bot.routeIndex = 1; bot.repathAt = 0; bot.lastRouteRevision = -1; }
  }

  /** Out of the Howler with a car on it: that car is gone with the truck. */
  lose() {
    const haul = this.haul;
    this.release(null);
    if (!haul?.id) return;
    if (haul.kind === 'shared') this.host.sharedTraffic.drop(haul.id);
    else if (haul.kind === 'bot') {
      this.host.trafficBots = this.host.trafficBots.filter(bot => bot.id !== haul.id);
      this.host.refreshTargets();
    }
  }
}
