// Vector ground: terrain grid plus crisp land-use polygons and water, all
// lying exactly on the terrain mesh. Every polygon is triangulated, then cut
// along the terrain cells and their diagonals; each piece takes its heights from
// the terrain triangle it sits in, so nothing floats or digs into a slope.
// Water is a flat surface at the level of its banks; the terrain under it is
// lowered, which gives a real shore slope.

import earcut from 'earcut';
import { classifyRings, type VectorTile } from '@mapbox/vector-tile';
import { DEM_SIZE, sampleDem } from './dem.ts';
import { roadStyle } from './roadStyle.ts';

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
  /** grid heights after carving the water beds, (grid+1)² — visual mesh / roads */
  heights: Float32Array;
  /**
   * Drive surface (grid+1)²: shore dips stay visual-only. Wet / bank cells are
   * lifted to the dry-bank height the shore mesh draws, so the car doesn't sink
   * into the tan strip.
   */
  driveHeights: Float32Array;
  /** water surface level per grid point (NaN on dry land) */
  waterLevel: Float32Array;
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
export function clipHalf(poly: Pt[], a: number, b: number, c: number): Pt[] {
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

/** Drivable road centre lines as x0, z0, x1, z1, half width (tile-local mercator). Bridges and tunnels left out. */
export function roadSegments(vt: VectorTile, span: number, metersScale: number): number[] {
  const out: number[] = [];
  const layer = vt.layers.transportation;
  if (!layer) return out;
  const k = span / layer.extent;
  for (let f = 0; f < layer.length; f++) {
    const feature = layer.feature(f);
    if (feature.type !== 2) continue;
    const p = feature.properties;
    if (p.brunnel === 'tunnel' || p.brunnel === 'bridge') continue;
    const style = roadStyle(String(p.class ?? ''), String(p.subclass ?? ''), Number(p.ramp) === 1);
    if (!style) continue;
    const half = style.width / 2 / metersScale;
    for (const line of feature.loadGeometry()) for (let j = 0; j + 1 < line.length; j++) {
      out.push(line[j].x * k, line[j].y * k, line[j + 1].x * k, line[j + 1].y * k, half);
    }
  }
  return out;
}

/** Grid points under a road or within ¾ of a cell of it. */
export function roadMask(grid: number, cs: number, segs: number[]): Uint8Array {
  const n = grid + 1;
  const mask = new Uint8Array(n * n);
  for (let s = 0; s < segs.length; s += 5) {
    const ax = segs[s], az = segs[s + 1], bx = segs[s + 2], bz = segs[s + 3];
    const reach = segs[s + 4] + cs * 0.75;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx) - reach) / cs)), i1 = Math.min(grid, Math.floor((Math.max(ax, bx) + reach) / cs));
    const j0 = Math.max(0, Math.ceil((Math.min(az, bz) - reach) / cs)), j1 = Math.min(grid, Math.floor((Math.max(az, bz) + reach) / cs));
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * n + i;
      if (mask[k]) continue;
      const x = i * cs, z = j * cs;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= reach) mask[k] = 1;
    }
  }
  return mask;
}

/**
 * DEM noise makes the grid lumpy under the pavement. Grid points under roads are
 * eased toward their neighbours (a plane averages to itself, so slopes stay).
 * Tile borders and water stay as they are, so tiles still meet.
 */
export function flattenUnderRoads(H: Float32Array, grid: number, mask: Uint8Array, wet: Uint8Array, passes = 2) {
  const n = grid + 1;
  const next = Float32Array.from(H);
  for (let pass = 0; pass < passes; pass++) {
    for (let j = 1; j < grid; j++) for (let i = 1; i < grid; i++) {
      const k = j * n + i;
      if (!mask[k] || wet[k]) continue;
      let sum = 0, count = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const kk = k + dj * n + di;
        if (wet[kk]) continue; // the carved bed would drag the road down
        sum += H[kk];
        count++;
      }
      if (count) next[k] = sum / count;
    }
    H.set(next);
  }
}

