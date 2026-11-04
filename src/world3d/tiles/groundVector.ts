// Vector ground: terrain grid plus crisp land-use polygons and water, all
// lying exactly on the terrain mesh. Every polygon is triangulated, then cut
// along the terrain cells and their diagonals; each piece takes its heights from
// the terrain triangle it sits in, so nothing floats or digs into a slope.
// Water is a flat surface at the level of its banks; the terrain under it is
// lowered, which gives a real shore slope.

import earcut from 'earcut';
import { classifyRings, type VectorTile } from '@mapbox/vector-tile';
import { DEM_SIZE, sampleDem } from './dem.ts';

type Pt = [number, number];
type Rgb = [number, number, number];

export type GroundMesh = {
  positions: Float32Array;
  ground: Float32Array;
  colors: Uint8Array;
  index: Uint32Array;
  /** water only: distance to the shore (m), and kind (0 natural, 1 pool) */
  shore?: Float32Array;
};

export type GroundData = {
  /** grid heights after carving the water beds, (grid+1)² */
  heights: Float32Array;
  terrain: GroundMesh;
  /** overlays, drawn over the terrain in this order */
  layers: GroundMesh[];
  water: GroundMesh;
};

const BACKGROUND = '#dcdad3';
const BANK = '#cdc4ad';
const GREEN = '#b1d59b';
const WOOD = '#7fb27f';

