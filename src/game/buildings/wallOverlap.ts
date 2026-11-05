// Identity of a building footprint, the same for every tile copy of the house.

type Ring = readonly (readonly number[])[];

function roundVertex(lng: number, lat: number) {
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

export function footprintKey(rings: readonly Ring[]) {
  // GeoJSON repeats the starting vertex at the end. Ignore that duplicate
  // before sorting, otherwise rotating a closed ring changes its identity.
  return rings.map((ring) => [...new Set(ring.map((point) => roundVertex(point[0] ?? 0, point[1] ?? 0)))].sort().join(';')).sort().join('#');
}
