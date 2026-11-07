import { mercatorX, mercatorY, tileCorner, tileSpan, tileAt, type LngLat, type TileId } from '../mercator.ts';

export type PlannedTile = { tile: TileId; key: string; distance: number };

/** Distance in true meters from a mercator point to a tile square (0 inside). */
export function distanceToTile(mx: number, my: number, tile: TileId, metersScale: number) {
  const [x0, y0] = tileCorner(tile);
  const span = tileSpan(tile.z);
  const dx = Math.max(x0 - mx, 0, mx - (x0 + span));
  const dy = Math.max(my - y0, 0, (y0 - span) - my);
  return Math.hypot(dx, dy) * metersScale;
}

/** Every tile whose square comes within `radius` meters of `center`, nearest first. */
export function tilesAround(center: LngLat, radius: number, z: number): PlannedTile[] {
  const mx = mercatorX(center[0]);
  const my = mercatorY(center[1]);
  const metersScale = Math.cos(center[1] * Math.PI / 180);
  const home = tileAt(center[0], center[1], z);
  const reach = Math.ceil(radius / (tileSpan(z) * metersScale)) + 1;
  const n = 2 ** z;
  const out: PlannedTile[] = [];
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const x = ((home.x + dx) % n + n) % n;
      const y = home.y + dy;
      if (y < 0 || y >= n) continue;
      const tile = { z, x, y };
      const distance = distanceToTile(mx, my, tile, metersScale);
      if (distance <= radius) out.push({ tile, key: `${z}/${x}/${y}`, distance });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/**
 * Every tile intersecting the lng/lat rectangle [west,south]–[east,north],
 * nearest to `focus` first. Used for the top-down map so screen corners stay filled
 * (a circular radius drops the corners of a wide view).
 */
export function tilesCovering(west: number, south: number, east: number, north: number, z: number, focus: LngLat): PlannedTile[] {
  if (!(east > west) || !(north > south)) return tilesAround(focus, 0, z);
  const a = tileAt(west, south, z);
  const b = tileAt(east, north, z);
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const mx = mercatorX(focus[0]);
  const my = mercatorY(focus[1]);
  const metersScale = Math.cos(focus[1] * Math.PI / 180);
  const n = 2 ** z;
  const out: PlannedTile[] = [];
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= n) continue;
    for (let x = x0; x <= x1; x++) {
      const tile = { z, x: ((x % n) + n) % n, y };
      out.push({ tile, key: `${z}/${tile.x}/${y}`, distance: distanceToTile(mx, my, tile, metersScale) });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}
