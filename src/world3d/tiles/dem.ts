// Terrarium DEM helpers. One fixed DEM zoom is used for everything (ground mesh,
// roads, buildings, gameplay), so heights never change once a tile is loaded.
// This removes the "buildings re-settle onto terrain" corrections MapLibre needed
// because its terrain mesh switched DEM detail with zoom.

export const DEM_SIZE = 256;

export function decodeTerrarium(rgba: Uint8ClampedArray, size = DEM_SIZE): Float32Array {
  const out = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

/** Floats in a DEM with a one-pixel rim borrowed from the 8 neighbouring tiles. */
export const PADDED_DEM = (DEM_SIZE + 2) * (DEM_SIZE + 2);

/**
 * This tile's DEM with a one-pixel rim from its neighbours (west, east, north, south and
 * the corners; `null` where one has no data). Sampled with it, two neighbouring tiles
 * interpolate their shared edge between the very same pixels: the same heights, no seam.
 * A missing neighbour's rim is carried on along this tile's own edge slope.
 */
export function padDem(center: Float32Array, n: { w: Float32Array | null; e: Float32Array | null; n: Float32Array | null; s: Float32Array | null; nw: Float32Array | null; ne: Float32Array | null; sw: Float32Array | null; se: Float32Array | null }, size = DEM_SIZE) {
  const P = size + 2, out = new Float32Array(P * P);
  const at = (x: number, y: number) => center[y * size + x];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[(y + 1) * P + x + 1] = at(x, y);
  for (let i = 0; i < size; i++) {
    out[(i + 1) * P] = n.w ? n.w[i * size + size - 1] : 2 * at(0, i) - at(1, i);
    out[(i + 1) * P + P - 1] = n.e ? n.e[i * size] : 2 * at(size - 1, i) - at(size - 2, i);
    out[i + 1] = n.n ? n.n[(size - 1) * size + i] : 2 * at(i, 0) - at(i, 1);
    out[(P - 1) * P + i + 1] = n.s ? n.s[i] : 2 * at(i, size - 1) - at(i, size - 2);
  }
  // corners: the diagonal neighbour's corner pixel, else from the two rims beside it
  out[0] = n.nw ? n.nw[size * size - 1] : out[1] + out[P] - out[P + 1];
  out[P - 1] = n.ne ? n.ne[(size - 1) * size] : out[P - 2] + out[2 * P - 1] - out[2 * P - 2];
  out[(P - 1) * P] = n.sw ? n.sw[size - 1] : out[(P - 2) * P] + out[(P - 1) * P + 1] - out[(P - 2) * P + 1];
  out[P * P - 1] = n.se ? n.se[0] : out[(P - 1) * P - 1] + out[P * P - 2] - out[(P - 1) * P - 2];
  return out;
}

/**
 * Bilinear sample at tile pixel coordinates (0..size). Pixel values sit at pixel centres.
 * With a padded DEM (padDem) the edge is interpolated with the neighbour's pixels, exactly
 * as the neighbour does it; with a bare one the last half pixel to the edge is carried on
 * along the slope of the two outermost pixels.
 */
export function sampleDem(dem: Float32Array, px: number, py: number, size = DEM_SIZE) {
  if (dem.length === (size + 2) * (size + 2)) {
    const P = size + 2;
    const x = Math.min(size + 0.999, Math.max(0, px + 0.5)), y = Math.min(size + 0.999, Math.max(0, py + 0.5));
    const x0 = Math.min(P - 2, Math.floor(x)), y0 = Math.min(P - 2, Math.floor(y));
    const fx = x - x0, fy = y - y0;
    const a = dem[y0 * P + x0], b = dem[y0 * P + x0 + 1], c = dem[(y0 + 1) * P + x0], d = dem[(y0 + 1) * P + x0 + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  const x = Math.min(size - 0.5, Math.max(-0.5, px - 0.5));
  const y = Math.min(size - 0.5, Math.max(-0.5, py - 0.5));
  const x0 = Math.min(size - 2, Math.max(0, Math.floor(x))), y0 = Math.min(size - 2, Math.max(0, Math.floor(y)));
  const x1 = x0 + 1, y1 = y0 + 1;
  const fx = x - x0, fy = y - y0;
  const a = dem[y0 * size + x0], b = dem[y0 * size + x1];
  const c = dem[y1 * size + x0], d = dem[y1 * size + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
