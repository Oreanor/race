import { cars as carsConfig, vehicleConfig, type Car } from '@/config/vehicle.config';
import { HIT_DAMAGE, NET_HZ, TRAFFIC_MAX, type TrafficCar } from '@/net/protocol';
import type { TargetVehicle, VehicleSceneLayer } from '@/rendering/VehicleLayer';
import { advanceTrafficBot, createTrafficBot, type TrafficBot, type TrafficRoadNetwork } from '../TrafficBots';
import { metersBetween, VehicleController, type Position } from '../VehicleController';

// Light traffic everybody around sees and can shoot at. Among players near each
// other, the one who joined first drives it: a couple of cars going about their
// business a few hundred meters around, sent to the others like players are.
// Their bullets reach the driver, who keeps the cars' health; a car blown up is
// replaced after a while. Playing alone, you drive your own.

/** cars driven at a time */
const COUNT = Math.min(2, TRAFFIC_MAX);
/** players closer than this share one driver */
const LEAD_RANGE = 1500;
/** new cars appear this far away (m), out of the way */
const SPAWN = { min: 160, max: 520 };
/** a car this far behind is dropped for a new one nearby (m) */
const DROP = 1100;
/** a wreck stays this long before a new car comes (ms) */
const RESPAWN_MS = 10_000;
/** others' traffic not heard of for this long is gone (ms) */
const STALE_MS = 2500;
/** traffic takes it easy */
const TOP_SPEED = 14;
/** parked cars: kept this close (m); new ones only farther than PARK_NEAR so none appears in view */
const PARK_KEEP = 1200;
const PARK_NEAR = 250;
const PARK_MAX = 22;
/** new parked cars no farther than this (m) */
const PARK_FAR = 900;
/** about one kerb spot in three has a car */
const PARK_SHARE = 0.35;
/** police and other people's mission cars never stand parked */
const NOT_PARKED = new Set(['09', '16', '14']);

/** Stable 0..1 from a spot id. */
const spotHash = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

export type TrafficHost = {
  network: TrafficRoadNetwork;
  vehicle: { position: Position; heading: number };
  driving(): boolean;
  layer(): VehicleSceneLayer | null;
  /** our id on the server; null offline */
  myId(): string | null;
  others(): readonly { id: string; position: Position }[];
  send(cars: TrafficCar[]): void;
  hit(id: string): void;
  /** cars of ours everybody should see besides the traffic (the police after us), ids without our prefix */
  extras(): TrafficCar[];
  /** somebody's bullet hit one of those */
  hitExtra(id: string): void;
  /** a car could stand at `at` facing `heading` (no wall, no water) */
  canPark(at: Position, heading: number): boolean;
  /** parking lots nearby (POIs) */
  lots(): Position[];
  /** tell the player who parked `id` that we took it */
  take(id: string): void;
};

/** A car we parked: it stands still until hit or hijacked. */
type Parked = { id: string; spot: string; car: Car; controller: VehicleController };

type Driven = { bot: TrafficBot; deadAt: number };
type Seen = { from: string; car: Car; position: Position; heading: number; goal: Position; goalHeading: number; hp: number; at: number; parked: boolean };

const playerNumber = (id: string) => Number(id.replace(/\D/g, '')) || 0;
const carOf = (id: string) => carsConfig.find((c) => c.id === id) ?? carsConfig[0];

export class SharedTraffic {
  private driven: Driven[] = [];
  private seen = new Map<string, Seen>();
  private serial = 0;
  private spawnAt = 0;
  private sentAt = 0;
  private parked: Parked[] = [];
  /** spots that had a car which got hijacked or wrecked (they stay empty while we are around) */
  private spent = new Map<string, Position>();
  private parkAt = 0;
  private parkedOnce = false;
  /** others' parked cars we took: hidden until their owner stops sending them */
  private taken = new Set<string>();
  /** the car of ours the hauler holds: nothing drives it, it stands where it is put */
  private held: string | null = null;

  constructor(private host: TrafficHost) {}

  /** No player who joined before us is near: we drive the traffic here. */
  leading() {
    const me = this.host.myId();
    if (!me) return true;
    const mine = playerNumber(me);
    const here = this.host.vehicle.position;
    return !this.host.others().some((p) => playerNumber(p.id) < mine && metersBetween(p.position, here) < LEAD_RANGE);
  }

