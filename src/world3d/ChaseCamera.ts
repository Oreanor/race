import * as THREE from 'three';
import { cameraConfig } from '@/config/camera.config';

/**
 * Third-person chase camera. Uses the same tuning knobs as the MapLibre mode
 * (distance, pitch limits from camera.config) but a real perspective camera,
 * so distance is honest meters instead of a zoom level.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  distance = cameraConfig.distance;
  /** degrees from vertical, like MapLibre pitch */
  pitch = 70;
  /** user orbit around the car, degrees */
  orbit = 0;
  private heading = 0;
  private target = new THREE.Vector3();
  private initialised = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.5, 4000);
  }

  zoom(deltaY: number) {
    this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(deltaY * 0.001), cameraConfig.minDistance, cameraConfig.maxDistance * 3);
  }

  drag(dx: number, dy: number, sensitivity = 1) {
    this.orbit += dx * 0.22 * sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.12 * sensitivity, cameraConfig.minPitch, 85);
  }

  reset() {
    this.orbit = 0;
    this.pitch = 70;
    this.distance = cameraConfig.distance;
  }

  /** Shift with the floating origin so smoothing does not see a jump. */
  shift(dx: number, dz: number) {
    this.target.x += dx;
    this.target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
  }

  /**
   * car: scene position; heading: radians clockwise from north;
   * speed in m/s pulls the look point ahead like the MapLibre chase.
   */
  update(dt: number, car: THREE.Vector3, heading: number, speed: number) {
    if (!this.initialised) {
      this.heading = heading;
      this.target.copy(car);
      this.initialised = true;
    }
    const follow = 1 - Math.exp(-dt * 4.5);
    const turn = Math.atan2(Math.sin(heading - this.heading), Math.cos(heading - this.heading));
    this.heading += turn * follow;
    this.target.lerp(car, 1 - Math.exp(-dt * 14));

    const yaw = this.heading + this.orbit * Math.PI / 180;
    const forwardX = Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const elevation = (90 - this.pitch) * Math.PI / 180;
    const ahead = Math.min(8, Math.abs(speed) * 0.25) * Math.sign(speed || 1);
    const look = new THREE.Vector3(this.target.x + forwardX * ahead, this.target.y + 1.2, this.target.z + forwardZ * ahead);
    const horizontal = this.distance * Math.cos(elevation);
    this.camera.position.set(
      look.x - forwardX * horizontal,
      look.y + Math.max(1.2, this.distance * Math.sin(elevation)),
      look.z - forwardZ * horizontal,
    );
    this.camera.lookAt(look);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
