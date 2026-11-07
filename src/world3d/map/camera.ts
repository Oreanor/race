import * as THREE from 'three';

// MapLibre's Mercator camera, reproduced so existing gameplay code (zoom, pitch,
// bearing, jumpTo) and the existing custom Three.js layers keep working as is.
// Port of MercatorTransform._calcMatrices (maplibre-gl 6, no roll, no offset).

/** MapLibre's earth radius; its "meters" in custom layers use this. */
export const MAPLIBRE_EARTH_RADIUS = 6371008.8;
const TILE_SIZE = 512;
const MAX_HORIZON_ANGLE = 89.25;
export const DEFAULT_FOV = 36.87;

export type CameraState = {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  /** ground elevation at the center, meters (already exaggerated) */
  elevation: number;
  width: number;
  height: number;
  fov: number;
};

export function mercatorX01(lng: number) { return (180 + lng) / 360; }
export function mercatorY01(lat: number) {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}
export function lngFrom01(x: number) { return x * 360 - 180; }
export function latFrom01(y: number) { return (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90; }
/** Mercator units (0..1 world) per meter at a latitude, MapLibre convention. */
export function mercatorPerMeter(lat: number) {
  return 1 / (2 * Math.PI * MAPLIBRE_EARTH_RADIUS * Math.cos((lat * Math.PI) / 180));
}

export class MapCamera {
  state: CameraState = { center: [0, 0], zoom: 16, pitch: 0, bearing: 0, elevation: 0, width: 1, height: 1, fov: DEFAULT_FOV };
  /** world pixels (x, y at worldSize, z meters) → clip */
  readonly viewProj = new THREE.Matrix4();
  readonly invViewProj = new THREE.Matrix4();
  /** mercator 0..1 (z in mercator units) → clip: MapLibre's custom layer mainMatrix */
  readonly mainMatrix = new THREE.Matrix4();
  /** camera position in mercator 0..1 (z in mercator units) */
  readonly cameraMercator = new THREE.Vector3();
  worldSize = 1;
  pixelsPerMeter = 1;
  cameraToCenterDistance = 1;

  update() {
    const s = this.state;
    const fovRad = (s.fov * Math.PI) / 180;
    this.worldSize = TILE_SIZE * 2 ** s.zoom;
    this.pixelsPerMeter = mercatorPerMeter(s.center[1]) * this.worldSize;
    this.cameraToCenterDistance = (0.5 / Math.tan(fovRad / 2)) * s.height;
    const x = mercatorX01(s.center[0]) * this.worldSize;
    const y = mercatorY01(s.center[1]) * this.worldSize;
    const pitchRad = (s.pitch * Math.PI) / 180;
    const limitedPitch = (Math.min(s.pitch, MAX_HORIZON_ANGLE) * Math.PI) / 180;
    const cameraToSeaLevel = Math.max(this.cameraToCenterDistance / 2, this.cameraToCenterDistance + (s.elevation * this.pixelsPerMeter) / Math.cos(limitedPitch));

    // far plane: same construction as MapLibre (horizon-limited)
    const minElevation = Math.min(s.elevation, this.cameraAltitude() - 100);
    const lowest = minElevation < 0 ? cameraToSeaLevel - (minElevation * this.pixelsPerMeter) / Math.cos(limitedPitch) : cameraToSeaLevel;
    const groundAngle = Math.PI / 2 + pitchRad;
    const fovAbove = fovRad * 0.5;
    const clamp = (v: number) => Math.min(Math.PI - 0.01, Math.max(0.01, v));
    const topHalf = (Math.sin(fovAbove) * lowest) / Math.sin(clamp(Math.PI - groundAngle - fovAbove));
    const horizon = this.cameraToCenterDistance * Math.min(Math.tan(((90 - s.pitch) * Math.PI) / 180) * 0.85, Math.tan(((MAX_HORIZON_ANGLE - s.pitch) * Math.PI) / 180));
    const horizonAngle = Math.atan(horizon / this.cameraToCenterDistance);
    const minToHorizon = ((90 - MAX_HORIZON_ANGLE) * Math.PI) / 180;
    const toHorizon = horizonAngle > minToHorizon ? 2 * horizonAngle * 0.5 : minToHorizon;
    const topHalfHorizon = (Math.sin(toHorizon) * lowest) / Math.sin(clamp(Math.PI - groundAngle - toHorizon));
    const farZ = (Math.cos(Math.PI / 2 - limitedPitch) * Math.min(topHalf, topHalfHorizon) + lowest) * 1.01;
    // Near plane in *meters*, not raw screen px. `height/N` grows on tall canvases
    // and clips bumper-cam façades → a floating far wall / roof with a gap to the street.
    const nearMeters = 0.75;
    const nearZ = Math.max(
      0.8,
      Math.min(this.cameraToCenterDistance * 0.025, nearMeters * this.pixelsPerMeter),
    );

    const top = nearZ * Math.tan(fovRad / 2);
    const right = top * (s.width / s.height);
    const m = new THREE.Matrix4().makePerspective(-right, right, top, -top, nearZ, farZ);
    m.multiply(new THREE.Matrix4().makeScale(1, -1, 1));
    m.multiply(new THREE.Matrix4().makeTranslation(0, 0, -this.cameraToCenterDistance));
    m.multiply(new THREE.Matrix4().makeRotationX(pitchRad));
    m.multiply(new THREE.Matrix4().makeRotationZ((-s.bearing * Math.PI) / 180));
    m.multiply(new THREE.Matrix4().makeTranslation(-x, -y, 0));
    m.multiply(new THREE.Matrix4().makeScale(1, 1, this.pixelsPerMeter));
    m.multiply(new THREE.Matrix4().makeTranslation(0, 0, -s.elevation));
    this.viewProj.copy(m);
    this.invViewProj.copy(m).invert();
    // custom layer matrix: mercator 0..1 and z in mercator units
    this.mainMatrix.copy(m).multiply(new THREE.Matrix4().makeScale(this.worldSize, this.worldSize, this.worldSize / this.pixelsPerMeter));

    const eye = new THREE.Vector4(0, 0, -1, 1).applyMatrix4(this.invViewProj);
    this.cameraMercator.set(eye.x / eye.w / this.worldSize, eye.y / eye.w / this.worldSize, (eye.z / eye.w) * mercatorPerMeter(s.center[1]));
  }

  cameraAltitude() {
    const s = this.state;
    const altitude = (Math.cos((Math.min(s.pitch, MAX_HORIZON_ANGLE) * Math.PI) / 180) * this.cameraToCenterDistance) / this.pixelsPerMeter;
    return altitude + s.elevation;
  }

  /** lng/lat at `altitude` meters → CSS pixels. Behind the camera gives non-finite values. */
  project(lng: number, lat: number, altitude = 0) {
    const v = new THREE.Vector4(mercatorX01(lng) * this.worldSize, mercatorY01(lat) * this.worldSize, altitude, 1).applyMatrix4(this.viewProj);
    if (v.w <= 0) return { x: Number.NaN, y: Number.NaN };
    return { x: (v.x / v.w + 1) * 0.5 * this.state.width, y: (1 - v.y / v.w) * 0.5 * this.state.height };
  }

  /** CSS pixel → lng/lat on the plane at `altitude` meters, or null above the horizon. */
  unproject(px: number, py: number, altitude = this.state.elevation): [number, number] | null {
    const nx = (px / this.state.width) * 2 - 1;
    const ny = 1 - (py / this.state.height) * 2;
    const a = new THREE.Vector4(nx, ny, -1, 1).applyMatrix4(this.invViewProj);
    const b = new THREE.Vector4(nx, ny, 1, 1).applyMatrix4(this.invViewProj);
    a.divideScalar(a.w);
    b.divideScalar(b.w);
    const dz = b.z - a.z;
    if (Math.abs(dz) < 1e-12) return null;
    const t = (altitude - a.z) / dz;
    if (t < 0) return null;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    return [lngFrom01(x / this.worldSize), latFrom01(y / this.worldSize)];
  }
}