  /** The cars we drive (for bumping into them). */
  bots(): TrafficBot[] {
    const layer = this.host.layer();
    return this.driven.filter((d) => !d.deadAt && layer?.isTargetAlive(d.bot.id) !== false).map((d) => d.bot);
  }

  /** Everything of ours that bumps: the traffic we drive and the cars we parked. */
  bodies(): { id: string; controller: VehicleController; car: Car }[] {
    const layer = this.host.layer();
    return [
      ...this.bots().map((bot) => ({ id: bot.id, controller: bot.controller, car: bot.car })),
      ...this.parked.filter((p) => layer?.isTargetAlive(p.id) !== false).map((p) => ({ id: p.id, controller: p.controller, car: p.car })),
    ];
  }

  /** The nearest parked car (ours or somebody else's) still standing within `reach` m. */
  parkedNear(at: Position, reach: number): { id: string; car: Car; position: Position; heading: number } | null {
    const layer = this.host.layer();
    let best: { id: string; car: Car; position: Position; heading: number } | null = null;
    let bestD = reach;
    for (const p of this.parked) {
      if (layer?.isTargetAlive(p.id) === false) continue;
      const d = metersBetween(at, p.controller.position);
      if (d < bestD) { bestD = d; best = { id: p.id, car: p.car, position: [...p.controller.position] as Position, heading: p.controller.heading }; }
    }
    for (const [id, s] of this.seen) {
      if (!s.parked || this.taken.has(id) || layer?.isTargetAlive(id) === false) continue;
      const d = metersBetween(at, s.position);
      if (d < bestD) { bestD = d; best = { id, car: s.car, position: [...s.position] as Position, heading: s.heading }; }
    }
    return best;
  }

  /** We hijack parked car `id`: ours goes at once; somebody else's, we tell them and hide it. */
  takeParked(id: string) {
    const own = this.parked.find((p) => p.id === id);
    if (own) {
      this.spent.set(own.spot, [...own.controller.position] as Position);
      this.parked = this.parked.filter((p) => p !== own);
      return;
    }
    if (this.seen.delete(id)) {
      this.taken.add(id);
      this.host.take(id);
    }
  }

  /** Our cars the hauler can pick up: the traffic we drive and the cars we parked, still in one piece. */
  holdable(): { id: string; car: Car; position: Position; heading: number; speed: number }[] {
    const layer = this.host.layer();
    return [
      ...this.bots().map((bot) => ({ id: bot.id, car: bot.car, position: bot.position, heading: bot.heading, speed: Math.abs(bot.controller.speed) })),
      ...this.parked.filter((p) => layer?.isTargetAlive(p.id) !== false).map((p) => ({ id: p.id, car: p.car, position: p.controller.position, heading: p.controller.heading, speed: 0 })),
    ];
  }

  /** The hauler holds car `id` (null: lets go). */
  hold(id: string | null) { this.held = id; }

  /** Put a car of ours here (the hauler carries it); a driven one finds its way again from there. */
  place(id: string, position: Position, heading: number) {
    const bot = this.driven.find((d) => d.bot.id === id)?.bot;
    if (bot) {
      bot.controller.position = [...position] as Position;
      bot.controller.heading = heading;
      bot.controller.speed = 0;
      bot.position = [...position] as Position;
      bot.heading = heading;
      bot.route = [];
      bot.routeIndex = 1;
      bot.repathAt = 0;
      bot.lastRouteRevision = -1;
      return;
    }
    const parked = this.parked.find((p) => p.id === id);
    if (parked) {
      parked.controller.position = [...position] as Position;
      parked.controller.heading = heading;
    }
  }

  /** Car `id` is gone for good (the hauler drove off in another car with it). */
  drop(id: string) {
    this.driven = this.driven.filter((d) => d.bot.id !== id);
    const parked = this.parked.find((p) => p.id === id);
    if (parked) {
      this.spent.set(parked.spot, [...parked.controller.position] as Position);
      this.parked = this.parked.filter((p) => p !== parked);
    }
    if (this.held === id) this.held = null;
  }

  /** Somebody hijacked a car we parked. */
  takenByOther(id: string) {
    const own = this.parked.find((p) => p.id === id);
    if (!own) return;
    this.spent.set(own.spot, [...own.controller.position] as Position);
    this.parked = this.parked.filter((p) => p !== own);
  }

