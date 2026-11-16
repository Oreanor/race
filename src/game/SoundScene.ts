import { isVintageTrain } from '@/rendering/TrainsLayer';
import { bearingTo } from './Bounty.ts';
import { AMBULANCE_ID, FIRE_TRUCK_ID, POLICE_IDS } from './tuning.ts';
import type { GameEngine } from './GameEngine.ts';

/** What this part reads and drives in the game. */
export type SoundSceneGame = Pick<GameEngine, 'approachFrom' | 'audio' | 'beaconsOn' | 'car' | 'coins' | 'collisions' | 'combatLayer' | 'crime' | 'driving' | 'fuel' | 'ground' | 'keys' | 'map' | 'mapShown' | 'nitro' | 'paused' | 'settings' | 'sharedTraffic' | 'trafficBots' | 'trainLayer' | 'trainTraffic' | 'vehicle'>;

/**
 * The world as heard each frame, and the trains on the real tracks: our engine and tyres,
 * the street, sirens, other cars' engines and the trains rolling by.
 */
export class SoundScene {
  constructor(private game: SoundSceneGame) {}

  /** trains' lead cars last frame: for their speed (Doppler, clack rate) */
  trainHeard = new Map<string, { at: number; front: [number, number] }>();

  /** Trains run in the menu and while driving; born and retired out of sight. */
  updateTrains(dt: number) {
    if (!this.game.trainLayer || !this.game.mapShown) return;
    const center = this.game.map.getCenter();
    const here: [number, number] = this.game.driving ? this.game.vehicle.position : [center.lng, center.lat];
    const bearing = this.game.map.getBearing();
    // behind the camera = more than ~110° off where it looks
    const hidden = (p: [number, number]) => {
      const off = Math.abs(((bearingTo(here, p) - bearing + 540) % 360) - 180);
      return off > 110;
    };
    this.game.trainTraffic.update(dt, here, hidden);
    this.game.trainLayer.setCars(this.game.trainTraffic.poses(), here, this.game.settings.terrain);
  }

  /** The scene as heard this frame: our car, the street, sirens, engines and trains around. */
  soundFrame(now: number) {
    const velocityOf = (speed: number, heading: number): [number, number] => [Math.sin(heading) * speed, Math.cos(heading) * speed];
    if (now - this.game.coins.urbanAt > 2000) {
      this.game.coins.urbanAt = now;
      // houses in the collision reach around us: a crowded street hums, a field is quiet
      this.game.coins.urbanLevel = Math.min(1, this.game.collisions.polygons.length / 400);
    }
    const alive = (id: string) => this.game.combatLayer?.isTargetAlive(id) !== false;
    const police = this.game.crime.heist
      ? this.game.trafficBots.filter((bot) => bot.id.startsWith('police') && alive(bot.id))
        .map((bot) => ({ id: bot.id, position: bot.position as [number, number], velocity: velocityOf(bot.controller.speed, bot.controller.heading) }))
      : [];
    const engines = [
      ...this.game.trafficBots.filter((bot) => !bot.id.startsWith('police') && alive(bot.id)),
      ...this.game.sharedTraffic.drivenBodies().map((body) => ({ id: body.id, position: body.controller.position, controller: body.controller })),
    ].map((bot) => ({ id: bot.id, position: bot.position as [number, number], velocity: velocityOf(bot.controller.speed, bot.controller.heading) }));
    // trains: the lead car of each, its speed from the last frame
    const trains = [];
    const seen = new Set<string>();
    for (const car of this.game.trainTraffic.poses()) {
      if (car.index !== 0) continue;
      seen.add(car.trainId);
      const last = this.trainHeard.get(car.trainId);
      const dt = last ? (now - last.at) / 1000 : 0;
      const velocity: [number, number] = last && dt > 0
        ? [(car.front[0] - last.front[0]) * 111_319.49 * Math.cos(car.front[1] * Math.PI / 180) / dt, (car.front[1] - last.front[1]) * 111_319.49 / dt]
        : [0, 0];
      this.trainHeard.set(car.trainId, { at: now, front: [...car.front] as [number, number] });
      trains.push({ id: car.trainId, position: [...car.front] as [number, number], velocity, kind: car.kind, vintage: isVintageTrain(car.trainId) });
    }
    for (const id of this.trainHeard.keys()) if (!seen.has(id)) this.trainHeard.delete(id);
    // our own siren while our lights are on
    const ownSiren = !this.game.beaconsOn ? null
      : this.game.car.id === AMBULANCE_ID ? 'ambulance' as const
        : POLICE_IDS.has(this.game.car.id) || this.game.car.id === FIRE_TRUCK_ID ? 'police' as const : null;
    const travel = this.game.vehicle.heading - this.game.vehicle.slip;
    this.game.audio.frame({
      active: this.game.driving && !this.game.paused && !this.game.approachFrom && !this.game.ground.plunge,
      revs: this.game.vehicle.revs,
      speed: this.game.vehicle.speed,
      throttle: this.game.keys.has('KeyW'),
      boost: this.game.nitro.active && !this.game.fuel.empty,
      slip: this.game.vehicle.slip,
      litres: this.game.car.engine,
      position: this.game.vehicle.position as [number, number],
      heading: this.game.vehicle.heading,
      velocity: velocityOf(this.game.vehicle.speed, travel),
      ear: this.game.map.cameraRange(),
      night: this.game.map.nightLevel(),
      urban: this.game.coins.urbanLevel,
      police,
      ownSiren,
      engines,
      trains,
    });
  }
}