function hex(c: string): Rgb {
  const v = Number.parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function landColor(layer: string, cls: string, sub: string): string | null {
  if (layer === 'park') return GREEN;
  if (layer === 'landcover') {
    if (cls === 'wood') return WOOD;
    if (cls === 'sand') return '#efe3c2';
    if (cls === 'rock') return '#d6d2c8';
    if (cls === 'ice') return '#f3f6f6';
    if (cls === 'wetland') return '#a9cfa6';
    return GREEN;
  }
  if (/park|grass|cemetery|pitch|playground|garden/.test(cls) || /park|garden/.test(sub)) return GREEN;
  if (/residential|neighbourhood|suburb|quarter/.test(cls)) return '#e5e2da';
  if (/school|hospital|university|college|kindergarten|library/.test(cls)) return '#f8dfda';
  if (/commercial|retail|industrial|railway|military/.test(cls)) return '#e3e0d8';
  if (/stadium|track/.test(cls)) return '#d5d3c9';
  return null;
}

class Builder {
  positions: number[] = [];
  ground: number[] = [];
  colors: number[] = [];
  index: number[] = [];
  shore: number[] = [];
  /** convex polygon (x, z, height) with one colour, fan-triangulated, facing up */
  polygon(points: [number, number, number][], rgb: Rgb, shore?: number[]) {
    if (points.length < 3) return;
    const start = this.positions.length / 3;
    for (let i = 0; i < points.length; i++) {
      const [x, z, h] = points[i];
      this.positions.push(x, 0, z);
      this.ground.push(h);
      this.colors.push(rgb[0], rgb[1], rgb[2]);
      if (shore) this.shore.push(shore[i]);
    }
    const [x0, z0] = points[0], [x1, z1] = points[1], [x2, z2] = points[2];
    const cross = (x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0);
    for (let i = 1; i + 1 < points.length; i++) {
      // CCW seen from above (x right, z down) means cross < 0
      if (cross < 0) this.index.push(start, start + i, start + i + 1);
      else this.index.push(start, start + i + 1, start + i);
    }
  }
  done(withShore = false): GroundMesh {
    return {
      positions: new Float32Array(this.positions),
      ground: new Float32Array(this.ground),
      colors: new Uint8Array(this.colors),
      index: new Uint32Array(this.index),
      shore: withShore ? new Float32Array(this.shore) : undefined,
    };
  }
}

/** Keep the part of a convex polygon where a·x + b·z + c ≥ 0. */
function clipHalf(poly: Pt[], a: number, b: number, c: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] + c, dq = a * q[0] + b * q[1] + c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

export function buildGround(vt: VectorTile, span: number, grid: number, dem: Float32Array | null, metersScale: number): GroundData {
  const n = grid + 1;
  const cs = span / grid;
  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = dem ? sampleDem(dem, i / grid * DEM_SIZE, j / grid * DEM_SIZE) : 0;
  const heightAt = (x: number, z: number) => {
    const u = Math.min(grid, Math.max(0, x / cs)), v = Math.min(grid, Math.max(0, z / cs));
    const i = Math.min(grid - 1, Math.floor(u)), j = Math.min(grid - 1, Math.floor(v));
    const fu = u - i, fv = v - j;
    const ha = H[j * n + i], hb = H[j * n + i + 1], hc = H[(j + 1) * n + i], hd = H[(j + 1) * n + i + 1];
    return fu + fv <= 1 ? ha + (hb - ha) * fu + (hc - ha) * fv : hd + (hc - hd) * (1 - fu) + (hb - hd) * (1 - fv);
  };

  // polygons of a layer, in tile-local mercator meters
  const polygonsOf = (name: string) => {
    const layer = vt.layers[name];
    const out: { rings: Pt[][]; props: Record<string, unknown> }[] = [];
    if (!layer) return out;
    const k = span / layer.extent;
    for (let f = 0; f < layer.length; f++) {
      const feature = layer.feature(f);
      if (feature.type !== 3) continue;
      for (const polygon of classifyRings(feature.loadGeometry())) {
        const rings = polygon.map((ring) => ring.map((p) => [p.x * k, p.y * k] as Pt)).filter((r) => r.length >= 3);
        if (rings.length) out.push({ rings, props: feature.properties });
      }
    }
    return out;
  };
  const inside = (x: number, z: number, rings: Pt[][]) => {
    let hit = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  };

  // ---- water: level from the banks, carve the bed --------------------------
  const waters = polygonsOf('water').map((w) => {
    const outline = w.rings[0];
    // banks inside the tile; when the whole outline lies outside, the nearest edge heights
    const inTile = outline.filter((p) => p[0] >= 0 && p[1] >= 0 && p[0] <= span && p[1] <= span);
    const samples = (inTile.length ? inTile : outline).map((p) => heightAt(p[0], p[1])).sort((a, b) => a - b);
    const level = samples.length ? samples[Math.floor(samples.length * 0.25)] : 0;
    return { ...w, level, pool: w.props.class === 'swimming_pool' };
  });
  const wet = new Uint8Array(n * n);
  for (const w of waters) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of w.rings[0]) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const depth = w.pool ? 1.6 : 2.4;
    // shoreline segments, to find the grid points just outside the bank
    const edges: [Pt, Pt][] = [];
    for (const ring of w.rings) for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]]);
    const nearShore = (x: number, z: number) => {
      for (const [a, b] of edges) {
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
        if (Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < cs * 1.05) return true;
      }
      return false;
    };
    for (let j = Math.max(0, Math.ceil(z0 / cs) - 1); j <= Math.min(grid, Math.floor(z1 / cs) + 1); j++)
      for (let i = Math.max(0, Math.ceil(x0 / cs) - 1); i <= Math.min(grid, Math.floor(x1 / cs) + 1); i++) {
        if (inside(i * cs, j * cs, w.rings)) {
          H[j * n + i] = Math.min(H[j * n + i], w.level - depth);
          wet[j * n + i] = 1;
        } else if (!w.pool && nearShore(i * cs, j * cs)) {
          // the bank right next to the water dips just under it: the ground
          // between grid points never rises through the water surface
          H[j * n + i] = Math.min(H[j * n + i], w.level - 0.2);
        }
      }
  }

  // soften cliffs from water carving so roads on the bank aren't stabbed by terrain triangles
  {
    const soft = Float32Array.from(H);
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      let nearWet = wet[j * n + i];
      if (!nearWet) {
        for (let dj = -1; dj <= 1 && !nearWet; dj++) for (let di = -1; di <= 1; di++) {
          if (wet[(j + dj) * n + (i + di)]) nearWet = 1;
        }
      }
      if (!nearWet) continue;
      let sum = 0, count = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        sum += H[(j + dj) * n + (i + di)];
        count++;
      }
      // keep wet beds low; only ease the bank transition
      soft[j * n + i] = wet[j * n + i] ? Math.min(H[j * n + i], sum / count) : sum / count;
    }
    H.set(soft);
  }

  // ---- terrain: grid with a stony bank colour next to water ----------------
  const terrain = new Builder();
  {
    const base = hex(BACKGROUND), bank = hex(BANK);
    const positions: number[] = [], ground: number[] = [], colors: number[] = [], index: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      positions.push(i * cs, 0, j * cs);
      ground.push(H[j * n + i]);
      let near = false;
      for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < n && jj < n && wet[jj * n + ii]) { near = true; break; }
      }
      const c = near ? bank : base;
      colors.push(c[0], c[1], c[2]);
    }
    for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
    // skirts hide cracks between neighbouring tiles
    const edges = [
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => (n - 1) * n + (n - 1 - i)),
      Array.from({ length: n }, (_, j) => (n - 1 - j) * n),
      Array.from({ length: n }, (_, j) => j * n + n - 1),
    ];
    let s = n * n;
    for (const edge of edges) {
      const first = s;
      for (const k of edge) {
        positions.push(positions[k * 3], -6, positions[k * 3 + 2]);
        ground.push(ground[k]);
        colors.push(colors[k * 3], colors[k * 3 + 1], colors[k * 3 + 2]);
        s++;
      }
      for (let t = 0; t < n - 1; t++) {
        const a = edge[t], b = edge[t + 1], c = first + t, d = first + t + 1;
        index.push(a, b, c, b, d, c, a, c, b, b, c, d);
      }
    }
    terrain.positions = positions; terrain.ground = ground; terrain.colors = colors; terrain.index = index;
  }

  /**
   * Cut a polygon (with holes) along the terrain cells and diagonals.
   * `height` gives each piece's vertex heights (terrain plane, or a flat level).
   */
  const drape = (rings: Pt[][], out: (piece: Pt[], ci: number, cj: number, upper: boolean) => void) => {
    const flat: number[] = [], holes: number[] = [];
    rings.forEach((ring, r) => { if (r) holes.push(flat.length / 2); for (const p of ring) flat.push(p[0], p[1]); });
    const tris = earcut(flat, holes, 2);
    for (let t = 0; t < tris.length; t += 3) {
      const tri: Pt[] = [0, 1, 2].map((o) => [flat[tris[t + o] * 2], flat[tris[t + o] * 2 + 1]] as Pt);
      const xs = tri.map((p) => p[0]), zs = tri.map((p) => p[1]);
      const i0 = Math.max(0, Math.floor(Math.min(...xs) / cs)), i1 = Math.min(grid - 1, Math.floor(Math.max(...xs) / cs));
      const j0 = Math.max(0, Math.floor(Math.min(...zs) / cs)), j1 = Math.min(grid - 1, Math.floor(Math.max(...zs) / cs));
      for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
        const x0 = ci * cs, z0 = cj * cs;
        let piece = clipHalf(tri, 1, 0, -x0);
        piece = clipHalf(piece, -1, 0, x0 + cs);
        piece = clipHalf(piece, 0, 1, -z0);
        piece = clipHalf(piece, 0, -1, z0 + cs);
        if (piece.length < 3) continue;
        // diagonal of the cell: u + v = 1, as in the terrain mesh index
        const lower = clipHalf(piece, -1 / cs, -1 / cs, 1 + x0 / cs + z0 / cs);
        const upper = clipHalf(piece, 1 / cs, 1 / cs, -1 - x0 / cs - z0 / cs);
        if (lower.length >= 3) out(lower, ci, cj, false);
        if (upper.length >= 3) out(upper, ci, cj, true);
      }
    }
  };
  const plane = (p: Pt, ci: number, cj: number, upper: boolean) => {
    const u = p[0] / cs - ci, v = p[1] / cs - cj;
    const ha = H[cj * n + ci], hb = H[cj * n + ci + 1], hc = H[(cj + 1) * n + ci], hd = H[(cj + 1) * n + ci + 1];
    return upper ? hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v) : ha + (hb - ha) * u + (hc - ha) * v;
  };

  // ---- land-use overlays, bottom to top ------------------------------------
  const layers: GroundMesh[] = [];
  for (const name of ['landuse', 'landcover', 'park']) {
    const b = new Builder();
    for (const { rings, props } of polygonsOf(name)) {
      const color = landColor(name, String(props.class ?? ''), String(props.subclass ?? ''));
      if (!color) continue;
      const rgb = hex(color);
      drape(rings, (piece, ci, cj, upper) => b.polygon(piece.map((p) => [p[0], p[1], plane(p, ci, cj, upper)]), rgb));
    }
    layers.push(b.done());
  }

  // ---- water: flat at its level, with the distance to the shore -------------
  const water = new Builder();
  for (const w of waters) {
    const segs: [Pt, Pt][] = [];
    for (const ring of w.rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      // tile-border edges are cuts, not shores
      const border = (a[0] <= 0.5 && b[0] <= 0.5) || (a[0] >= span - 0.5 && b[0] >= span - 0.5) || (a[1] <= 0.5 && b[1] <= 0.5) || (a[1] >= span - 0.5 && b[1] >= span - 0.5);
      if (!border) segs.push([a, b]);
    }
    const shoreOf = (p: Pt) => {
      let best = 60 / metersScale;
      for (const [a, b] of segs) {
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
        best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz));
      }
      return best * metersScale;
    };
    const rgb: Rgb = w.pool ? [1, 0, 0] : [0, 0, 0]; // kind in the colour channel
    drape(w.rings, (piece) => water.polygon(piece.map((p) => [p[0], p[1], w.level]), rgb, piece.map(shoreOf)));
  }

  return { heights: H, terrain: terrain.done(), layers, water: water.done(true) };
}

export function groundTransferables(g: GroundData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [g.heights.buffer as ArrayBuffer];
  for (const m of [g.terrain, ...g.layers, g.water]) {
    out.push(m.positions.buffer as ArrayBuffer, m.ground.buffer as ArrayBuffer, m.colors.buffer as ArrayBuffer, m.index.buffer as ArrayBuffer);
    if (m.shore) out.push(m.shore.buffer as ArrayBuffer);
  }
  return out;
}
