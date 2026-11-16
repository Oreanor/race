import { roadStart } from './roadStart.ts';
import { leavesSupport, supportAltitude, type GroundSample } from './groundSupport.ts';
import { offsetPosition, type Position } from './VehicleController.ts';
import { t } from '@/i18n';
import { isVintageTrain } from '@/rendering/TrainsLayer';
import { GRAVITY, METERS_PER_DEGREE, RAMP } from './tuning.ts';
import type { GameEngine } from './GameEngine.ts';

/** What this part reads and drives in the game. */
export type GroundGame = Pick<GameEngine, 'altitude' | 'audio' | 'car' | 'collisions' | 'combatLayer' | 'driving' | 'hauler' | 'map' | 'modelPitch' | 'modelRoll' | 'placeCarAt' | 'rampTool' | 'renderVehicle' | 'say' | 'settings' | 'spawn' | 'trainLayer' | 'trainTraffic' | 'vehicle' | 'water' | 'wheelSampleTime'>;

/**
 * Our car against the ground: the wheels planted on the terrain (height, pitch, roll), flying
 * off crests and ramps under gravity, bridge decks, falling into the river, and trains as walls.
 */
export class Ground {
  constructor(private game: GroundGame) {}

  lastGround: number | null = null;

  wheelTargets = { altitude: 0, pitch: 0, roll: 0, ready: false };

  /** vertical motion: the car flies off crests and ramps under gravity */
  climb = 0;

  airborne = false;

  wasOnRamp = false;

  /** fell in the river: splash → sink → respawn on the nearest shore road */
  plunge: { at: number; waterAlt: number } | null = null;

