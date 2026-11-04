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

/** Bilinear sample at tile pixel coordinates (0..size), clamped to this tile. */
export function sampleDem(dem: Float32Array, px: number, py: number, size = DEM_SIZE) {
  const x = Math.min(size - 1, Math.max(0, px - 0.5));
  const y = Math.min(size - 1, Math.max(0, py - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(size - 1, x0 + 1), y1 = Math.min(size - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = dem[y0 * size + x0], b = dem[y0 * size + x1];
  const c = dem[y1 * size + x0], d = dem[y1 * size + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