/** Segments bucketed on a square grid: a point only looks at the segments near it. */
class SegmentGrid {
  private cells = new Map<number, number[]>();
  private segs: [Pt, Pt][] = [];
  private size: number;
  private reach: number;
  constructor(size: number, reach: number) {
    this.size = size;
    this.reach = reach;
  }
  private key(i: number, j: number) { return i * 73856093 ^ j * 19349663; }
  add(a: Pt, b: Pt) {
    const index = this.segs.push([a, b]) - 1, r = this.reach, c = this.size;
    for (let j = Math.floor((Math.min(a[1], b[1]) - r) / c); j <= Math.floor((Math.max(a[1], b[1]) + r) / c); j++)
      for (let i = Math.floor((Math.min(a[0], b[0]) - r) / c); i <= Math.floor((Math.max(a[0], b[0]) + r) / c); i++) {
        const k = this.key(i, j), list = this.cells.get(k);
        if (list) list.push(index); else this.cells.set(k, [index]);
      }
  }
  /** Distance to the nearest segment, capped at the grid's reach. */
  distance(x: number, z: number) {
    let best = this.reach;
    for (const index of this.cells.get(this.key(Math.floor(x / this.size), Math.floor(z / this.size))) ?? []) {
      const [a, b] = this.segs[index];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz));
    }
    return best;
  }
}

/**
 * Even-odd fill of polygon rings over the grid points (i·cs, j·cs): per grid row,
 * the crossings of every edge, filled between pairs. O(edges × rows) instead of
 * O(points × vertices) for a point-by-point test.
 */