  /** Once a frame: drive or follow, and the cars to show as targets. */
  update(dt: number, now: number): TargetVehicle[] {
    if (!this.host.driving()) { this.driven = []; this.parked = []; this.parkedOnce = false; this.seen.clear(); return []; }
    if (this.leading()) {
      this.drive(dt, now);
      this.park(now);
    } else {
      this.driven = [];
      this.parked = [];
      this.parkedOnce = false;
    }
    this.broadcast(now);
    return [...this.drivenTargets(), ...this.follow(dt, now)];
  }

  /**
   * Cars standing at the kerb (about one spot in three, every ~160 m) and in parking lots,
   * from spots everybody computes the same. Only farther than PARK_NEAR once we are going,
   * so none pops up in view; dropped beyond PARK_KEEP.
   */
  private park(now: number) {
    if (now < this.parkAt) return;
    this.parkAt = now + 1000;
    const here = this.host.vehicle.position;
    const me = this.host.myId() ?? 'me';
    const layer = this.host.layer();
    this.parked = this.parked.filter((p) => {
      if (layer && !layer.isTargetAlive(p.id) && layer.targetHp(p.id) === 0) this.spent.set(p.spot, [...p.controller.position] as Position);
      return metersBetween(p.controller.position, here) < PARK_KEEP;
    });
    for (const [spot, at] of this.spent) if (metersBetween(at, here) > PARK_KEEP * 2) this.spent.delete(spot);
    const used = new Set(this.parked.map((p) => p.spot));
    const near = this.parkedOnce ? PARK_NEAR : 30;
    const add = (spot: string, position: Position, heading: number) => {
      if (this.parked.length >= PARK_MAX || used.has(spot) || this.spent.has(spot)) return;
      const d = metersBetween(position, here);
      if (d < near || d > PARK_FAR) return;
      if (!this.host.canPark(position, heading)) return;
      const choices = carsConfig.filter((car) => !NOT_PARKED.has(car.id));
      const car = choices[Math.floor(spotHash(spot + ':car') * choices.length)] ?? carsConfig[0];
      used.add(spot);
      this.parked.push({ id: `${me}:k${this.serial++}`, spot, car, controller: new VehicleController(position, heading * 180 / Math.PI) });
    };
    for (const spot of this.host.network.kerbSpots(here, PARK_FAR)) {
      if (spotHash(spot.id) < PARK_SHARE) add(spot.id, spot.position, spot.heading);
    }
    // parking lots: two or three in a row
    this.host.lots().forEach((lot, n) => {
      const count = 2 + Math.floor(spotHash(`${lot[0].toFixed(5)}:${lot[1].toFixed(5)}`) * 2);
      for (let k = 0; k < count; k++) {
        const at: Position = [lot[0] + (k - (count - 1) / 2) * 2.8 / (111319.49 * Math.cos(lot[1] * Math.PI / 180)), lot[1]];
        add(`lot${n}:${lot[0].toFixed(4)}:${lot[1].toFixed(4)}:${k}`, at, 0);
      }
    });
    this.parkedOnce = true;
  }

  /** NET_HZ times a second: our traffic (when we drive it), our parked cars and our police, to everybody. */
  private broadcast(now: number) {
    const me = this.host.myId();
    if (!me || now - this.sentAt < 1000 / NET_HZ) return;
    this.sentAt = now;
    const layer = this.host.layer();
    const r = (v: number, k = 1000) => Math.round(v * k) / k;
    const at = (p: Position): [number, number] => [r(p[0], 1e7), r(p[1], 1e7)];
    // the police first: the server keeps only the first TRAFFIC_MAX
    const cars: TrafficCar[] = [
      ...this.host.extras().map((c) => ({ ...c, id: `${me}:${c.id}`, p: at(c.p), h: r(c.h), s: r(c.s, 100) })),
      ...this.driven.map(({ bot }) => ({
        id: bot.id, car: bot.car.id, p: at(bot.position), h: r(bot.heading), s: r(bot.controller.speed, 100),
        hp: Math.round(layer?.targetHp(bot.id) ?? 1000),
      })),
      ...this.parked.map((p) => ({
        id: p.id, car: p.car.id, p: at(p.controller.position), h: r(p.controller.heading), s: 0,
        hp: Math.round(layer?.targetHp(p.id) ?? 1000), pk: 1 as const,
      })),
    ];
    // the server drops the connection on an oversized message
    this.host.send(cars.slice(0, TRAFFIC_MAX));
  }