  plantWheels(dt: number, now = performance.now()) {
    const settle = (current: number, target: number) => {
      const gap = target - current;
      const rate = 14 + Math.min(22, Math.abs(gap) * 8);
      return current + gap * (1 - Math.exp(-dt * rate));
    };
    // A moving car needs the surface every frame. Reusing a 48 ms old wheel
    // target turns a continuous incline into a series of vertical steps.
    if (!this.wheelTargets.ready || Math.abs(this.game.vehicle.speed) > 0.5 || now - this.game.wheelSampleTime >= 48) {
      this.game.wheelSampleTime = now;
      const heading = this.game.renderVehicle.heading;
      const forwardEast = Math.sin(heading);
      const forwardNorth = Math.cos(heading);
      const rightEast = Math.cos(heading);
      const rightNorth = -Math.sin(heading);
      const reach = this.game.car.length * 0.38;
      const track = 0.85;
      // terrain and roofs both support the car; clear a building only above its skin
      const sample = (along: number, side: number) => {
        const at = offsetPosition(this.game.renderVehicle.position, forwardEast * along + rightEast * side, forwardNorth * along + rightNorth * side);
        // pass altitude so overpass seams keep the deck (bare groundAt drops to the road below)
        const terrain = this.game.map.groundAt(at, this.game.altitude);
        // a roof carries the car only if it came from above (a jump, a landing): one far above
        // its wheels is a wall it is touching — long cars' bumpers reach past the wall
        // test, and taking that roof as ground used to lift them onto houses like a ramp
        const top = this.game.collisions.supportAt(at);
        const roof = top != null && top <= this.game.altitude + 0.6 ? top : null;
        if (terrain == null && roof == null) return null;
        return Math.max(terrain ?? -Infinity, roof ?? -Infinity);
      };
      const frontLeft = sample(reach, -track);
      const frontRight = sample(reach, track);
      const rearLeft = sample(-reach, -track);
      const rearRight = sample(-reach, track);
      const known = [frontLeft, frontRight, rearLeft, rearRight].filter((value): value is number => value != null);
      if (known.length) {
        const pair = (a: number | null, b: number | null) => a != null && b != null ? (a + b) / 2 : a ?? b;
        const front = pair(frontLeft, frontRight);
        const rear = pair(rearLeft, rearRight);
        const left = pair(frontLeft, rearLeft);
        const right = pair(frontRight, rearRight);
        const clamp = (value: number) => Math.max(-0.42, Math.min(0.42, value));
        const pitch = front != null && rear != null ? clamp(Math.atan2(front - rear, reach * 2)) : this.game.modelPitch;
        const roll = left != null && right != null ? clamp(Math.atan2(left - right, track * 2)) : this.game.modelRoll;
        const supports: GroundSample[] = [];
        const add = (along: number, side: number, height: number | null) => {
          if (height != null) supports.push({ along, side, height });
        };
        add(reach, -track, frontLeft);
        add(reach, track, frontRight);
        add(-reach, -track, rearLeft);
        add(-reach, track, rearRight);
        // Include the belly and bumpers when crossing a crest or a sharp bank.
        const center = sample(0, 0);
        add(0, 0, center);
        const bumper = this.game.car.length * 0.5;
        add(bumper, 0, sample(bumper, 0));
        add(-bumper, 0, sample(-bumper, 0));
        this.wheelTargets = {
          // Once the centre of mass is outside the deck, a bumper or a wheel
          // still over its edge cannot cantilever the entire car in the air.
          altitude: center != null && this.game.altitude - center > 1 ? center : supportAltitude(supports, pitch, roll),
          pitch: this.game.settings.terrain ? pitch : 0,
          roll: this.game.settings.terrain ? roll : 0,
          ready: true,
        };
      }
    }
    if (!this.wheelTargets.ready) return;
    const clamp = (value: number) => Math.max(-0.5, Math.min(0.5, value));
    const lift = this.game.driving ? this.game.rampTool.lift(this.game.renderVehicle.position) : null;
    let ground = this.wheelTargets.altitude + (lift ?? 0);
    const speed = Math.abs(this.game.vehicle.speed);
    if (this.game.hauler.hangAltitude != null) {
      // on the cable: held up there, no gravity
      this.game.altitude = this.game.hauler.hangAltitude;
      this.airborne = false;
      this.climb = 0;
      this.game.modelPitch = settle(this.game.modelPitch, 0);
      this.game.modelRoll = settle(this.game.modelRoll, 0);
      return;
    }
    if (this.plunge) return;
    if (!this.airborne && lift == null && this.game.altitude <= ground + 0.7
      && !this.onBridgeDeck(this.game.vehicle.position, this.game.altitude) && this.game.water.covers(this.game.vehicle.position)) {
      this.beginPlunge(ground);
      return;
    }
    if (this.airborne) {
      // flying: gravity only; the nose follows the flight path
      this.climb -= GRAVITY * dt;
      this.game.altitude += this.climb * dt;
      this.game.modelPitch = settle(this.game.modelPitch, clamp(Math.atan2(this.climb, Math.max(4, speed)) * 0.8));
      this.game.modelRoll = settle(this.game.modelRoll, 0);
      if (this.game.altitude <= ground) {
        // touchdown: a thump as hard as the fall (climb is the vertical speed, m/s)
        if (this.climb < -2) this.game.audio.land(-this.climb / 14);
        this.game.altitude = ground;
        this.airborne = false;
        this.climb = 0;
        // landed in the river (not on a bridge deck) → splash and pull out on shore
        const elevated = this.onBridgeDeck(this.game.vehicle.position, this.game.altitude);
        if (this.game.water.covers(this.game.vehicle.position, elevated)) this.beginPlunge(ground);
      }
      return;
    }
    // the ground falls away faster than gravity can pull the car down: it flies
    const predicted = this.game.altitude + this.climb * dt - 0.5 * GRAVITY * dt * dt;
    if (lift == null && leavesSupport(this.game.altitude, ground, this.climb, dt, speed, this.wasOnRamp)) {
      this.airborne = true;
      this.game.altitude = predicted;
      this.climb -= GRAVITY * dt;
      if (this.wasOnRamp && this.game.rampTool.ramp) this.game.rampTool.ramp.usedAt = now;
      this.wasOnRamp = false;
      return;
    }
    const before = this.game.altitude;
    if (lift != null) {
      // on the ramp: straight up its slope
      this.game.altitude = ground;
      // up its slope — bigger ramps throw higher
      const ramp = this.game.rampTool.ramp!;
      const kick = Math.sqrt(2 * GRAVITY * Math.max(0.8, ramp.height * 1.4));
      this.climb = Math.min(kick, this.game.vehicle.speed * Math.cos(this.game.vehicle.heading - ramp.heading) * RAMP.grade);
      this.game.modelPitch = settle(this.game.modelPitch, Math.atan2(ramp.height, ramp.length));
    } else {
      this.game.altitude = Math.max(ground, settle(this.game.altitude, ground));
      // a step in the surface (deck seam, curb) is not a launch: the car only gains as much
      // upward speed as a steep road could give it, else a 5 m seam threw it ~90 m up
      const measured = Math.min((this.game.altitude - before) / Math.max(dt, 1e-3), 1 + speed * 0.3);
      this.climb += (measured - this.climb) * (1 - Math.exp(-dt * 8));
      this.game.modelPitch = settle(this.game.modelPitch, this.wheelTargets.pitch);
    }
    this.game.modelRoll = settle(this.game.modelRoll, this.wheelTargets.roll);
    this.wasOnRamp = lift != null;
  }

  /**
   * True when the car is riding an overpass deck (not the road / river under it).
   * Bridge water exemptions only apply up here — must be true as soon as XY is on
   * the deck ribbon at deck height, or the water edge walls off the on-ramp.
   */
  onBridgeDeck(at: Position, altitude: number) {
    return this.game.map.isDeckAt(at, altitude);
  }

