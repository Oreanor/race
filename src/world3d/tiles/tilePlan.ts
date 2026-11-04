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
