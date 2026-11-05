import type { Position } from './VehicleController.ts';

export type Pose = { position: Position; heading: number; throttle: number; slip?: number; speed?: number };

// Rendering stays one physics step behind, so it never predicts through a wall.
export class VehiclePose {
  position: Position = [0, 0];
  heading = 0;
  throttle = 0;
  slip = 0;
  speed = 0;
  private previous: Position = [0, 0];
  private previousHeading = 0;

  capture(vehicle: Pose) {
    this.previous[0] = vehicle.position[0];
    this.previous[1] = vehicle.position[1];
    this.previousHeading = vehicle.heading;
  }

  reset(vehicle: Pose) {
    this.capture(vehicle);
    this.update(vehicle, 1);
  }

  update(vehicle: Pose, alpha: number) {
    const t = Math.max(0, Math.min(1, alpha));
    this.position[0] = this.previous[0] + (vehicle.position[0] - this.previous[0]) * t;
    this.position[1] = this.previous[1] + (vehicle.position[1] - this.previous[1]) * t;
    const turn = vehicle.heading - this.previousHeading;
    this.heading = this.previousHeading + Math.atan2(Math.sin(turn), Math.cos(turn)) * t;
    this.throttle = vehicle.throttle;
    this.slip = vehicle.slip ?? 0;
    this.speed = vehicle.speed ?? 0;
  }
}
