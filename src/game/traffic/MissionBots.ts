import { vehicleConfig } from '@/config/vehicle.config';
import type { VehicleSceneLayer } from '@/rendering/VehicleLayer';
import type { ThreeMap } from '@/world3d/map/ThreeMap';
import type { BuildingCollisions } from '../BuildingCollisions.ts';
import type { WaterCollisionController } from '../WaterCollisionController.ts';
import { advanceTrafficBot, type TrafficBot, type TrafficRoadNetwork } from '../TrafficBots.ts';
import { offsetPosition, type Position, type VehicleController } from '../VehicleController.ts';
import { metersBetween } from '../meters.ts';
import { policePace } from '../crime/Heist.ts';

/** a racer looks this far (m) straight toward the flag: clear of houses and water → it cuts across */
const RACE_LOOK_M = 400;

/** What the mission bots' driving needs from the game. */
export interface BotDriverHost {
  readonly trafficBots: TrafficBot[];
  readonly vehicle: VehicleController;
  readonly altitude: number;
  readonly mode: 'roam' | 'arena' | 'race';
  readonly combatLayer: VehicleSceneLayer | null;
  readonly trafficNetwork: TrafficRoadNetwork;
  readonly collisions: BuildingCollisions;
  readonly water: WaterCollisionController;
  readonly map: ThreeMap;
  onBridgeDeck(at: Position, altitude: number): boolean;
}

/**
 * The mission bots (racers, arena rivals, the police, the wanted car, job cars) at the
 * wheel: along the roads or straight across when the way is clear, kept out of houses
 * and water, and freed when they get stuck.
 */
export class MissionBotDriver {
  /** each chasing bot's last look at its target: is the way clear of houses (checked every 300 ms) */
  private sight = new Map<string, { at: number; clear: boolean }>();
  /** hunters that got stuck: no cutting across until then (ms) */
  private noCut = new Map<string, number>();
  /** where each hunter last made headway (for spotting a stuck one) */
  private progress = new Map<string, { at: number; position: Position }>();

  constructor(private host: BotDriverHost) {}

  /** Forget a bot's look at its target (a new goal), or every bot's (a new event). */
  forget(id?: string) {
    if (id == null) this.sight.clear();
    else this.sight.delete(id);
  }

  /**
   * Where a bot may cut straight to, off the roads: a hunter (police, arena, the wanted car)
   * at its prey, a racer at the flag — when it is within 350 m and no house stands between.
   * At us it leads the shot a little (where we will be in half a second).
   */
  private shortcut(bot: { id: string; mood: string; goal: Position | null; huntId: string | null; position: Position }, now: number): Position | null {
    const racing = this.host.mode === 'race' && Boolean(bot.goal);
    if (bot.mood !== 'hunt' && !racing) return null;
    let target = bot.goal;
    if (bot.mood === 'hunt' && bot.huntId === 'player') {
      const v = this.host.vehicle.speed * 0.5;
      target = offsetPosition(this.host.vehicle.position, Math.sin(this.host.vehicle.heading) * v, Math.cos(this.host.vehicle.heading) * v) as Position;
    }
    if (!target) return null;
    // a racer heads cross-country toward the flag whenever the next RACE_LOOK_M straight
    // that way are clear (like we can: a stream line is no obstacle, only houses and real
    // water); a hunter only cuts in on the last 350 m
    const far = metersBetween(bot.position, target);
    if (racing && bot.mood !== 'hunt' && far > RACE_LOOK_M) {
      const k = RACE_LOOK_M / far;
      target = [bot.position[0] + (target[0] - bot.position[0]) * k, bot.position[1] + (target[1] - bot.position[1]) * k];
    } else if (far > 350) return null;
    // stuck lately (a river bank, a fence): keep to the roads for a while
    if ((this.noCut.get(bot.id) ?? 0) > now) return null;
    let sight = this.sight.get(bot.id);
    // a blocked view is looked at again only after 1.5 s: flipping between cutting and the
    // roads re-plans the route each time (a Dijkstra), which costs frames
    if (!sight || now - sight.at > (sight.clear ? 300 : 1500)) {
      sight = { at: now, clear: !this.host.collisions.sightBlocked(bot.position, target) && !this.waterBetween(bot.position, target) };
      this.sight.set(bot.id, sight);
    }
    return sight.clear ? target : null;
  }

