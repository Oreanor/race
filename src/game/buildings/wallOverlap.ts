// Identity of a building footprint, the same for every tile copy of the house.

type Ring = readonly (readonly number[])[];
type Pt = readonly [number, number];

function roundVertex(lng: number, lat: number) {
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

export function footprintKey(rings: readonly Ring[]) {
  // GeoJSON repeats the starting vertex at the end. Ignore that duplicate
  // before sorting, otherwise rotating a closed ring changes its identity.
  return rings.map((ring) => [...new Set(ring.map((point) => roundVertex(point[0] ?? 0, point[1] ?? 0)))].sort().join(';')).sort().join('#');
}

/**
 * Vertices on the busiest tile edge (N/E/S/W). A thin sliver cut by the seam
 * has almost every vertex "on an edge"; taking all of them makes left/right
 * halves hash differently. The shared cut is the edge with the most points.
 */
export function primaryTileSeam(
  ringTilePx: readonly { x: number; y: number }[],
  extent: number,
  pad = 0.5,
): { x: number; y: number }[] {
  const buckets: { x: number; y: number }[][] = [[], [], [], []]; // N E S W
  for (const p of ringTilePx) {
    if (p.y <= pad) buckets[0].push(p);
    if (p.x >= extent - pad) buckets[1].push(p);
    if (p.y >= extent - pad) buckets[2].push(p);
    if (p.x <= pad) buckets[3].push(p);
  }
  let best = buckets[0];
  for (let i = 1; i < 4; i++) if (buckets[i].length > best.length) best = buckets[i];
  return best.length >= 2 ? best : [];
}

/**
 * Style identity for a (possibly tile-clipped) footprint.
 * Edge-cut houses: midpoint of the primary tile-edge cut (shared by both
 * halves). Interior houses: the full ring.
 */
export function buildingStyleKey(
  height: number,
  base: number,
  ringLngLat: readonly Pt[],
  seamLngLat?: readonly Pt[],
) {
  const seam = seamLngLat && seamLngLat.length >= 2 ? seamLngLat : null;
  let id: string;
  if (seam) {
    let sx = 0, sy = 0;
    for (const [lng, lat] of seam) { sx += lng; sy += lat; }
    // ~11 m — absorbs MVT clip jitter; still separates neighbouring houses
    id = `m${(sx / seam.length).toFixed(4)},${(sy / seam.length).toFixed(4)}`;
  } else {
    id = footprintKey([ringLngLat]);
  }
  return `${Math.round(height)}:${base.toFixed(1)}:${id}`;
}
