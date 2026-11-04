// Web Mercator helpers for the three-world renderer.
//
// "Mercator meters" are Web Mercator coordinates measured at the equator
// (EPSG:3857). They are exact and linear inside every tile, so tile geometry can
// be stored relative to its own corner and never needs reprojecting. Scene space
// multiplies them by cos(originLatitude) to get true meters near the origin.
// Scene axes match the rest of the game: x = east, y = up, z = south (-north).

export const EARTH_RADIUS = 6378137;
export const WORLD_SIZE = 2 * Math.PI * EARTH_RADIUS;

export type LngLat = [number, number];
export type TileId = { z: number; x: number; y: number };

export function tileKey(tile: TileId) {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

export function mercatorX(lng: number) {
  return EARTH_RADIUS * lng * Math.PI / 180;
}

export function mercatorY(lat: number) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360));
}

export function lngFromMercator(x: number) {
  return x / EARTH_RADIUS * 180 / Math.PI;
}

export function latFromMercator(y: number) {
  return (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI;
}

/** Size of one tile edge in mercator meters. */
export function tileSpan(z: number) {
  return WORLD_SIZE / 2 ** z;
}

/** North-west corner of a tile in mercator meters (x east, y north). */
export function tileCorner(tile: TileId): [number, number] {
  const span = tileSpan(tile.z);
  return [tile.x * span - WORLD_SIZE / 2, WORLD_SIZE / 2 - tile.y * span];
}

export function tileAt(lng: number, lat: number, z: number): TileId {
  const n = 2 ** z;
  const x = Math.floor((mercatorX(lng) + WORLD_SIZE / 2) / WORLD_SIZE * n);
  const y = Math.floor((WORLD_SIZE / 2 - mercatorY(lat)) / WORLD_SIZE * n);
  return { z, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/**
 * Floating origin. Scene coordinates stay small (float32-safe) because the
 * origin follows the car; everything placed through it is rebased together.
 */
export class LocalFrame {
  originX = 0;
  originY = 0;
  /** Scene meters per mercator meter at the origin latitude. */
  scale = 1;
  latitude = 0;

  constructor(origin: LngLat) {
    this.reset(origin);
  }

  reset(origin: LngLat) {
    this.originX = mercatorX(origin[0]);
    this.originY = mercatorY(origin[1]);
    this.latitude = origin[1];
    this.scale = Math.cos(origin[1] * Math.PI / 180);
  }

  /** Scene position (x east, z south) of a mercator point. */
  fromMercator(mx: number, my: number, out: { x: number; z: number } = { x: 0, z: 0 }) {
    out.x = (mx - this.originX) * this.scale;
    out.z = -(my - this.originY) * this.scale;
    return out;
  }

  fromLngLat(point: LngLat, out: { x: number; z: number } = { x: 0, z: 0 }) {
    return this.fromMercator(mercatorX(point[0]), mercatorY(point[1]), out);
  }

  toLngLat(x: number, z: number): LngLat {
    return [lngFromMercator(this.originX + x / this.scale), latFromMercator(this.originY - z / this.scale)];
  }
}