  /** Another player's traffic, as they last sent it. */
  receive(from: string, cars: TrafficCar[]) {
    const now = performance.now();
    const ids = new Set(cars.map((c) => c.id));
    for (const [id, s] of this.seen) if (s.from === from && !ids.has(id)) this.seen.delete(id);
    for (const c of cars) {
      const known = this.seen.get(c.id);
      if (this.taken.has(c.id)) continue; // we drove off in it; the owner hasn't heard yet
      if (known) {
        known.goal = c.p; known.goalHeading = c.h; known.hp = c.hp; known.at = now; known.parked = c.pk === 1;
        continue;
      }
      this.seen.set(c.id, { from, car: carOf(c.car), position: c.p, heading: c.h, goal: c.p, goalHeading: c.h, hp: c.hp, at: now, parked: c.pk === 1 });
    }
  }

  /** Somebody's bullet hit one of the cars we drive, parked, or the police after us. */
  hitByOther(id: string) {
    if (this.driven.some((d) => d.bot.id === id) || this.parked.some((p) => p.id === id)) {
      this.host.layer()?.damageTarget(id, HIT_DAMAGE);
      return;
    }
    const me = this.host.myId();
    if (me && id.startsWith(me + ':')) this.host.hitExtra(id.slice(me.length + 1));
  }

  /** Our bullet hit a target: if somebody else drives it, they keep its health. */
  ourHit(id: string) {
    if (this.seen.has(id)) this.host.hit(id);
  }

  private drive(dt: number, now: number) {
    const layer = this.host.layer();
    const here = this.host.vehicle.position;
    const me = this.host.myId() ?? 'me';
    // wrecks go after a while; cars left far behind go at once
    this.driven = this.driven.filter((d) => {
      if (!d.deadAt && layer && !layer.isTargetAlive(d.bot.id) && layer.targetHp(d.bot.id) === 0) d.deadAt = now;
      if (d.deadAt) return now - d.deadAt < RESPAWN_MS;
      return metersBetween(d.bot.position, here) < DROP;
    });
    // a new car now and then, out of sight down some road
    if (this.driven.length < COUNT && now >= this.spawnAt) {
      this.spawnAt = now + 1500;
      const car = carsConfig[Math.floor(Math.random() * carsConfig.length)];
      const taken = new Set<string>();
      const bot = createTrafficBot(`${me}:t${this.serial++}`, car.name, car, this.host.network, here, this.host.vehicle.heading, taken, 'explore', Math.floor(Math.random() * 1e6), SPAWN);
      // no road found: it would sit on top of us
      if (metersBetween(bot.position, here) >= SPAWN.min * 0.6) this.driven.push({ bot, deadAt: 0 });
    }
    for (const d of this.driven) {
      if (d.deadAt || d.bot.id === this.held) continue;
      const config = { ...vehicleConfig, acceleration: Math.min(d.bot.car.acceleration, 9), maxSpeed: Math.min(d.bot.car.maxSpeed, TOP_SPEED) };
      // give way to us and the other players: brake, then go round — no ramming
      advanceTrafficBot(d.bot, dt, this.host.network, config, [], [here, ...this.host.others().map((p) => p.position)]);
    }
  }

  private drivenTargets(): TargetVehicle[] {
    return [
      ...this.driven.map(({ bot }) => ({ id: bot.id, driver: bot.driver, car: bot.car, position: bot.position, heading: bot.heading })),
      ...this.parked.map((p) => ({ id: p.id, driver: p.car.name, car: p.car, position: p.controller.position, heading: p.controller.heading })),
    ];
  }

  /** Others' cars glide toward their last reported place; their health is the driver's word. */
  private follow(dt: number, now: number): TargetVehicle[] {
    const layer = this.host.layer();
    const out: TargetVehicle[] = [];
    const k = 1 - Math.exp(-dt * 8);
    for (const [id, s] of this.seen) {
      if (now - s.at > STALE_MS) { this.seen.delete(id); continue; }
      s.position = [s.position[0] + (s.goal[0] - s.position[0]) * k, s.position[1] + (s.goal[1] - s.position[1]) * k];
      let turn = (s.goalHeading - s.heading) % (Math.PI * 2);
      if (turn > Math.PI) turn -= Math.PI * 2;
      if (turn < -Math.PI) turn += Math.PI * 2;
      s.heading += turn * k;
      layer?.setTargetHp(id, s.hp);
      out.push({ id, driver: s.car.name, car: s.car, position: s.position, heading: s.heading });
    }
    return out;
  }
}