  /** Splash, sink under the surface, then appear on the nearest dry road. */
  beginPlunge(waterAlt: number) {
    if (this.plunge) return;
    this.game.audio.splash();
    this.plunge = { at: performance.now(), waterAlt };
    this.airborne = false;
    this.climb = 0;
    this.game.vehicle.speed = 0;
    this.game.vehicle.throttle = 0;
    this.game.combatLayer?.plungeSplash();
    this.game.say(t('hint.sank'), true);
  }

  tickPlunge(now: number) {
    const plunge = this.plunge;
    if (!plunge) return false;
    const age = now - plunge.at;
    // nose down and drop below the surface
    const t = Math.min(1, age / 1600);
    this.game.altitude = plunge.waterAlt - t * 3.2;
    this.game.modelPitch = 0.55 * t;
    this.game.modelRoll = 0.22 * Math.sin(t * Math.PI) * (t > 0.15 ? 1 : 0);
    if (age < 1700) return true;
    // wide rivers: search farther than a normal wreck drop
    const start = this.game.spawn.findFreeRoad(this.game.vehicle.position, 280)
      ?? roadStart(this.game.map, this.game.vehicle.position, () => false, 280);
    if (start) this.game.placeCarAt(start.position);
    else this.game.placeCarAt(this.game.vehicle.position);
    this.game.modelPitch = 0;
    this.game.modelRoll = 0;
    return false;
  }

  /** Train cars near `around` as flat capsules in metres east/north of it, with their ground height. */
  trainBoxes(around: [number, number], reach: number) {
    const kx = METERS_PER_DEGREE * Math.cos(around[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const out: { ax: number; ay: number; bx: number; by: number; half: number; alt: number; vintage: boolean }[] = [];
    for (const car of this.game.trainTraffic.poses()) {
      const ax = (car.front[0] - around[0]) * kx, ay = (car.front[1] - around[1]) * ky;
      const bx = (car.back[0] - around[0]) * kx, by = (car.back[1] - around[1]) * ky;
      if (Math.min(Math.hypot(ax, ay), Math.hypot(bx, by)) > reach) continue;
      const alt = this.game.trainLayer?.carAltitude(car.trainId, car.index) ?? this.game.map.groundAt([(car.front[0] + car.back[0]) / 2, (car.front[1] + car.back[1]) / 2]) ?? this.game.altitude;
      out.push({ ax, ay, bx, by, half: car.kind === 'tram' ? 1.3 : 1.6, alt, vintage: isVintageTrain(car.trainId) });
    }
    return out;
  }

  /** First train car a shot meets (sampled every 0.5 m), for the gun. */
  trainShot(from: [number, number], fromAlt: number, to: [number, number], toAlt: number) {
    const kx = METERS_PER_DEGREE * Math.cos(from[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const ex = (to[0] - from[0]) * kx, ey = (to[1] - from[1]) * ky;
    const length = Math.hypot(ex, ey);
    if (length < 1) return null;
    const boxes = this.trainBoxes(from, length + 30);
    if (!boxes.length) return null;
    const steps = Math.ceil(length / 0.5);
    for (let s = 1; s <= steps; s++) {
      const f = s / steps, x = ex * f, y = ey * f, alt = fromAlt + (toAlt - fromAlt) * f;
      for (const box of boxes) {
        const dx = box.bx - box.ax, dy = box.by - box.ay, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - box.ax) * dx + (y - box.ay) * dy) / l2));
        if (Math.hypot(x - box.ax - dx * t, y - box.ay - dy * t) > box.half) continue;
        if (alt < box.alt - 0.3 || alt > box.alt + 4.2) continue;
        return { point: offsetPosition(from, x, y) as [number, number], altitude: alt, vintage: box.vintage };
      }
    }
    return null;
  }

  /** Trains don't give way: a car touching one is pushed back out beside it and loses its speed. */
  trainBlock(controller: { position: [number, number] | Position; speed: number }, altitude: number) {
    const at = controller.position as [number, number];
    const boxes = this.trainBoxes(at, 40);
    if (!boxes.length) return false;
    let pushed = false;
    let px = 0, py = 0;
    for (const box of boxes) {
      if (Math.abs(box.alt - altitude) > 3) continue;
      const dx = box.bx - box.ax, dy = box.by - box.ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - box.ax) * dx + (py - box.ay) * dy) / l2));
      const cx = box.ax + dx * t, cy = box.ay + dy * t;
      const ox = px - cx, oy = py - cy, dist = Math.hypot(ox, oy);
      const clear = box.half + 1.1;
      if (dist >= clear) continue;
      // out along the shortest way (sideways off the car); dead centre: off to its left
      const nx = dist > 1e-3 ? ox / dist : -dy / Math.sqrt(l2), ny = dist > 1e-3 ? oy / dist : dx / Math.sqrt(l2);
      px = cx + nx * clear;
      py = cy + ny * clear;
      pushed = true;
    }
    if (!pushed) return false;
    controller.position = offsetPosition(at, px, py) as [number, number];
    controller.speed *= -0.2;
    return true;
  }
}
