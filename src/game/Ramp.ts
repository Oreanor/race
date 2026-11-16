import type { Car } from '@/config/vehicle.config';
import type { VehicleSceneLayer } from '@/rendering/VehicleLayer';
import type { ThreeMap } from '@/world3d/map/ThreeMap';
import { offsetPosition, type VehicleController } from './VehicleController.ts';
import { metersBetween } from './meters.ts';
import { METERS_PER_DEGREE, RAMP } from './tuning.ts';

/** What the ramp needs from the game: the ground, our car, the layer that draws it. */
export interface RampHost {
  readonly map: ThreeMap;
  readonly altitude: number;
  readonly combatLayer: VehicleSceneLayer | null;
  readonly driving: boolean;
  readonly paused: boolean;
  readonly airborne: boolean;
  readonly vehicle: VehicleController;
  readonly car: Car;
}

/**
 * J: a ramp ahead of the nose. Held, it grows; released, it stays where it is (one at a
 * time) until we jump off it or leave it far behind.
 */
export class Ramp {
  /** the ramp put down (gone shortly after the jump) */
  ramp: { start: [number, number]; heading: number; usedAt: number; length: number; height: number; width: number } | null = null;
  /** holding J: the preview grows until release */
  private charge: { start: [number, number]; heading: number; ground: number; length: number } | null = null;

  constructor(private host: RampHost) {}

  /** J is held: a preview is growing */
  get charging() {
    return this.charge != null;
  }

  private groundAt(point: [number, number]) {
    return this.host.map.groundAt(point) ?? this.host.altitude;
  }

  private pose(length: number, start: [number, number], heading: number) {
    const end = offsetPosition(start, Math.sin(heading) * length, Math.cos(heading) * length) as [number, number];
    const ground = this.groundAt(start);
    const tilt = Math.atan2(this.groundAt(end) - ground, length);
    const height = length * RAMP.grade;
    return { ground, tilt, height, width: RAMP.width };
  }

  private showAt(start: [number, number], heading: number, length: number, usedAt = 0) {
    const { ground, tilt, height, width } = this.pose(length, start, heading);
    this.ramp = { start, heading, usedAt, length, height, width };
    this.host.combatLayer?.setRamp({ position: start, heading, ground, tilt, length, height, width });
  }

  /** Hold J: start a growing preview ahead of the nose. */
  begin() {
    if (!this.host.driving || this.host.paused || this.host.airborne) return;
    const heading = this.host.vehicle.heading;
    const start = offsetPosition(
      this.host.vehicle.position,
      Math.sin(heading) * this.host.car.length * 1.5,
      Math.cos(heading) * this.host.car.length * 1.5,
    ) as [number, number];
    const length = RAMP.minLength;
    this.charge = { start, heading, ground: this.groundAt(start), length };
    this.showAt(start, heading, length);
  }

  /** Release J: lock the charged size in place (through anything). */
  commit() {
    const charge = this.charge;
    this.charge = null;
    if (!charge || !this.host.driving) return;
    this.showAt(charge.start, charge.heading, charge.length);
  }

  /** Height of the ramp surface under this point (driving onto it head-on), or null. */
  /**
   * `margin`: also count this many meters short of its foot and past its lip (the water
   * looks ahead of the car; the flight starts a step after the lip)
   */
  lift(position: [number, number], margin = 0) {
    const ramp = this.ramp;
    if (!ramp || ramp.usedAt) return null;
    if (Math.cos(this.host.vehicle.heading - ramp.heading) < 0.5) return null;
    const east = (position[0] - ramp.start[0]) * METERS_PER_DEGREE * Math.cos(ramp.start[1] * Math.PI / 180);
    const north = (position[1] - ramp.start[1]) * METERS_PER_DEGREE;
    const along = east * Math.sin(ramp.heading) + north * Math.cos(ramp.heading);
    const side = east * Math.cos(ramp.heading) - north * Math.sin(ramp.heading);
    if (along < -margin || along > ramp.length + margin || Math.abs(side) > ramp.width / 2 + 0.3) return null;
    return Math.max(0, Math.min(ramp.length, along)) / ramp.length * ramp.height;
  }

  /** Grow the preview while J is held; clear the ramp after a jump or when left behind. */
  update(now: number, dt: number) {
    if (this.charge && this.host.driving && !this.host.paused) {
      this.charge.length = Math.min(RAMP.maxLength, this.charge.length + RAMP.growPerSec * dt);
      this.showAt(this.charge.start, this.charge.heading, this.charge.length);
      return;
    }
    const ramp = this.ramp;
    if (!ramp) return;
    const far = metersBetween(ramp.start, this.host.vehicle.position) > 300;
    if (far || (ramp.usedAt && now - ramp.usedAt > 900)) {
      this.ramp = null;
      this.host.combatLayer?.setRamp(null);
    }
  }
}
