import type { VectorTile } from '@mapbox/vector-tile';
import { buildGround, type GroundHeights } from './groundVector.ts';
import { DEM_SIZE, PADDED_DEM, padDem } from './dem.ts';

export type TerrainSource = { dx: number; dy: number; vt: VectorTile; dem?: Float32Array | null };

function rawDem(dem: Float32Array | null): Float32Array | null {
  if (dem?.length !== PADDED_DEM) return dem;
  const out = new Float32Array(DEM_SIZE * DEM_SIZE);
  for (let j = 0; j < DEM_SIZE; j++) out.set(dem.subarray((j + 1) * (DEM_SIZE + 2) + 1, (j + 1) * (DEM_SIZE + 2) + 1 + DEM_SIZE), j * DEM_SIZE);
  return out;
}

/**
 * Sample every road against the terrain of the tile it actually occupies.
 * Clamping all neighbour roads to our own DEM edge made the two halves of a
 * bridge solve different profiles even when they saw the same road geometry.
 * Only height grids are built for neighbours; no throwaway render meshes.
 */
export function roadTerrain(own: GroundHeights, dem: Float32Array | null, neighbours: TerrainSource[], span: number, grid: number, metersScale: number) {
  const sources = new Map(neighbours.map(n => [`${n.dx},${n.dy}`, n]));
  const dems = new Map(neighbours.map(n => [`${n.dx},${n.dy}`, rawDem(n.dem ?? null)]));
  dems.set('0,0', rawDem(dem));
  const heights = new Map<string, GroundHeights>([['0,0', own]]);
  return (x: number, z: number): { ground: GroundHeights; u: number; v: number } => {
    const dx = Math.floor(x / span), dy = Math.floor(z / span), key = `${dx},${dy}`;
    let ground = heights.get(key);
    const source = sources.get(key);
    if (!ground && source && source.dem !== undefined) {
      const d = dems.get(key) ?? null;
      const get = (x: number, y: number) => dems.get(`${dx + x},${dy + y}`) ?? null;
      const padded = d ? padDem(d, { w: get(-1, 0), e: get(1, 0), n: get(0, -1), s: get(0, 1), nw: get(-1, -1), ne: get(1, -1), sw: get(-1, 1), se: get(1, 1) }) : null;
      ground = buildGround(source.vt, span, grid, padded, metersScale, true);
      heights.set(key, ground);
    }
    return ground ? { ground, u: x / span - dx, v: z / span - dy } : { ground: own, u: x / span, v: z / span };
  };
}
