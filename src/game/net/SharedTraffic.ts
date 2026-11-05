import { cars as carsConfig, vehicleConfig, type Car } from '@/config/vehicle.config';
import { HIT_DAMAGE, NET_HZ, TRAFFIC_MAX, type TrafficCar } from '@/net/protocol';
import type { TargetVehicle, VehicleSceneLayer } from '@/rendering/VehicleLayer';
import { advanceTrafficBot, createTrafficBot, type TrafficBot, type TrafficRoadNetwork } from '../TrafficBots';
import { metersBetween, type Position } from '../VehicleController';

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
};

type Driven = { bot: TrafficBot; deadAt: number };
type Seen = { from: string; car: Car; position: Position; heading: number; goal: Position; goalHeading: number; hp: number; at: number };

const playerNumber = (id: string) => Number(id.replace(/\D/g, '')) || 0;
const carOf = (id: string) => carsConfig.find((c) => c.id === id) ?? carsConfig[0];

export class SharedTraffic {
  private driven: Driven[] = [];
  private seen = new Map<string, Seen>();
  private serial = 0;
  private spawnAt = 0;
  private sentAt = 0;

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

  /** Once a frame: drive or follow, and the cars to show as targets. */
  update(dt: number, now: number): TargetVehicle[] {
    if (!this.host.driving()) { this.driven = []; this.seen.clear(); return []; }
    if (this.leading()) this.drive(dt, now);
    else this.driven = [];
    return [...this.drivenTargets(), ...this.follow(dt, now)];
  }

  /** Another player's traffic, as they last sent it. */
  receive(from: string, cars: TrafficCar[]) {
    const now = performance.now();
    const ids = new Set(cars.map((c) => c.id));
    for (const [id, s] of this.seen) if (s.from === from && !ids.has(id)) this.seen.delete(id);
    for (const c of cars) {
      const known = this.seen.get(c.id);
      if (known) {
        known.goal = c.p; known.goalHeading = c.h; known.hp = c.hp; known.at = now;
        continue;
      }
      this.seen.set(c.id, { from, car: carOf(c.car), position: c.p, heading: c.h, goal: c.p, goalHeading: c.h, hp: c.hp, at: now });
    }
  }

  /** Somebody's bullet hit one of the cars we drive. */
  hitByOther(id: string) {
    if (this.driven.some((d) => d.bot.id === id)) this.host.layer()?.damageTarget(id, HIT_DAMAGE);
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
      if (d.deadAt) continue;
      const config = { ...vehicleConfig, acceleration: Math.min(d.bot.car.acceleration, 9), maxSpeed: Math.min(d.bot.car.maxSpeed, TOP_SPEED) };
      advanceTrafficBot(d.bot, dt, this.host.network, config);
    }
    if (now - this.sentAt >= 1000 / NET_HZ && this.host.myId()) {
      this.sentAt = now;
      const r = (v: number, k = 1000) => Math.round(v * k) / k;
      this.host.send(this.driven.map(({ bot }) => ({
        id: bot.id, car: bot.car.id,
        p: [r(bot.position[0], 1e7), r(bot.position[1], 1e7)], h: r(bot.heading), s: r(bot.controller.speed, 100),
        hp: Math.round(layer?.targetHp(bot.id) ?? 1000),
      })));
    }
  }

  private drivenTargets(): TargetVehicle[] {
    return this.driven.map(({ bot }) => ({ id: bot.id, driver: bot.driver, car: bot.car, position: bot.position, heading: bot.heading }));
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
