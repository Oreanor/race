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
 * Interior: unique footprint (neighbouring houses stay different).
 * Tile cut: span of the shared edge (min/max, ~11 m) so both halves match;
 * height omitted so OSM height jitter does not recolour the seam.
 * Leading `s` marks a seam key — clustering prefers it over an interior key.
 */
export function buildingStyleKey(
  height: number,
  base: number,
  ringLngLat: readonly Pt[],
  seamLngLat?: readonly Pt[],
) {
  const seam = seamLngLat && seamLngLat.length >= 2 ? seamLngLat : null;
  if (seam) {
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of seam) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const id = `s${minLng.toFixed(4)},${minLat.toFixed(4)}-${maxLng.toFixed(4)},${maxLat.toFixed(4)}`;
    return `0:0.0:${id}`;
  }
  return `${Math.round(height)}:${base.toFixed(1)}:${footprintKey([ringLngLat])}`;
}
