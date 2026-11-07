import { cars as carsConfig } from '@/config/vehicle.config';
import { t } from '@/i18n';
import type { TargetVehicle } from '@/rendering/VehicleLayer';
import { metersBetween, type Position } from './VehicleController.ts';

// Parked cars to shoot at while testing effects: ?testcars=N in the address
// (none otherwise). They stand in rings around the car, only where a car could
// drive to; once every one has burnt out, fresh ones come.

/** How many the address asks for. */
export function testCarCount() {
  if (typeof location === 'undefined') return 0;
  const asked = new URLSearchParams(location.search).get('testcars');
  return asked == null ? 0 : Math.max(0, Math.min(20, Number(asked) || 0));
}

export class TestTargets {
  private list: TargetVehicle[] = [];
  private placedAt = 0;
  private serial = 0;

  /** `canPark`: a car could drive from `from` to `at` and stand there (no wall, water or other level). */
  constructor(private canPark: (from: Position, at: Position, heading: number) => boolean) {}

  update(now: number, active: boolean, car: { position: Position; heading: number }, alive: (id: string) => boolean): TargetVehicle[] {
    const count = testCarCount();
    if (!active || !count) { this.list = []; return this.list; }
    if (this.list.length) {
      if (this.list.some((target) => alive(target.id))) { this.placedAt = now; return this.list; }
      if (now - this.placedAt < 8000) return this.list; // let the wrecks burn out first
    } else if (now - this.placedAt < 1000) return this.list; // a try a second at most
    this.placedAt = now;
    const { position, heading } = car;
    const targets: TargetVehicle[] = [];
    // rings around the car, ahead first
    for (let ring = 0; ring < 4 && targets.length < count; ring++) {
      for (let k = 0; k < 12 && targets.length < count; k++) {
        const angle = heading + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5;
        const distance = 14 + ring * 9;
        const at: Position = [
          position[0] + Math.sin(angle) * distance / (111320 * Math.cos(position[1] * Math.PI / 180)),
          position[1] + Math.cos(angle) * distance / 111320,
        ];
        if (targets.some((o) => metersBetween(o.position, at) < 7) || !this.canPark(position, at, angle)) continue;
        const i = targets.length;
        targets.push({ id: `test-${this.serial++}`, driver: `${t('net.testCar')} ${i + 1}`, car: carsConfig[(i * 3 + 1) % carsConfig.length], position: at, heading: heading + i * 1.3 });
      }
    }
    if (targets.length) this.list = targets; // walled in: try again after we move
    return this.list;
  }
}
