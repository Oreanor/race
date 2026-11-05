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