  /** Water anywhere on the straight line (bridges count as dry): no cutting across a river. */
  private waterBetween(from: Position, to: Position) {
    const steps = Math.max(1, Math.ceil(metersBetween(from, to) / 12));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      if (this.host.water.covers([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k], true)) return true;
    }
    return false;
  }

  /**
   * A hunter that has hardly moved for 2.5 s (not while it is on top of us) is stuck:
   * no cutting across for 6 s, and a fresh road route round the obstacle.
   */
  private unstick(bot: TrafficBot, now: number) {
    const seen = this.progress.get(bot.id);
    const close = metersBetween(bot.position, this.host.vehicle.position) < 15;
    if (!seen || close || metersBetween(seen.position, bot.position) > 4) {
      this.progress.set(bot.id, { at: now, position: [...bot.position] as Position });
      return;
    }
    if (now - seen.at < 2500) return;
    this.noCut.set(bot.id, now + 6000);
    bot.cutting = false;
    bot.route = [];
    bot.routeIndex = 1;
    bot.repathAt = 0;
    bot.routeSeed = (bot.routeSeed * 48271 + 1) % 2147483647;
    this.progress.set(bot.id, { at: now, position: [...bot.position] as Position });
  }

  /** One physics step (1/60 s) of every mission bot: drive, then houses and water stop it. */
  step(now: number, skip: (bot: TrafficBot) => boolean) {
    const peers = [
      { id: 'player', position: this.host.vehicle.position as [number, number], alive: true },
      ...this.host.trafficBots.map(bot => ({
        id: bot.id,
        position: bot.position,
        alive: !this.host.combatLayer || this.host.combatLayer.isTargetAlive(bot.id),
      })),
    ];
    for (const bot of this.host.trafficBots) {
      if (skip(bot)) continue;
      if (this.host.combatLayer && !this.host.combatLayer.isTargetAlive(bot.id)) continue;
      const previous: [number, number] = [...bot.position];
      const oldHeading = bot.heading;
      const police = bot.id.startsWith('police');
      const pace = police ? policePace(bot) : {
        ...vehicleConfig,
        acceleration: bot.car.acceleration,
        maxSpeed: bot.car.maxSpeed,
      };
      // the police and racers really drive at their car's pace (the town pace was ~55–70 km/h)
      const racer = this.host.mode === 'race' && bot.id.startsWith('race-');
      advanceTrafficBot(bot, 1 / 60, this.host.trafficNetwork, pace, police ? peers.slice(0, 1) : peers, [], this.shortcut(bot, now), police || racer ? pace.maxSpeed : null);
      if (bot.mood === 'hunt' || racer) this.unstick(bot, now);
      const building = this.host.collisions.resolve(previous, bot.position, bot.heading);
      if (building.stopped || building.slid) {
        bot.controller.position = building.position;
        bot.retryFrames += building.stopped ? 6 : 2;
        const side = (bot.id.charCodeAt(bot.id.length - 1) + bot.retryFrames) % 2 ? 1 : -1;
        if (building.stopped) {
          // Back out of the corner instead of parking against the wall.
          bot.controller.heading = oldHeading + side * (0.55 + (bot.retryFrames % 7) * 0.05);
          bot.controller.speed = -2.6;
        } else {
          bot.controller.speed *= 0.96;
          if (Math.abs(bot.controller.speed) < 1.2) {
            bot.controller.heading = oldHeading + side * 0.35;
            bot.controller.speed = Math.max(bot.controller.speed, 1.5);
          }
        }
        if (bot.retryFrames > 18 && bot.routeIndex < bot.route.length - 1) {
          bot.routeIndex++;
          bot.retryFrames = 0;
        } else if (bot.retryFrames > 40) {
          bot.route = [];
          bot.routeIndex = 1;
          bot.routeSeed = (bot.routeSeed * 48271 + 1) % 2147483647;
          bot.retryFrames = 0;
          bot.controller.heading += side * 0.9;
        }
      } else {
        const botAlt = this.host.map.groundAt(previous) ?? this.host.altitude;
        const elev = this.host.onBridgeDeck(previous, botAlt);
        if (this.host.water.covers(previous, elev)) {
          const hit = this.host.water.resolve(previous, bot.position, bot.heading, 1, elev);
          bot.controller.position = hit.position;
          if (hit.stopped) bot.controller.speed = 0;
          bot.retryFrames = Math.max(0, bot.retryFrames - 2);
        } else {
          bot.retryFrames = Math.max(0, bot.retryFrames - 3);
        }
      }
      bot.position = [...bot.controller.position];
      bot.heading = bot.controller.heading;
    }
  }
}