function fillRings(rings: Pt[][], grid: number, cs: number): Uint8Array {
  const n = grid + 1;
  const mask = new Uint8Array(n * n);
  const rows: number[][] = Array.from({ length: n }, () => []);
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a[1] === b[1]) continue;
    // one row either side of the span: the crossing test below decides, as the point test does
    const lo = Math.max(0, Math.floor(Math.min(a[1], b[1]) / cs) - 1), hi = Math.min(grid, Math.ceil(Math.max(a[1], b[1]) / cs) + 1);
    for (let r = lo; r <= hi; r++) {
      const z = r * cs;
      if ((a[1] > z) === (b[1] > z)) continue;
      rows[r].push((b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]);
    }
  }
  for (let r = 0; r < n; r++) {
    const xs = rows[r].sort((p, q) => p - q);
    // inside exactly when an odd number of crossings lie right of the point: xs[2k] <= x < xs[2k+1]
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i = Math.max(0, Math.floor(xs[k] / cs) - 1);
      while (i * cs < xs[k]) i++;
      for (; i <= grid && i * cs < xs[k + 1]; i++) mask[r * n + i] = 1;
    }
  }
  return mask;
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

  // roads are dry land: banks next to them are never dipped to the water
  const onRoad = roadMask(grid, cs, roadSegments(vt, span, metersScale));

  // ---- water: level from the banks, carve the bed --------------------------
  const waters = polygonsOf('water').map((w) => {
    const outline = w.rings[0];
    // banks inside the tile; when the whole outline lies outside, the nearest edge heights
    const inTile = outline.filter((p) => p[0] >= 0 && p[1] >= 0 && p[0] <= span && p[1] <= span);
    const samples = (inTile.length ? inTile : outline).map((p) => heightAt(p[0], p[1])).sort((a, b) => a - b);
    const level = samples.length ? samples[Math.floor(samples.length * 0.25)] : 0;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of outline) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    return { ...w, level, pool: w.props.class === 'swimming_pool', box: [x0, z0, x1, z1] as const };
  });
  // Water polygons overlap and touch (a river drawn over the ocean, big water cut into
  // chunks along straight lines). An edge with water on both sides is no shore: no foam,
  // no shallows along it, and the pieces it joins share one level.
  const waterAt = (x: number, z: number, skip = -1) => {
    for (let k = 0; k < waters.length; k++) {
      const w = waters[k], [x0, z0, x1, z1] = w.box;
      if (k !== skip && !w.pool && x >= x0 && x <= x1 && z >= z0 && z <= z1 && inside(x, z, w.rings)) return k;
    }
    return -1;
  };
  /** the other water across this edge of water k, or -1 if it is a real shore */
  const across = (k: number, a: Pt, b: Pt) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const one = waterAt(mx + nx, mz + nz), two = waterAt(mx - nx, mz - nz);
    if (one < 0 || two < 0) return -1;
    return one !== k ? one : two !== k ? two : k;
  };
  {
    const group = waters.map((_, k) => k);
    const root = (k: number): number => (group[k] === k ? k : (group[k] = root(group[k])));
    waters.forEach((w, k) => {
      if (w.pool) return;
      for (const ring of w.rings) for (let i = 0; i < ring.length; i++) {
        const other = across(k, ring[i], ring[(i + 1) % ring.length]);
        if (other >= 0) group[root(k)] = root(other);
      }
    });
    const low = new Map<number, number>();
    waters.forEach((w, k) => { if (!w.pool) low.set(root(k), Math.min(low.get(root(k)) ?? Infinity, w.level)); });
    waters.forEach((w, k) => { if (!w.pool) w.level = low.get(root(k))!; });
  }
  // DEM before beds/banks are carved — restore this for driving on the shore
  const land = Float32Array.from(H);
  const wet = new Uint8Array(n * n);
  const waterLevel = new Float32Array(n * n).fill(Number.NaN);
  for (const w of waters) {
    const [x0, z0, x1, z1] = w.box;
    const depth = w.pool ? 1.6 : 2.4;
    const within = fillRings(w.rings, grid, cs);
    // shoreline segments, to find the grid points just outside the bank
    const shore = new SegmentGrid(cs * 2, cs * 1.4);
    for (const ring of w.rings) for (let i = 0; i < ring.length; i++) shore.add(ring[i], ring[(i + 1) % ring.length]);
    const nearShore = (x: number, z: number) => shore.distance(x, z) < cs * 1.4;
    for (let j = Math.max(0, Math.ceil(z0 / cs) - 1); j <= Math.min(grid, Math.floor(z1 / cs) + 1); j++)
      for (let i = Math.max(0, Math.ceil(x0 / cs) - 1); i <= Math.min(grid, Math.floor(x1 / cs) + 1); i++) {
        if (within[j * n + i]) {
          H[j * n + i] = Math.min(H[j * n + i], w.level - depth);
          wet[j * n + i] = 1;
          waterLevel[j * n + i] = Number.isFinite(waterLevel[j * n + i])
            ? Math.max(waterLevel[j * n + i], w.level)
            : w.level;
        } else if (!w.pool && !(onRoad[j * n + i] && H[j * n + i] > w.level + 1.5) && nearShore(i * cs, j * cs)) {
          // (a high embankment under a road keeps its height; low banks dip as usual)
          // slight bank dip so terrain triangles don't poke through the water
          H[j * n + i] = Math.min(H[j * n + i], w.level - 0.08);
          // remember the water next door so roads can stay above it
          waterLevel[j * n + i] = Number.isFinite(waterLevel[j * n + i])
            ? Math.max(waterLevel[j * n + i], w.level)
            : w.level;
        }
      }
  }

  // soften the wet/dry cliff: edge of the bed rises to a shelf just under the water
  // so terrain triangles don't pierce the surface (torn blue strips) and the car
  // isn't launched by a 2 m step at the shore
  {
    const soft = Float32Array.from(H);
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      let dryN = 0, wetN = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        if (wet[(j + dj) * n + (i + di)]) wetN++; else dryN++;
      }
      if (wet[k]) {
        if (dryN === 0) continue; // deep interior stays carved
        const level = Number.isFinite(waterLevel[k]) ? waterLevel[k] : H[k];
        let bank = -Infinity;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const kk = (j + dj) * n + (i + di);
          if (!wet[kk]) bank = Math.max(bank, H[kk]);
        }
        if (bank > level + 0.4) {
          // a high bank (embankment): the bed drops steeply, so the slope meets the
          // water right at the bank instead of reaching out over it in grid teeth
          soft[k] = Math.min(H[k], level - (bank - level) * 8);
          continue;
        }
        // low bank: shelf just under the water — wider dry contact → closer to the surface
        const shelf = level - (0.12 + 0.35 * (1 - dryN / 8));
        soft[k] = Math.max(H[k], shelf);
        continue;
      }
      if (wetN === 0 || onRoad[k] && H[k] > (Number.isFinite(waterLevel[k]) ? waterLevel[k] : -Infinity) + 1.5) continue;
      // dry bank next to water: ease toward the water without going under it
      let sum = 0, count = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const kk = (j + dj) * n + (i + di);
        if (wet[kk]) continue;
        sum += H[kk];
        count++;
      }
      if (!count) continue;
      const level = Number.isFinite(waterLevel[k]) ? waterLevel[k] : -Infinity;
      soft[k] = Math.max(sum / count, level - 0.1);
    }
    H.set(soft);
  }

  flattenUnderRoads(H, grid, onRoad, wet);

  // drive grid: same as the shore mesh's dry bank (not the dipped visual H)
  const driveHeights = Float32Array.from(H);
  const CLEAR = 0.35;
  for (let k = 0; k < n * n; k++) {
    if (!Number.isFinite(waterLevel[k])) continue;
    if (!wet[k]) driveHeights[k] = Math.max(H[k], land[k], waterLevel[k] + CLEAR);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    if (!wet[k]) continue;
    let sum = 0, count = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n || wet[jj * n + ii]) continue;
      sum += driveHeights[jj * n + ii];
      count++;
    }
    const surface = Number.isFinite(waterLevel[k]) ? waterLevel[k] : H[k];
    driveHeights[k] = count ? Math.max(sum / count, surface + CLEAR) : surface + CLEAR;
  }

  // ---- the cells a shoreline runs through, with the shore segments in each ----
  // The 20 m grid can't follow a bank: a slope between a dry and a wet grid point
  // meets the water somewhere inside the cell, in teeth along the diagonals. Those
  // cells are cut along the shoreline instead (below), the water side kept under it.
  const shoreCells = new Map<number, [Pt, Pt][]>();
  for (const w of waters) for (const ring of w.rings) for (let r = 0; r < ring.length; r++) {
    const a = ring[r], b = ring[(r + 1) % ring.length];
    const i0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) / cs)), i1 = Math.min(grid - 1, Math.floor(Math.max(a[0], b[0]) / cs));
    const j0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) / cs)), j1 = Math.min(grid - 1, Math.floor(Math.max(a[1], b[1]) / cs));
    for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
      const key = cj * grid + ci;
      const list = shoreCells.get(key);
      if (list) list.push([a, b]); else shoreCells.set(key, [[a, b]]);
    }
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
      if (shoreCells.has(j * grid + i)) continue; // cut along the shore below
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

  // ---- shore cells: each terrain triangle split along the shore lines in it -----
  // Every piece then lies wholly on land or wholly in the water: land keeps the
  // terrain, the water side is held just under the surface, and where the bank
  // stands higher a wall drops from it straight to the water, right on the shoreline.
  {
    const level = (x: number, z: number) => {
      let out = Number.NaN;
      for (const w of waters) {
        const [x0, z0, x1, z1] = w.box;
        if (x < x0 || x > x1 || z < z0 || z > z1 || !inside(x, z, w.rings)) continue;
        out = Number.isFinite(out) ? Math.max(out, w.level) : w.level;
      }
      return out;
    };
    const area = (poly: Pt[]) => {
      let sum = 0;
      for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; sum += p[0] * q[1] - q[0] * p[1]; }
      return Math.abs(sum) / 2;
    };
    const tiny = cs * cs * 1e-6;
    const split = (pieces: Pt[][], [p, q]: [Pt, Pt]) => {
      const nx = p[1] - q[1], nz = q[0] - p[0], len = Math.hypot(nx, nz);
      if (len < 1e-9) return pieces;
      const a = nx / len, b = nz / len, c = -(a * p[0] + b * p[1]);
      const out: Pt[][] = [];
      for (const piece of pieces) {
        const one = clipHalf(piece, a, b, c), two = clipHalf(piece, -a, -b, -c);
        if (one.length >= 3 && area(one) > tiny) out.push(one);
        if (two.length >= 3 && area(two) > tiny) out.push(two);
      }
      return out;
    };
    const { positions, ground, colors, index } = terrain;
    const bank = hex(BANK);
    const vertex = (p: Pt, h: number) => {
      positions.push(p[0], 0, p[1]);
      ground.push(h);
      colors.push(bank[0], bank[1], bank[2]);
      return positions.length / 3 - 1;
    };
    const nudge = cs * 1e-3;
    // the land side sees no river bed: a wet grid point stands at the height of the dry
    // ones round it, so the bank runs level to the shoreline and drops there in one wall
    // (not a slope into the water first, and a second step at the shore)
    const dry = Float32Array.from(H);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!wet[k]) continue;
      let sum = 0, count = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n || wet[jj * n + ii]) continue;
        sum += H[jj * n + ii];
        count++;
      }
      const surface = Number.isFinite(waterLevel[k]) ? waterLevel[k] : H[k];
      dry[k] = count ? Math.max(sum / count, surface) : surface;
    }
    const dryPlane = (p: Pt, ci: number, cj: number, upper: boolean) => {
      const u = p[0] / cs - ci, v = p[1] / cs - cj;
      const ha = dry[cj * n + ci], hb = dry[cj * n + ci + 1], hc = dry[(cj + 1) * n + ci], hd = dry[(cj + 1) * n + ci + 1];
      return upper ? hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v) : ha + (hb - ha) * u + (hc - ha) * v;
    };
    for (const [key, segments] of shoreCells) {
      const ci = key % grid, cj = Math.floor(key / grid), x0 = ci * cs, z0 = cj * cs;
      // the two triangles of the cell, wound as in the grid index above
      const halves: [Pt[], boolean][] = [
        [[[x0, z0], [x0, z0 + cs], [x0 + cs, z0]], false],
        [[[x0 + cs, z0], [x0, z0 + cs], [x0 + cs, z0 + cs]], true],
      ];
      for (const [triangle, upper] of halves) {
        let pieces: Pt[][] = [triangle];
        for (const segment of segments) pieces = split(pieces, segment);
        for (const piece of pieces) {
          let cx = 0, cz = 0;
          for (const p of piece) { cx += p[0]; cz += p[1]; }
          const surface = level(cx / piece.length, cz / piece.length);
          const wet = Number.isFinite(surface);
          const land = piece.map((p) => dryPlane(p, ci, cj, upper));
          const heights = wet ? piece.map((p) => Math.min(plane(p, ci, cj, upper), surface - 0.05)) : land;
          const ids = piece.map((p, i) => vertex(p, heights[i]));
          for (let i = 1; i + 1 < ids.length; i++) index.push(ids[0], ids[i], ids[i + 1]);
          if (!wet) continue;
          // a wall where this water piece meets land standing above it
          for (let i = 0; i < piece.length; i++) {
            const k = (i + 1) % piece.length, p = piece[i], q = piece[k];
            if (land[i] - heights[i] < 0.02 && land[k] - heights[k] < 0.02) continue;
            const dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz);
            if (len < 1e-9) continue;
            const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2, ox = -dz / len * nudge, oz = dx / len * nudge;
            if (Number.isFinite(level(mx + ox, mz + oz)) && Number.isFinite(level(mx - ox, mz - oz))) continue; // water on both sides
            const a = vertex(p, heights[i]), b = vertex(q, heights[k]), c = vertex(p, land[i]), d = vertex(q, land[k]);
            index.push(a, b, c, b, d, c, a, c, b, b, c, d);
          }
        }
      }
    }
  }

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
  waters.forEach((w, k) => {
    // distance to the shore (capped at 60 m) for the water's colour and foam
    const reach = 60 / metersScale;
    const shore = new SegmentGrid(reach, reach);
    for (const ring of w.rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      // tile-border edges are cuts, not shores; neither are edges with water on both sides
      const border = (a[0] <= 0.5 && b[0] <= 0.5) || (a[0] >= span - 0.5 && b[0] >= span - 0.5) || (a[1] <= 0.5 && b[1] <= 0.5) || (a[1] >= span - 0.5 && b[1] >= span - 0.5);
      if (!border && (w.pool || across(k, a, b) < 0)) shore.add(a, b);
    }
    const shoreOf = (p: Pt) => shore.distance(p[0], p[1]) * metersScale;
    const rgb: Rgb = w.pool ? [1, 0, 0] : [0, 0, 0]; // kind in the colour channel
    // flat at the water level: the terrain is cut along the shore and kept under it
    drape(w.rings, (piece) => water.polygon(piece.map((p) => [p[0], p[1], w.level]), rgb, piece.map(shoreOf)));
  });

  return { heights: H, driveHeights, waterLevel, terrain: terrain.done(), layers, water: water.done(true) };
}

export function groundTransferables(g: GroundData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [g.heights.buffer as ArrayBuffer, g.driveHeights.buffer as ArrayBuffer, g.waterLevel.buffer as ArrayBuffer];
  for (const m of [g.terrain, ...g.layers, g.water]) {
    out.push(m.positions.buffer as ArrayBuffer, m.ground.buffer as ArrayBuffer, m.colors.buffer as ArrayBuffer, m.index.buffer as ArrayBuffer);
    if (m.shore) out.push(m.shore.buffer as ArrayBuffer);
  }
  return out;
}
