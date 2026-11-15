// Everything one z14 tile contributes to the world, built off the main thread:
// terrain mesh, a ground raster (landuse / landcover / park / water), road
// ribbons draped on the same DEM, far-building chunks and GeoJSON features for
// gameplay. Raw PBF bytes are kept too, so any other layer (poi, housenumber,
// place, mountain_peak, names…) can be decoded later for visualisation.

import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { buildTile, transferables as buildingTransferables, type TileData } from './buildTile.ts';
import type { BuildingAssembly } from './buildingAssembly.ts';
import { buildGround, clipHalf, groundTransferables, type GroundData } from './groundVector.ts';

type Pt = [number, number];
import { latFromMercator, tileCorner, tileSpan, type TileId } from '../mercator.ts';
import { buildVegetation, vegetationTransferables, type VegetationData } from './vegetationTile.ts';
import { planStreets } from './streetscape.ts';
import { roadStyle } from './roadStyle.ts';
import { streetFurniture } from './furniture.ts';
import type { MapFeature } from '../../game/WaterCollisionController.ts';

/** Layers decoded to GeoJSON up front: gameplay reads them every few seconds. */
export const GAMEPLAY_LAYERS = ['building', 'transportation', 'water', 'waterway', 'landuse', 'landcover', 'park'] as const;

export type GeoFeature = {
  id?: number;
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
};

export type MeshData = {
  positions: Float32Array;
  ground: Float32Array;
  colors?: Uint8Array;
  uvs?: Float32Array;
  index: Uint32Array;
};

export type WorldTileData = {
  tile: TileId;
  corner: [number, number];
  metersScale: number;
  dem: Float32Array | null;
  /** terrain, land-use overlays and water, all vector */
  ground: GroundData;
  /** bridge decks: x0, z0, x1, z1, half width, deck height at 0 and at 1 (tile-local mercator meters, m) */
  bridges: Float32Array;
  roads: MeshData;
  /** streams, canals, ditches: ribbons drawn with the water material */
  streams: MeshData;
  buildings: TileData;
  vegetation: VegetationData;
  features: Record<string, GeoFeature[]>;
  /** every layer name present in the tile, for later visualisation */
  layers: string[];
  raw: ArrayBuffer;
};

export type WorldBuildOptions = {
  buildingAssemblies?: Map<string, BuildingAssembly>;
  dem: Float32Array | null;
  chunks: number;
  inset: number;
  /** terrain grid cells per tile edge */
  grid: number;
  /** country: biases building styles like the old detailed layer */
  region: string;
  /**
   * The vector tiles around this one (dx, dy ∈ -1..1): their roads and railways go into
   * the bridge plan, so a bridge crossing the tile edge gets the same heights on both
   * sides. Without them each tile plans alone (and patches its edges).
   */
  neighbours?: { dx: number; dy: number; buffer: ArrayBuffer }[];
};

/**
 * Height of the terrain grid at tile fraction (u, v) ∈ [0,1]², exactly as the
 * terrain mesh draws it (two planar triangles per cell, diagonal u + v = 1).
 * Roads, plants and the car use this, so they sit on the visible ground.
 */
export function gridGround(heights: Float32Array, grid: number, u: number, v: number) {
  const n = grid + 1;
  const x = Math.min(grid, Math.max(0, u * grid)), y = Math.min(grid, Math.max(0, v * grid));
  const i = Math.min(grid - 1, Math.floor(x)), j = Math.min(grid - 1, Math.floor(y));
  const fu = x - i, fv = y - j;
  const ha = heights[j * n + i], hb = heights[j * n + i + 1], hc = heights[(j + 1) * n + i], hd = heights[(j + 1) * n + i + 1];
  return fu + fv <= 1 ? ha + (hb - ha) * fu + (hc - ha) * fv : hd + (hc - hd) * (1 - fu) + (hb - hd) * (1 - fv);
}

/** Nearest water surface level at tile fraction (u, v), or null on dry land. */
export function gridWaterLevel(levels: Float32Array, grid: number, u: number, v: number): number | null {
  const n = grid + 1;
  const i = Math.min(grid, Math.max(0, Math.round(u * grid)));
  const j = Math.min(grid, Math.max(0, Math.round(v * grid)));
  let best = -Infinity;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
    const level = levels[jj * n + ii];
    if (Number.isFinite(level)) best = Math.max(best, level);
  }
  return best > -Infinity ? best : null;
}

/** floats per bridge deck piece */
const BRIDGE_STRIDE = 7;

/** the widest `widen` any caller asks for: the grid index pads each piece by this much */
const MAX_WIDEN = 1.6;

/** Bridge pieces in square cells, so a height query looks at its own cell only (it ran per vertex over all). */
type BridgeGrid = { x0: number; z0: number; cell: number; nx: number; nz: number; cells: Map<number, number[]>; length: number };
const bridgeGrids = new WeakMap<Float32Array, BridgeGrid>();

function bridgeGrid(bridges: Float32Array): BridgeGrid {
  const known = bridgeGrids.get(bridges);
  if (known && known.length === bridges.length) return known;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, widest = 0;
  for (let i = 0; i < bridges.length; i += BRIDGE_STRIDE) {
    const pad = bridges[i + 4] * MAX_WIDEN;
    widest = Math.max(widest, pad);
    x0 = Math.min(x0, bridges[i] - pad, bridges[i + 2] - pad); x1 = Math.max(x1, bridges[i] + pad, bridges[i + 2] + pad);
    z0 = Math.min(z0, bridges[i + 1] - pad, bridges[i + 3] - pad); z1 = Math.max(z1, bridges[i + 1] + pad, bridges[i + 3] + pad);
  }
  const cell = Math.max(widest * 2, (x1 - x0) / 96, (z1 - z0) / 96, 1e-9);
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const cells = new Map<number, number[]>();
  for (let i = 0; i < bridges.length; i += BRIDGE_STRIDE) {
    const pad = bridges[i + 4] * MAX_WIDEN;
    const cx0 = Math.floor((Math.min(bridges[i], bridges[i + 2]) - pad - x0) / cell), cx1 = Math.floor((Math.max(bridges[i], bridges[i + 2]) + pad - x0) / cell);
    const cz0 = Math.floor((Math.min(bridges[i + 1], bridges[i + 3]) - pad - z0) / cell), cz1 = Math.floor((Math.max(bridges[i + 1], bridges[i + 3]) + pad - z0) / cell);
    for (let cx = Math.max(0, cx0); cx <= Math.min(nx - 1, cx1); cx++) {
      for (let cz = Math.max(0, cz0); cz <= Math.min(nz - 1, cz1); cz++) {
        const key = cz * nx + cx;
        const list = cells.get(key);
        if (list) list.push(i); else cells.set(key, [i]);
      }
    }
  }
  const grid = { x0, z0, cell, nx, nz, cells, length: bridges.length };
  bridgeGrids.set(bridges, grid);
  return grid;
}

/** Deck height if (x, z) lies on a bridge, else null. `widen` expands the ribbon (buildings need more than the car). */
export function bridgeDeck(bridges: Float32Array, x: number, z: number, widen = 1.2): number | null {
  if (!bridges.length) return null;
  const grid = bridgeGrid(bridges);
  const cx = Math.floor((x - grid.x0) / grid.cell), cz = Math.floor((z - grid.z0) / grid.cell);
  if (cx < 0 || cz < 0 || cx >= grid.nx || cz >= grid.nz) return null;
  const list = grid.cells.get(cz * grid.nx + cx);
  if (!list) return null;
  let deck: number | null = null;
  for (const i of list) {
    const ax = bridges[i], az = bridges[i + 1], bx = bridges[i + 2], bz = bridges[i + 3], half = bridges[i + 4];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    // a bit wider than the ribbon — curve chords left outer-wheel gaps that dropped cars through
    if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= half * widen) deck = Math.max(deck ?? -Infinity, bridges[i + 5] + (bridges[i + 6] - bridges[i + 5]) * t);
  }
  return deck;
}

/**
 * Pick ground vs overpass deck. A car under a bridge must stay on the lower road;
 * only snap up when already near the deck (driving on the bridge).
 */
export function pickDriveHeight(ground: number, deck: number | null, atAltitude?: number): number {
  if (deck == null) return ground;
  const gap = deck - ground;
  if (gap < 1.2) return Math.max(ground, deck);
  // dual surface: without a hint, prefer the ground so underpasses never launch
  if (atAltitude == null) return ground;
  // already on the deck (or within a short drop): stick — seams used to report the bed for one frame
  if (atAltitude >= deck - 2.2) return deck;
  // closer to the deck (with a small bias) → stay up; otherwise drive under
  return atAltitude >= ground + gap * 0.4 ? deck : ground;
}

// ---- roads -----------------------------------------------------------------

function hex(color: string): [number, number, number] {
  const v = Number.parseInt(color.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

class RoadBuilder {
  positions: number[] = [];
  ground: number[] = [];
  colors: number[] = [];
  index: number[] = [];

  groundAt: (x: number, z: number) => number;
  /** terrain cell size: every triangle is cut along the cells and their diagonals */
  cell: number;
  grid: number;
  constructor(groundAt: (x: number, z: number) => number, cell: number, grid: number) {
    this.groundAt = groundAt; this.cell = cell; this.grid = grid;
  }

  private vertex(x: number, y: number, z: number, rgb: [number, number, number]) {
    this.positions.push(x, y, z);
    this.ground.push(this.groundAt(x, z));
    this.colors.push(rgb[0], rgb[1], rgb[2]);
    return this.positions.length / 3 - 1;
  }

  /**
   * One triangle draped on the terrain: cut where the terrain bends (cell edges
   * and diagonals), so each piece lies in one terrain plane and the ground can
   * never poke through the pavement.
   */
  tri(a: Pt, b: Pt, c: Pt, y: number, rgb: [number, number, number]) {
    const cs = this.cell, g = this.grid;
    const xs = [a[0], b[0], c[0]], zs = [a[1], b[1], c[1]];
    const i0 = Math.max(0, Math.floor(Math.min(...xs) / cs)), i1 = Math.min(g - 1, Math.floor(Math.max(...xs) / cs));
    const j0 = Math.max(0, Math.floor(Math.min(...zs) / cs)), j1 = Math.min(g - 1, Math.floor(Math.max(...zs) / cs));
    for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
      const x0 = ci * cs, z0 = cj * cs;
      let piece: Pt[] = [a, b, c];
      // cells at the tile edge keep what sticks out (round caps reach a little past it)
      if (ci > 0) piece = clipHalf(piece, 1, 0, -x0);
      if (ci < g - 1) piece = clipHalf(piece, -1, 0, x0 + cs);
      if (cj > 0) piece = clipHalf(piece, 0, 1, -z0);
      if (cj < g - 1) piece = clipHalf(piece, 0, -1, z0 + cs);
      if (piece.length < 3) continue;
      for (const half of [clipHalf(piece, -1 / cs, -1 / cs, 1 + x0 / cs + z0 / cs), clipHalf(piece, 1 / cs, 1 / cs, -1 - x0 / cs - z0 / cs)]) {
        if (half.length < 3) continue;
        const first = this.vertex(half[0][0], y, half[0][1], rgb);
        for (let k = 1; k < half.length; k++) this.vertex(half[k][0], y, half[k][1], rgb);
        for (let k = 1; k + 1 < half.length; k++) this.index.push(first, first + k, first + k + 1);
      }
    }
  }

  /**
   * The wedge on the outside of a gentle bend at q (between the segment coming in along u
   * and the one going out along v): without it the two ribbons leave a notch there.
   */
  bevel(qx: number, qz: number, ux: number, uz: number, vx: number, vz: number, half: number, y: number, rgb: [number, number, number]) {
    const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    if (lu < 1e-9 || lv < 1e-9) return;
    const turn = ux * vz - uz * vx;
    if (Math.abs(turn) < 1e-12) return;
    // the outer side: right of a left turn, left of a right turn
    const s = turn > 0 ? -1 : 1;
    const c1: Pt = [qx - uz / lu * half * s, qz + ux / lu * half * s];
    const c2: Pt = [qx - vz / lv * half * s, qz + vx / lv * half * s];
    const q: Pt = [qx, qz];
    // same winding as the ribbons (negative cross = seen from above)
    const cross = (c1[0] - q[0]) * (c2[1] - q[1]) - (c1[1] - q[1]) * (c2[0] - q[0]);
    if (cross < 0) this.tri(q, c1, c2, y, rgb);
    else this.tri(q, c2, c1, y, rgb);
  }

  /** Straight ribbon a→b, `half` wide on each side, draped on the terrain. */
  segment(ax: number, az: number, bx: number, bz: number, half: number, y: number, rgb: [number, number, number]) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const nx = -dz / len * half, nz = dx / len * half;
    const al: Pt = [ax + nx, az + nz], ar: Pt = [ax - nx, az - nz], bl: Pt = [bx + nx, bz + nz], br: Pt = [bx - nx, bz - nz];
    // CCW seen from above
    this.tri(al, bl, ar, y, rgb);
    this.tri(ar, bl, br, y, rgb);
  }

  /**
   * A quad with explicit heights (bridge structure): corners are x, z, ground
   * (m, scaled by the relief) and y (m, offset on top). Walls are drawn from both
   * sides; a level face only towards `facing`.
   */
  quad(corners: [number, number, number, number][], rgb: [number, number, number], facing?: 'up' | 'down') {
    const first = this.positions.length / 3;
    for (const [x, z, g, y] of corners) {
      this.positions.push(x, y, z);
      this.ground.push(g);
      this.colors.push(rgb[0], rgb[1], rgb[2]);
    }
    const [a, b, c] = corners;
    // same sign convention as the ribbons: negative = seen from above
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const forward = !facing || (facing === 'up') === (cross < 0);
    const backward = !facing || !forward;
    if (forward) this.index.push(first, first + 1, first + 2, first, first + 2, first + 3);
    if (backward) this.index.push(first, first + 2, first + 1, first, first + 3, first + 2);
  }

  /** Round join / cap. */
  disc(x: number, z: number, radius: number, y: number, rgb: [number, number, number], steps = 8) {
    const centre: Pt = [x, z];
    for (let i = 0; i < steps; i++) {
      const a = i / steps * Math.PI * 2, b = (i + 1) / steps * Math.PI * 2;
      this.tri(centre, [x + Math.cos(b) * radius, z + Math.sin(b) * radius], [x + Math.cos(a) * radius, z + Math.sin(a) * radius], y, rgb);
    }
  }
}

/** Liang–Barsky: clip segment to the axis-aligned box [lo, hi]². */
function clipSegmentBox(ax: number, ay: number, bx: number, by: number, lo: number, hi: number): [number, number, number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - lo, hi - ax, ay - lo, hi - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
}

/** Liang–Barsky: clip segment to the tile square [0, extent]². */
/** A polyline cut to the box [x0, x1] × [y0, y1], as the runs inside it (clip points rounded so both tiles agree). */
function clipLineBox(line: XY[], x0: number, y0: number, x1: number, y1: number): XY[][] {
  const out: XY[][] = [];
  let run: XY[] | null = null;
  const snap = (v: number) => Math.round(v * 8) / 8;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy], q = [a.x - x0, x1 - a.x, a.y - y0, y1 - a.y];
    let inside = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) { if (q[k] < 0) { inside = false; break; } continue; }
      const t = q[k] / p[k];
      if (p[k] < 0) { if (t > t1) { inside = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { inside = false; break; } if (t < t1) t1 = t; }
    }
    if (!inside) { run = null; continue; }
    const s0 = t0 > 0 ? { x: snap(a.x + dx * t0), y: snap(a.y + dy * t0) } : a;
    const s1 = t1 < 1 ? { x: snap(a.x + dx * t1), y: snap(a.y + dy * t1) } : b;
    if (!run || t0 > 0) { run = [s0]; out.push(run); }
    run.push(s1);
    if (t1 < 1) run = null;
  }
  return out.filter((r) => r.length >= 2);
}

/**
 * This tile's ways cut to its own square, with the neighbours' ways (cut to their own
 * squares and to a band `margin` wide round ours) in our frame: no way drawn twice, and
 * the pieces of one road meet exactly at the tile edges. Neighbour ids from 1e7 up.
 */
function waysInContext(ways: Map<number, Way>, extra: Map<number, Way>, extent: number): Map<number, Way> {
  const out = new Map<number, Way>();
  for (const [i, way] of ways) {
    const lines = way.lines.flatMap((line) => clipLineBox(line, 0, 0, extent, extent));
    if (lines.length) out.set(i, { ...way, lines });
  }
  for (const [i, way] of extra) out.set(i, way);
  return out;
}

function clipSegment(ax: number, ay: number, bx: number, by: number, extent: number): [number, number, number, number] | null {
  return clipSegmentBox(ax, ay, bx, by, 0, extent);
}

function meshOf(builder: RoadBuilder): MeshData {
  return {
    positions: new Float32Array(builder.positions),
    ground: new Float32Array(builder.ground),
    colors: new Uint8Array(builder.colors),
    index: new Uint32Array(builder.index),
  };
}

/** Streams, canals, ditches: water ribbons (rivers come as water polygons). */
function streamMesh(vt: VectorTile, span: number, metersScale: number, groundAt: (x: number, z: number) => number, grid: number): MeshData {
  const builder = new RoadBuilder(groundAt, span / grid, grid);
  const ways = vt.layers.waterway;
  if (ways) {
    const k = span / ways.extent;
    const toMerc = 1 / metersScale;
    const natural: [number, number, number] = [0, 0, 0]; // water kind 0: natural (not a pool)
    for (let i = 0; i < ways.length; i++) {
      const f = ways.feature(i);
      if (f.type !== 2 || f.properties.brunnel === 'tunnel') continue;
      const cls = String(f.properties.class ?? '');
      if (cls === 'river') continue;
      const half = (cls === 'canal' ? 4 : 1.3) * toMerc;
      for (const line of f.loadGeometry()) for (let j = 0; j + 1 < line.length; j++) {
        const c = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, ways.extent);
        if (!c) continue;
        builder.segment(c[0] * k, c[1] * k, c[2] * k, c[3] * k, half, 0.04, natural);
        // round joins so the bends have no notches
        if (j > 0 && c[0] === line[j].x && c[1] === line[j].y) builder.disc(c[0] * k, c[1] * k, half, 0.04, natural, 8);
      }
    }
  }
  return meshOf(builder);
}

// ---- bridges ----------------------------------------------------------------

type Surfaces = {
  /** where the roads lie: the ground, a finger above any water */
  driveAt: (x: number, z: number) => number;
  /** the terrain itself (river beds carved) */
  groundAt: (x: number, z: number) => number;
  /** water surface level, or null on dry land */
  waterAt: (x: number, z: number) => number | null;
  toMerc: number;
};

/** A point of a line in tile extent units. */
type XY = { x: number; y: number };

/** A bridge deck: points every few meters with the deck and bed heights under them. */
type Deck = { pts: Pt[]; s: number[]; h: number[]; bed: number[]; length: number };

/** The deck must be at least `h` high at arc length `s` (mercator): where it crosses a lower way. */
type Need = { s: number; h: number };

/** A road or railway in the tile: its lines, whether it is a bridge, and its level (OSM layer). */
type Way = {
  lines: XY[][]; bridge: boolean; level: number; /** paths, steps, platforms: nothing to clear over */ foot: boolean;
  /** a neighbour's way: the half width its deck has (m), for the car on our side of the edge */
  half?: number;
};

/** How a way is drawn: lifted parts as decks, the rest on the ground as usual. */
type Planned = { decks: Deck[]; rest: XY[][] };

/** clearance under an overpass, deck top over the road below (m) */
const OVER_CLEAR = 5.5;
/** an overpass and its approach ramps climb at most this steeply */
const RAMP_SLOPE = 0.08;
/** where a bridge leaves the tile (or two bridge ways meet) over water, the deck is this high above it (m) */
const BRIDGE_CLEAR = 3;
/** the deck clears the water at least this much where it can (m) */
const BRIDGE_MIN_CLEAR = 2.2;
/** deck points every this many meters */
const DECK_STEP = 8;
/** concrete piers about this far apart (m) */
const PIER_GAP = 28;
/** deck slab thickness under the road (m) */
const SLAB = 0.9;
/** parapet height over the deck (m) */
const PARAPET = 0.75;

const CONCRETE = hex('#8c8880');
const PARAPET_TOP = hex('#aaa59c');
const UNDERSIDE = hex('#4c4a46');

/** Arc length (mercator) at each point of a polyline. */
function arcLengths(pts: Pt[]) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return s;
}

/** Points every DECK_STEP m along a polyline, the original vertices kept. */
function subdivide(line: Pt[], toMerc: number) {
  const step = DECK_STEP * toMerc;
  const pts: Pt[] = [line[0]];
  const s = [0];
  /** index in `pts` of each original vertex */
  const at = [0];
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1], [bx, bz] = line[i];
    const len = Math.hypot(bx - ax, bz - az);
    const n = len < 1e-9 ? 0 : Math.max(1, Math.ceil(len / step));
    for (let q = 1; q <= n; q++) {
      pts.push([ax + (bx - ax) * q / n, az + (bz - az) * q / n]);
      s.push(s[s.length - 1] + len / n);
    }
    at.push(pts.length - 1);
  }
  return { pts, s, at };
}

/**
 * Height of a bridge end. A real end meets the road on the bank (its drive height,
 * or higher when a neighbouring bridge lifted that point). Where the line is cut by
 * the tile's buffer, or ends over the river, the deck is BRIDGE_CLEAR above the
 * water there: neighbouring tiles compute the same height.
 */
function endHeight(p: Pt, real: boolean, at: Surfaces, lifted = -Infinity) {
  const [x, z] = p;
  const w = at.waterAt(x, z), d = at.driveAt(x, z);
  // over the river itself, not just on the bank next to it
  if (w != null && (!real || at.groundAt(x, z) < w - 1)) return Math.max(d, w + BRIDGE_CLEAR, lifted);
  return Math.max(d, lifted);
}

/**
 * A bridge deck along a whole line: straight between its end heights with a slight
 * camber over water; at least BRIDGE_MIN_CLEAR over the river and OVER_CLEAR over
 * every lower road or railway it crosses, climbing to that at RAMP_SLOPE — so a deck may end above the ground; the approach roads then rise
 * to meet it (see planBridges).
 */
function deckProfile(line: Pt[], ends: [number, number], at: Surfaces, needs: Need[], real: [boolean, boolean] = [true, true], free: [boolean, boolean] = [false, false]): Deck {
  const { pts, s } = subdivide(line, at.toMerc);
  const length = s[s.length - 1];
  const water = pts.map(([x, z]) => at.waterAt(x, z));
  const bed = pts.map(([x, z]) => at.groundAt(x, z));
  const [h0, h1] = ends;
  const meters = length / at.toMerc;
  const base = s.map((si) => h0 + (h1 - h0) * (length > 0 ? si / length : 0));
  // light camber only — a tall sin-hump on top of clearance made single spans peaky,
  // but never shave/cap stacked clearances (that collapsed Manhattan interchanges)
  const wet = water.some((w) => w != null);
  const hump = wet ? Math.min(0.35, meters * 0.008) : 0;
  const h = base.map((b, i) => b + hump * (length > 0 ? Math.sin(Math.PI * s[i] / length) : 0));
  // clear the river as far as the deck can climb from the banks (the river never lifts the ends)
  const climb = (i: number) => RAMP_SLOPE * Math.min(real[0] ? s[i] : Infinity, real[1] ? length - s[i] : Infinity) / at.toMerc;
  for (let n = 0; n < pts.length; n++) {
    const w = water[n];
    if (w == null || bed[n] >= w - 1) continue;
    for (let i = 0; i < h.length; i++) {
      const lift = w + BRIDGE_MIN_CLEAR - RAMP_SLOPE * Math.abs(s[i] - s[n]) / at.toMerc;
      h[i] = Math.max(h[i], Math.min(lift, base[i] + climb(i)));
    }
  }
  // clear every lower way crossed, climbing at RAMP_SLOPE (approach roads rise to meet it)
  for (const need of needs) for (let i = 0; i < h.length; i++) h[i] = Math.max(h[i], need.h - RAMP_SLOPE * Math.abs(s[i] - need.s) / at.toMerc);
  // an end nothing continues from (a footbridge into a square, a building): no road
  // can ramp up to meet it, so the deck itself comes down to the ground there
  if (free[0] || free[1]) {
    for (let i = 0; i < h.length; i++) {
      if (free[0]) h[i] = Math.min(h[i], h0 + RAMP_SLOPE * s[i] / at.toMerc);
      if (free[1]) h[i] = Math.min(h[i], h1 + RAMP_SLOPE * (length - s[i]) / at.toMerc);
    }
  }
  // Re-assert clearance after free ramps. Short пешеходный переход spans were
  // crushed flat by the free-end min, so neighbouring stubs met on the ground
  // (or left a stair portal beside a floating walkway) instead of in the air.
  for (const need of needs) {
    for (let i = 0; i < h.length; i++) {
      h[i] = Math.max(h[i], need.h - RAMP_SLOPE * Math.abs(s[i] - need.s) / at.toMerc);
    }
  }
  // never under the ground: a straight line between the ends dips into any rise between
  // them (a hump, a bank higher than the ends), and the road beside it tears; there it
  // runs on the ground like a causeway
  for (let i = 0; i < h.length; i++) h[i] = Math.max(h[i], at.driveAt(pts[i][0], pts[i][1]) + 0.05);
  return { pts, s, h, bed, length };
}

/**
 * A deck cut to the tile square. `pad` keeps a few metres past the edge so
 * neighbouring tiles overlap at seams instead of leaving an air gap when OSM
 * ways or clip rounding disagree.
 */
function clipDeck(deck: Deck, span: number, at: Surfaces, pad = 0): Deck[] {
  const out: Deck[] = [];
  let cur: Deck | null = null;
  const lo = -pad, hi = span + pad;
  for (let i = 1; i < deck.pts.length; i++) {
    const [ax, az] = deck.pts[i - 1], [bx, bz] = deck.pts[i];
    const c = clipSegmentBox(ax, az, bx, bz, lo, hi);
    if (!c) { cur = null; continue; }
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const ta = Math.hypot(c[0] - ax, c[1] - az) / len, tb = Math.hypot(c[2] - ax, c[3] - az) / len;
    const height = (t: number) => deck.h[i - 1] + (deck.h[i] - deck.h[i - 1]) * t;
    if (!cur || ta > 1e-9) {
      cur = { pts: [[c[0], c[1]]], s: [0], h: [height(ta)], bed: [at.groundAt(c[0], c[1])], length: 0 };
      out.push(cur);
    }
    cur.length += Math.hypot(c[2] - c[0], c[3] - c[1]);
    cur.pts.push([c[2], c[3]]);
    cur.s.push(cur.length);
    cur.h.push(height(tb));
    cur.bed.push(at.groundAt(c[2], c[3]));
    if (tb < 1 - 1e-9) cur = null;
  }
  return out.filter((d) => d.length > 0);
}

/** Deck height of the nearest piece to (x, z). */
function sampleDecks(decks: Deck[] | undefined, x: number, z: number): number | null {
  let best = Infinity, height: number | null = null;
  for (const deck of decks ?? []) for (let i = 1; i < deck.pts.length; i++) {
    const [ax, az] = deck.pts[i - 1], [bx, bz] = deck.pts[i];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
    if (d < best) { best = d; height = deck.h[i - 1] + (deck.h[i] - deck.h[i - 1]) * t; }
  }
  return height;
}

/** Parameter along a→b where it crosses c→d, or null. */
function crossing(a: XY, b: XY, c: XY, d: XY): number | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Same as `crossing`, for deck points in mercator metres. */
function crossingMerc(a: Pt, b: Pt, c: Pt, d: Pt): number | null {
  return crossing({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, { x: c[0], y: c[1] }, { x: d[0], y: d[1] });
}

/**
 * |cos| of the two segment directions. ~1 = parallel / tangential merge,
 * ~0 = right-angle crossing. Stack only the latter.
 */
function segmentAlign(a: XY, b: XY, c: XY, d: XY) {
  const ax = b.x - a.x, ay = b.y - a.y, bx = d.x - c.x, by = d.y - c.y;
  return Math.abs(ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
}

/** Above this |cos|, a geometric cross is a merge/split — keep coplanar. */
const TANGENT_COS = 0.55;

/** Raise a finished deck so it clears `minH` at arc length `atS`. */
function liftDeckClear(deck: Deck, atS: number, minH: number, toMerc: number) {
  for (let i = 0; i < deck.h.length; i++) {
    deck.h[i] = Math.max(deck.h[i], minH - RAMP_SLOPE * Math.abs(deck.s[i] - atS) / toMerc);
  }
}

/** Roads and railways of the tile, by feature index (tunnels left out). */
function transportWays(layer: VectorTile['layers'][string]): Map<number, Way> {
  const ways = new Map<number, Way>();
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2) continue;
    const p = feature.properties;
    if (p.brunnel === 'tunnel') continue;
    if (!roadStyle(String(p.class ?? ''), String(p.subclass ?? ''), Number(p.ramp) === 1) && !railKind(p)) continue;
    const bridge = p.brunnel === 'bridge';
    const level = Number(p.layer ?? (bridge ? 1 : 0)) || (bridge ? 1 : 0);
    const foot = p.class === 'path' || p.class === 'track';
    ways.set(i, { lines: feature.loadGeometry().map((line) => line.map(({ x, y }) => ({ x, y }))), bridge, level, foot });
  }
  return ways;
}

/**
 * Bridges and overpasses for the whole tile. Every bridge gets a deck along its
 * whole line (cut ends included, so neighbouring tiles agree), lifted over each
 * lower way it crosses (lower bridges first, so a bridge clears the deck below).
 * Two rounds let bridges that meet end to end share their heights. A road that
 * reaches a lifted bridge end climbs to it as a ramp on the same kind of deck.
 */
export function planBridges(ownWays: Map<number, Way>, extent: number, span: number, at: Surfaces, extra?: Map<number, Way>): Map<number, Planned> {
  const k = span / extent;
  // with the neighbours' ways the plan sees past the edge: no edge patching needed after
  const context = !!extra?.size;
  const ways = context ? waysInContext(ownWays, extra!, extent) : ownWays;
  const toM = (p: XY): Pt => [p.x * k, p.y * k];
  const key = (p: XY) => p.x + ',' + p.y;
  // how many lines pass through each point: a bridge end on one line only continues nowhere
  const through = new Map<string, number>();
  for (const way of ways.values()) for (const line of way.lines) for (const k of new Set(line.map(key))) through.set(k, (through.get(k) ?? 0) + 1);
  // a line cut by the tile buffer ends on its edge, outside the tile
  let lo = Infinity, hi = -Infinity;
  for (const way of ways.values()) for (const line of way.lines) for (const p of line) { lo = Math.min(lo, p.x, p.y); hi = Math.max(hi, p.x, p.y); }
  const cut = (p: XY) => (p.x < 0 || p.y < 0 || p.x > extent || p.y > extent) && (p.x <= lo + 0.5 || p.y <= lo + 0.5 || p.x >= hi - 0.5 || p.y >= hi - 0.5);
  const boxes = new Map<XY[], [number, number, number, number]>();
  for (const way of ways.values()) for (const line of way.lines) {
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of line) { box[0] = Math.min(box[0], p.x); box[1] = Math.min(box[1], p.y); box[2] = Math.max(box[2], p.x); box[3] = Math.max(box[3], p.y); }
    boxes.set(line, box);
  }
  const bridges = [...ways].filter(([, w]) => w.bridge).sort((a, b) => a[1].level - b[1].level);
  const full = new Map<number, Deck[]>();
  let ends = new Map<string, number>();
  for (let round = 0; round < 2; round++) {
    const next = new Map<string, number>();
    for (const [i, way] of bridges) {
      const decks: Deck[] = [];
      for (const line of way.lines) {
        if (line.length < 2) continue;
        const pts = line.map(toM);
        const s = arcLengths(pts);
        const mine = new Set(line.map(key));
        const box = boxes.get(line)!;
        const needs: Need[] = [];
        for (const [o, other] of ways) {
          if (o === i || other.foot) continue;
          // Lower OSM layer always goes under. Same layer: only stack when the
          // other is also a bridge and we win the id order — and only for
          // near-orthogonal crosses (tangential merges stay coplanar).
          const same = other.level === way.level;
          const below = other.level < way.level || (same && other.bridge && o < i);
          if (!below) continue;
          for (const ol of other.lines) {
            const ob = boxes.get(ol)!;
            if (ob[0] > box[2] || ob[2] < box[0] || ob[1] > box[3] || ob[3] < box[1]) continue;
            if (ol.some((q) => mine.has(key(q)))) continue; // joined to the bridge, not under it
            for (let a = 0; a + 1 < line.length; a++) for (let b = 0; b + 1 < ol.length; b++) {
              const t = crossing(line[a], line[a + 1], ol[b], ol[b + 1]);
              if (t == null) continue;
              if (same && segmentAlign(line[a], line[a + 1], ol[b], ol[b + 1]) > TANGENT_COS) continue;
              const x = pts[a][0] + (pts[a + 1][0] - pts[a][0]) * t, z = pts[a][1] + (pts[a + 1][1] - pts[a][1]) * t;
              const under = (other.bridge ? sampleDecks(full.get(o), x, z) : null) ?? at.driveAt(x, z);
              needs.push({ s: s[a] + (s[a + 1] - s[a]) * t, h: under + OVER_CLEAR });
            }
          }
        }
        const first = line[0], last = line[line.length - 1];
        const deck = deckProfile(pts, [
          endHeight(pts[0], !cut(first), at, ends.get(key(first))),
          endHeight(pts[pts.length - 1], !cut(last), at, ends.get(key(last))),
        ], at, needs, [!cut(first), !cut(last)], [!cut(first) && (through.get(key(first)) ?? 0) < 2, !cut(last) && (through.get(key(last)) ?? 0) < 2]);
        decks.push(deck);
        for (const [p, h] of [[first, deck.h[0]], [last, deck.h[deck.h.length - 1]]] as [XY, number][]) {
          if (!cut(p)) next.set(key(p), Math.max(next.get(key(p)) ?? -Infinity, h));
        }
      }
      full.set(i, decks);
    }
    ends = next;
  }
  // overlap past the tile edge so neighbour decks cover clip / OSM shortfalls
  const seamPad = 3.5 * at.toMerc;
  const plan = new Map<number, Planned>();
  for (const [i, decks] of full) {
    const clipped = decks.flatMap((d) => clipDeck(d, span, at, seamPad));
    // tile-border tips must use the same formula on both sides — in-tile `needs`
    // were lifting one half and leaving a step / hole at the seam
    if (!context) for (const d of clipped) sealDeckBorderTips(d, span, at);
    plan.set(i, { decks: clipped, rest: [] });
  }
  // approach ramps: ground ways meeting a bridge end that stands above the ground
  for (const [i, way] of ways) {
    if (way.bridge) continue;
    let ramped = false;
    const planned: Planned = { decks: [], rest: [] };
    for (const line of way.lines) {
      const lifts = line.map((q) => { const h = ends.get(key(q)); return h == null ? 0 : h - at.driveAt(q.x * k, q.y * k); });
      if (!lifts.some((l) => l > 0.3)) { planned.rest.push(line); continue; }
      ramped = true;
      const { pts, s, at: vertexAt } = subdivide(line.map(toM), at.toMerc);
      const sources = lifts.map((lift, v) => ({ lift, s: s[vertexAt[v]] })).filter((src) => src.lift > 0.3);
      const lift = s.map((si) => Math.max(0, ...sources.map((src) => src.lift - RAMP_SLOPE * Math.abs(si - src.s) / at.toMerc)));
      // runs of pieces, lifted or on the ground
      const up = (n: number) => lift[n - 1] > 0.02 || lift[n] > 0.02;
      let start = 0;
      for (let n = 1; n < pts.length; n++) {
        const lifted = up(n);
        if (n + 1 < pts.length && up(n + 1) === lifted) continue;
        const run = pts.slice(start, n + 1);
        if (lifted) {
          const sr = s.slice(start, n + 1).map((v) => v - s[start]);
          const deck: Deck = { pts: run, s: sr, h: run.map(([x, z], m) => at.driveAt(x, z) + lift[start + m]), bed: run.map(([x, z]) => at.groundAt(x, z)), length: sr[sr.length - 1] };
          // same seam pad as bridge decks — flush-cut ramps left a step at the tile edge
          const pieces = clipDeck(deck, span, at, seamPad);
          if (!context) for (const d of pieces) sealDeckBorderTips(d, span, at);
          planned.decks.push(...pieces);
        } else planned.rest.push(run.map(([x, z]) => ({ x: x / k, y: z / k })));
        start = n;
      }
    }
    if (ramped) plan.set(i, planned);
  }
  // Elevated ribbons that cross steeply (ramps included) must not share a deck
  // height — that leaves parapets across the carriageway. Tangential merges stay put.
  stackOrthogonalDecks(plan, at);
  // Footbridges and split OSM ways often meet a few metres apart with different
  // tip heights — snap those ends so the crossing is one continuous deck.
  joinNearbyDeckEnds(plan, at.toMerc);
  // Same-level / merge ribbons that still sit on top of each other: pull coplanar
  // instead of leaving a crossed pile (common on Manhattan ramps).
  coalesceCoplanarDecks(plan, at);
  // facing stubs across a small air gap (split ways inside the tile): meet mid-way.
  // Border tips stay put — the neighbour tile owns the other half of that seam.
  closeFacingDeckGaps(plan, at.toMerc, span);
  if (context) {
    // planned with the neighbours: heights already agree across the edge. Their decks stay
    // in the plan only where they reach our edge (clipDeck padded them): the car on our
    // side of a ribbon that lies across the edge still has the deck under it
    return plan;
  }
  // OSM ways that stop a few metres short of the tile edge leave an air gap with
  // the neighbour — pull those tips onto the shared square before resealing.
  extendNearBorderTips(plan, span, at.toMerc);
  // stack / join / close lift tips again; floor + unify so both tiles share the edge
  for (const planned of plan.values()) for (const d of planned.decks) sealDeckBorderTips(d, span, at);
  unifyBorderEdgeTips(plan, span, at);
  return plan;
}

/**
 * If an elevated tip sits just inside the tile and points straight at an edge,
 * snap it onto the shared square. Keep this tight: a long/diagonal pull turns
 * ramps into a fan of beams (the tangled эстакада screenshots).
 */
function extendNearBorderTips(plan: Map<number, Planned>, span: number, toMerc: number) {
  // only close a short OSM shortfall — seamPad already overlaps ~3.5 m past the edge
  const reach = 8 * toMerc;
  const eps = Math.max(1e-3 * span, 0.02 * toMerc);
  // must aim mostly at the edge (not a glancing merge that would slide sideways)
  const aim = 0.82;
  for (const planned of plan.values()) for (const deck of planned.decks) {
    if (deck.pts.length < 2) continue;
    const tips = [0, deck.pts.length - 1];
    for (const tip of tips) {
      if (deck.h[tip] - deck.bed[tip] < 1.5) continue;
      const [x, z] = deck.pts[tip];
      if (x <= eps || z <= eps || x >= span - eps || z >= span - eps) continue;
      const [odx, odz] = tipOutward(deck, tip);
      let nx = x, nz = z, hit = false;
      if (odx < -aim && x < reach) {
        const dx = 0 - x;
        const lateral = odz * dx / (odx || -1e-9);
        // reject steep glances — those drew diagonal "ears" across the interchange
        if (Math.abs(lateral) <= Math.abs(dx) * 0.4) { nx = 0; nz = z + lateral; hit = true; }
      } else if (odx > aim && span - x < reach) {
        const dx = span - x;
        const lateral = odz * dx / (odx || 1e-9);
        if (Math.abs(lateral) <= Math.abs(dx) * 0.4) { nx = span; nz = z + lateral; hit = true; }
      } else if (odz < -aim && z < reach) {
        const dz = 0 - z;
        const lateral = odx * dz / (odz || -1e-9);
        if (Math.abs(lateral) <= Math.abs(dz) * 0.4) { nz = 0; nx = x + lateral; hit = true; }
      } else if (odz > aim && span - z < reach) {
        const dz = span - z;
        const lateral = odx * dz / (odz || 1e-9);
        if (Math.abs(lateral) <= Math.abs(dz) * 0.4) { nz = span; nx = x + lateral; hit = true; }
      }
      if (!hit || nx < -reach || nx > span + reach || nz < -reach || nz > span + reach) continue;
      nx = Math.max(0, Math.min(span, nx));
      nz = Math.max(0, Math.min(span, nz));
      deck.pts[tip] = [nx, nz];
      if (tip === 0 && deck.pts.length > 1) {
        const d = Math.hypot(deck.pts[1][0] - nx, deck.pts[1][1] - nz);
        const old = deck.s[1] - deck.s[0];
        const delta = d - old;
        for (let k = 1; k < deck.s.length; k++) deck.s[k] += delta;
        deck.length += delta;
      } else if (tip > 0) {
        const n = deck.pts.length - 1;
        const d = Math.hypot(nx - deck.pts[n - 1][0], nz - deck.pts[n - 1][1]);
        deck.s[n] = deck.s[n - 1] + d;
        deck.length = deck.s[n];
      }
    }
  }
}

/**
 * Shared floor for elevated tips near the tile edge. Uses driveAt only (already
 * sits above carved water) + OVER_CLEAR, quantized — never the wet/dry fork that
 * sent one tile to water+3 and its neighbour to ground+5.5.
 */
function borderSealHeight(x: number, z: number, at: Surfaces) {
  // sample on the tile plane (overhang tips still evaluate at 0 / span)
  return Math.round((at.driveAt(x, z) + OVER_CLEAR) * 2) / 2;
}

/**
 * Floor elevated tips near the tile edge up to `borderSealHeight`. Never pull
 * the deck down (Math.min grades dug the V-shaped collapses in screenshots).
 */
function sealDeckBorderTips(deck: Deck, span: number, at: Surfaces) {
  if (deck.pts.length < 2) return;
  // include overhang past the square (clipDeck pad)
  const band = Math.max(4 * at.toMerc, 0.02 * span);
  const onSeam = (x: number, z: number) =>
    x <= band || z <= band || x >= span - band || z >= span - band;
  const sampleAt = (x: number, z: number): Pt => {
    let sx = x, sz = z;
    if (sx <= band) sx = 0;
    else if (sx >= span - band) sx = span;
    if (sz <= band) sz = 0;
    else if (sz >= span - band) sz = span;
    return [sx, sz];
  };
  const seal = (tip: number) => {
    const [x, z] = deck.pts[tip];
    if (!onSeam(x, z)) return;
    if (deck.h[tip] - deck.bed[tip] < 1.2) return;
    const [sx, sz] = sampleAt(x, z);
    const floor = borderSealHeight(sx, sz, at);
    // raise only — keep clearance tents, don't dig a valley into the span
    if (floor > deck.h[tip]) {
      liftDeckClear(deck, deck.s[tip], floor, at.toMerc);
      deck.h[tip] = floor;
    }
  };
  seal(0);
  seal(deck.pts.length - 1);
}

/**
 * Parallel elevated tips on the same tile edge (multi-lane overpass): lift all
 * to the highest tip so lanes don't step at the seam.
 */
function unifyBorderEdgeTips(plan: Map<number, Planned>, span: number, at: Surfaces) {
  const band = Math.max(4 * at.toMerc, 0.02 * span);
  type End = { deck: Deck; tip: number; h: number; s: number; edge: 0 | 1 | 2 | 3 };
  const ends: End[] = [];
  for (const planned of plan.values()) for (const deck of planned.decks) {
    if (deck.pts.length < 2) continue;
    for (const tip of [0, deck.pts.length - 1]) {
      if (deck.h[tip] - deck.bed[tip] < 1.5) continue;
      const [x, z] = deck.pts[tip];
      const edge: 0 | 1 | 2 | 3 | null =
        x <= band ? 0 : x >= span - band ? 1 : z <= band ? 2 : z >= span - band ? 3 : null;
      if (edge == null) continue;
      ends.push({ deck, tip, h: deck.h[tip], s: deck.s[tip], edge });
    }
  }
  for (const edge of [0, 1, 2, 3] as const) {
    const group = ends.filter((e) => e.edge === edge);
    if (group.length < 2) continue;
    const target = Math.max(...group.map((e) => e.h), borderSealHeight(
      edge === 0 ? 0 : edge === 1 ? span : group[0].deck.pts[group[0].tip][0],
      edge === 2 ? 0 : edge === 3 ? span : group[0].deck.pts[group[0].tip][1],
      at,
    ));
    for (const e of group) {
      if (target - e.deck.h[e.tip] < 0.08) continue;
      liftDeckClear(e.deck, e.s, target, at.toMerc);
      e.deck.h[e.tip] = target;
    }
  }
}

/**
 * Raise matching elevated tips that nearly meet (common for пешеходный переход
 * pieces tagged as separate ways). Without this, one stub floats beside another
 * at a different height and the stair tower fills the gap as a black portal.
 */
function tipOutward(deck: Deck, tip: number): [number, number] {
  if (tip === 0) {
    const [x0, z0] = deck.pts[0], [x1, z1] = deck.pts[1];
    const len = Math.hypot(x0 - x1, z0 - z1) || 1;
    return [(x0 - x1) / len, (z0 - z1) / len];
  }
  const n = deck.pts.length;
  const [x0, z0] = deck.pts[n - 2], [x1, z1] = deck.pts[n - 1];
  const len = Math.hypot(x1 - x0, z1 - z0) || 1;
  return [(x1 - x0) / len, (z1 - z0) / len];
}

function joinNearbyDeckEnds(plan: Map<number, Planned>, toMerc: number) {
  type End = { deck: Deck; tip: number; x: number; z: number; h: number; s: number };
  const ends: End[] = [];
  for (const planned of plan.values()) for (const deck of planned.decks) {
    if (deck.pts.length < 2) continue;
    const last = deck.pts.length - 1;
    if (deck.h[0] - deck.bed[0] > 1.5) {
      ends.push({ deck, tip: 0, x: deck.pts[0][0], z: deck.pts[0][1], h: deck.h[0], s: deck.s[0] });
    }
    if (deck.h[last] - deck.bed[last] > 1.5) {
      ends.push({ deck, tip: last, x: deck.pts[last][0], z: deck.pts[last][1], h: deck.h[last], s: deck.s[last] });
    }
  }
  const reach = 10 * toMerc;
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i], b = ends[j];
      if (a.deck === b.deck) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) > reach) continue;
      const target = Math.max(a.h, b.h);
      if (target - a.h > 0.12) liftDeckClear(a.deck, a.s, target, toMerc);
      if (target - b.h > 0.12) liftDeckClear(b.deck, b.s, target, toMerc);
      a.deck.h[a.tip] = Math.max(a.deck.h[a.tip], target);
      b.deck.h[b.tip] = Math.max(b.deck.h[b.tip], target);
      a.h = a.deck.h[a.tip];
      b.h = b.deck.h[b.tip];
    }
  }
}

/**
 * Two elevated stubs that point at each other across a few metres of air
 * (split OSM ways inside the tile): slide tips to the midpoint and match height.
 * Tips on the tile square stay glued — reseal owns those seams with the neighbour.
 */
function closeFacingDeckGaps(plan: Map<number, Planned>, toMerc: number, span: number) {
  type End = { deck: Deck; tip: number; x: number; z: number; h: number };
  const eps = Math.max(1e-3 * span, 0.02 * toMerc);
  const onBorder = (x: number, z: number) =>
    x <= eps || z <= eps || x >= span - eps || z >= span - eps;
  const ends: End[] = [];
  for (const planned of plan.values()) for (const deck of planned.decks) {
    if (deck.pts.length < 2) continue;
    const last = deck.pts.length - 1;
    if (deck.h[0] - deck.bed[0] > 1.5 && !onBorder(deck.pts[0][0], deck.pts[0][1])) {
      ends.push({ deck, tip: 0, x: deck.pts[0][0], z: deck.pts[0][1], h: deck.h[0] });
    }
    if (deck.h[last] - deck.bed[last] > 1.5 && !onBorder(deck.pts[last][0], deck.pts[last][1])) {
      ends.push({ deck, tip: last, x: deck.pts[last][0], z: deck.pts[last][1], h: deck.h[last] });
    }
  }
  // keep short — long mid-point slides drew diagonal beams across interchanges
  const maxGap = 10 * toMerc;
  const used = new Set<number>();
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i)) continue;
    let best = -1, bestDist = maxGap;
    const a = ends[i];
    const [adx, adz] = tipOutward(a.deck, a.tip);
    for (let j = i + 1; j < ends.length; j++) {
      if (used.has(j)) continue;
      const b = ends[j];
      if (a.deck === b.deck) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.15 * toMerc || dist > bestDist) continue;
      const [bdx, bdz] = tipOutward(b.deck, b.tip);
      // opposite directions and each tip points toward the other
      if (adx * bdx + adz * bdz > -0.35) continue;
      if (dist > 1e-9 && (adx * dx + adz * dz) / dist < 0.55) continue;
      if (dist > 1e-9 && (bdx * -dx + bdz * -dz) / dist < 0.55) continue;
      if (Math.abs(a.h - b.h) > 4.5) continue;
      best = j;
      bestDist = dist;
    }
    if (best < 0) continue;
    const b = ends[best];
    used.add(i);
    used.add(best);
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const mh = Math.max(a.h, b.h);
    a.deck.pts[a.tip] = [mx, mz];
    b.deck.pts[b.tip] = [mx, mz];
    a.deck.h[a.tip] = mh;
    b.deck.h[b.tip] = mh;
    a.deck.bed[a.tip] = Math.min(a.deck.bed[a.tip], b.deck.bed[b.tip]);
    b.deck.bed[b.tip] = a.deck.bed[a.tip];
    // refresh length along the tip segment for sampling
    const fixS = (deck: Deck, tip: number) => {
      if (tip === 0 && deck.pts.length > 1) {
        const d = Math.hypot(deck.pts[1][0] - deck.pts[0][0], deck.pts[1][1] - deck.pts[0][1]);
        const old = deck.s[1] - deck.s[0];
        const delta = d - old;
        for (let k = 1; k < deck.s.length; k++) deck.s[k] += delta;
        deck.length += delta;
      } else if (tip > 0) {
        const n = deck.pts.length - 1;
        const d = Math.hypot(deck.pts[n][0] - deck.pts[n - 1][0], deck.pts[n][1] - deck.pts[n - 1][1]);
        deck.s[n] = deck.s[n - 1] + d;
        deck.length = deck.s[n];
      }
    };
    fixS(a.deck, a.tip);
    fixS(b.deck, b.tip);
    liftDeckClear(a.deck, a.deck.s[a.tip], mh, toMerc);
    liftDeckClear(b.deck, b.deck.s[b.tip], mh, toMerc);
  }
}

/**
 * Split OSM ramps / parallel carriageways often cross a few metres apart in height
 * and draw as a tangled pile. If they are nearly coplanar (not a real stacked level),
 * pull both to the higher deck around the junction so the ribbon reads as one road.
 */
function coalesceCoplanarDecks(plan: Map<number, Planned>, at: Surfaces) {
  const toMerc = at.toMerc;
  const ids = [...plan.keys()];
  for (let round = 0; round < 2; round++) {
    let changed = false;
    for (let ai = 0; ai < ids.length; ai++) {
      for (let bi = 0; bi < ai; bi++) {
        const aDecks = plan.get(ids[ai])?.decks ?? [];
        const bDecks = plan.get(ids[bi])?.decks ?? [];
        for (const da of aDecks) {
          for (const db of bDecks) {
            for (let a = 1; a < da.pts.length; a++) {
              for (let b = 1; b < db.pts.length; b++) {
                const t = crossingMerc(da.pts[a - 1], da.pts[a], db.pts[b - 1], db.pts[b]);
                if (t == null) continue;
                const align = segmentAlign(
                  { x: da.pts[a - 1][0], y: da.pts[a - 1][1] },
                  { x: da.pts[a][0], y: da.pts[a][1] },
                  { x: db.pts[b - 1][0], y: db.pts[b - 1][1] },
                  { x: db.pts[b][0], y: db.pts[b][1] },
                );
                const x = da.pts[a - 1][0] + (da.pts[a][0] - da.pts[a - 1][0]) * t;
                const z = da.pts[a - 1][1] + (da.pts[a][1] - da.pts[a - 1][1]) * t;
                const ha = sampleDecks([da], x, z);
                const hb = sampleDecks([db], x, z);
                if (ha == null || hb == null) continue;
                const gap = Math.abs(ha - hb);
                if (gap < 0.4 || gap > 3.5) continue;
                // real multi-level cross with clearance — leave the stack
                if (align <= TANGENT_COS && gap > OVER_CLEAR * 0.5) continue;
                const target = Math.max(ha, hb);
                const sa = da.s[a - 1] + (da.s[a] - da.s[a - 1]) * t;
                const sb = db.s[b - 1] + (db.s[b] - db.s[b - 1]) * t;
                liftDeckClear(da, sa, target, toMerc);
                liftDeckClear(db, sb, target, toMerc);
                changed = true;
              }
            }
          }
        }
      }
    }
    if (!changed) break;
  }
}

/** True when another elevated deck tip sits here — the walkway continues, no stair. */
function deckContinuesNear(plan: Map<number, Planned>, self: Deck, x: number, z: number, h: number, toMerc: number) {
  const reach = 3.5 * toMerc;
  for (const planned of plan.values()) {
    for (const other of planned.decks) {
      if (other === self || other.pts.length < 2) continue;
      for (const tip of [0, other.pts.length - 1]) {
        const [ox, oz] = other.pts[tip];
        if (Math.hypot(ox - x, oz - z) > reach) continue;
        if (Math.abs(other.h[tip] - h) < 2.8) return true;
      }
    }
  }
  return false;
}

/**
 * Lift higher-id decks over lower-id ones wherever they cross at a steep angle
 * and sit within a clearance of each other. Several rounds so A-over-B-over-C settles.
 */
function stackOrthogonalDecks(plan: Map<number, Planned>, at: Surfaces) {
  const ids = [...plan.keys()].sort((a, b) => a - b);
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (let ai = 0; ai < ids.length; ai++) {
      for (let bi = 0; bi < ai; bi++) {
        const hiId = ids[ai], loId = ids[bi];
        const hiDecks = plan.get(hiId)?.decks ?? [];
        const loDecks = plan.get(loId)?.decks ?? [];
        for (const hi of hiDecks) for (const lo of loDecks) {
          for (let a = 1; a < hi.pts.length; a++) for (let b = 1; b < lo.pts.length; b++) {
            const t = crossingMerc(hi.pts[a - 1], hi.pts[a], lo.pts[b - 1], lo.pts[b]);
            if (t == null) continue;
            const align = segmentAlign(
              { x: hi.pts[a - 1][0], y: hi.pts[a - 1][1] },
              { x: hi.pts[a][0], y: hi.pts[a][1] },
              { x: lo.pts[b - 1][0], y: lo.pts[b - 1][1] },
              { x: lo.pts[b][0], y: lo.pts[b][1] },
            );
            if (align > TANGENT_COS) continue;
            const x = hi.pts[a - 1][0] + (hi.pts[a][0] - hi.pts[a - 1][0]) * t;
            const z = hi.pts[a - 1][1] + (hi.pts[a][1] - hi.pts[a - 1][1]) * t;
            const hLo = sampleDecks([lo], x, z);
            const hHi = sampleDecks([hi], x, z);
            if (hLo == null || hHi == null) continue;
            const need = hLo + OVER_CLEAR;
            if (hHi >= need - 0.35) continue;
            const sHi = hi.s[a - 1] + (hi.s[a] - hi.s[a - 1]) * t;
            liftDeckClear(hi, sHi, need, at.toMerc);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
}

/** Lay a ribbon along the deck (the road or rail bed on it), piece by piece. */
function deckRibbon(builder: RoadBuilder, deck: Pick<Deck, 'pts' | 'h'>, half: number, y: number, rgb: [number, number, number], joints: number) {
  const saved = builder.groundAt;
  for (let i = 1; i < deck.pts.length; i++) {
    const [ax, az] = deck.pts[i - 1], [bx, bz] = deck.pts[i];
    const ha = deck.h[i - 1], hb = deck.h[i];
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1;
    builder.groundAt = (x, z) => ha + (hb - ha) * Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
    builder.segment(ax, az, bx, bz, half, y, rgb);
    // the join with the next piece: a wedge on the outer side of the bend, level with the
    // joint — a flat round disc there stuck up through the next (sloping) piece, a row of
    // scales along every ramp
    if (joints && i + 1 < deck.pts.length) {
      const [cx, cz] = deck.pts[i + 1];
      builder.groundAt = () => hb;
      builder.bevel(bx, bz, bx - ax, bz - az, cx - bx, cz - bz, half, y, rgb);
    }
  }
  builder.groundAt = saved;
}

/**
 * Stair towers at a footbridge's ends that hang in the air: a concrete box from the
 * ground up past the parapet. Ends cut by the tile border are not ends. `seen` keeps
 * one tower per spot where a bridge and its approach meet.
 * Skip when another deck continues nearby — otherwise the tower sits as a black
 * portal beside the real walkway (broken пешеходный переход join).
 */
function stairTowers(
  builder: RoadBuilder,
  deck: Deck,
  toMerc: number,
  span: number,
  seen: Set<string>,
  plan?: Map<number, Planned>,
) {
  const n = deck.pts.length;
  if (n < 2) return;
  const shade = (rgb: [number, number, number], f: number): [number, number, number] => [rgb[0] * f, rgb[1] * f, rgb[2] * f];
  const edge = 0.5 * toMerc;
  for (const [i, j] of [[0, 1], [n - 1, n - 2]]) {
    const [x, z] = deck.pts[i];
    if (x < edge || z < edge || x > span - edge || z > span - edge) continue;
    const h = deck.h[i], bed = deck.bed[i];
    if (h - bed < 2.2) continue;
    if (plan && deckContinuesNear(plan, deck, x, z, h, toMerc)) continue;
    const key = `${Math.round(x / toMerc)},${Math.round(z / toMerc)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // square, turned with the deck, centred a little past its end
    const [px, pz] = deck.pts[j];
    const len = Math.hypot(x - px, z - pz) || 1;
    const ux = (x - px) / len, uz = (z - pz) / len;   // outward along the deck
    const vx = -uz, vz = ux;
    const a = 1.5 * toMerc, cx = x + ux * a * 0.6, cz = z + uz * a * 0.6;
    const ring: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([p, q]) => [cx + ux * a * p + vx * a * q, cz + uz * a * p + vz * a * q]);
    const top = PARAPET + 0.35;
    for (let e = 0; e < 4; e++) {
      const [ax, az] = ring[e], [bx, bz] = ring[(e + 1) % 4];
      const ex = bx - ax, ez = bz - az, el = Math.hypot(ex, ez) || 1;
      const f = 0.7 + 0.2 * ((ez / el) * 0.6 + (-ex / el) * 0.8);
      builder.quad([[ax, az, bed, -1.5], [bx, bz, bed, -1.5], [bx, bz, h, top], [ax, az, h, top]], shade(CONCRETE, f * 0.95));
    }
    builder.quad([[ring[0][0], ring[0][1], h, top], [ring[1][0], ring[1][1], h, top], [ring[2][0], ring[2][1], h, top], [ring[3][0], ring[3][1], h, top]], PARAPET_TOP, 'up');
  }
}

/**
 * True when this deck span crosses another elevated ribbon at nearly the same
 * height (a coplanar junction). Parapets there would fence the crossing shut.
 */
function coplanarDeckCross(deck: Deck, a: number, plan: Map<number, Planned> | undefined, selfId: number) {
  if (!plan) return false;
  const [ax, az] = deck.pts[a - 1], [bx, bz] = deck.pts[a];
  const ha = deck.h[a - 1], hb = deck.h[a];
  for (const [id, planned] of plan) {
    if (id === selfId) continue;
    for (const other of planned.decks) {
      for (let b = 1; b < other.pts.length; b++) {
        const t = crossingMerc(deck.pts[a - 1], deck.pts[a], other.pts[b - 1], other.pts[b]);
        if (t == null) continue;
        const align = segmentAlign(
          { x: ax, y: az }, { x: bx, y: bz },
          { x: other.pts[b - 1][0], y: other.pts[b - 1][1] },
          { x: other.pts[b][0], y: other.pts[b][1] },
        );
        // only open parapets at steep crosses; tangential merges keep their walls
        if (align > TANGENT_COS) continue;
        const hHere = ha + (hb - ha) * t;
        const hThere = other.h[b - 1] + (other.h[b] - other.h[b - 1]) * (
          (() => {
            const [cx, cz] = other.pts[b - 1], [dx, dz] = other.pts[b];
            const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
            const len2 = (dx - cx) ** 2 + (dz - cz) ** 2 || 1;
            return Math.max(0, Math.min(1, ((px - cx) * (dx - cx) + (pz - cz) * (dz - cz)) / len2));
          })()
        );
        if (Math.abs(hHere - hThere) < 2.2) return true;
      }
    }
  }
  return false;
}

/**
 * The bridge itself where it stands clear of the ground: the slab's sides and
 * underside, a low parapet on each side and concrete piers down into the river.
 * Parapets open where another deck crosses coplanarly (steep angle).
 */
/**
 * How a deck's sides meet the world: `beside(i, sgn)` is the distance (mercator) to a
 * parallel deck on that side of piece i, or null; there the two slabs meet halfway in one
 * plate with no parapet between. `plate` lays the deck's top (rail decks: the ballast
 * ribbon does not cover it), `truss` raises a Warren truss on the free sides.
 */
type DeckSides = { beside?: (i: number, sgn: number) => number | null; plate?: [number, number, number]; truss?: boolean };

function deckStructure(builder: RoadBuilder, deck: Deck, half: number, toMerc: number, plan?: Map<number, Planned>, selfId = -1, sides: DeckSides = {}) {
  const n = deck.pts.length;
  const up = deck.h.map((h, i) => h - deck.bed[i] > 1.2);
  /** the half width on one side of piece i: out to the neighbour (a little past halfway) or the deck's own */
  const reach = (i: number, sgn: number) => {
    const d = sides.beside?.(i, sgn);
    return d == null ? null : d / 2 + 0.25 * toMerc;
  };
  const side = (nx: number, nz: number) => 0.7 + 0.2 * (nx * 0.6 + nz * 0.8);
  const shade = (rgb: [number, number, number], f: number): [number, number, number] => [rgb[0] * f, rgb[1] * f, rgb[2] * f];
  const wall = 0.3 * toMerc;
  for (let i = 1; i < n; i++) {
    if (!up[i - 1] && !up[i]) continue;
    const [ax, az] = deck.pts[i - 1], [bx, bz] = deck.pts[i];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    const ha = deck.h[i - 1], hb = deck.h[i];
    const open = coplanarDeckCross(deck, i, plan, selfId);
    const wide = [reach(i, -1), reach(i, 1)];
    for (const sgn of [-1, 1]) {
      // a neighbour on this side: one plate with it, no wall between
      if (wide[sgn < 0 ? 0 : 1] != null) continue;
      const ox = nx * half * sgn, oz = nz * half * sgn;
      const ix = nx * (half - wall) * sgn, iz = nz * (half - wall) * sgn;
      const f = side(nx * sgn, nz * sgn);
      if (open) {
        // slab edge only — leave the carriageway clear for the crossing road
        builder.quad([[ax + ox, az + oz, ha, -SLAB], [bx + ox, bz + oz, hb, -SLAB], [bx + ox, bz + oz, hb, 0.05], [ax + ox, az + oz, ha, 0.05]], shade(CONCRETE, f));
      } else {
        // outer face: from under the slab to the parapet top
        builder.quad([[ax + ox, az + oz, ha, -SLAB], [bx + ox, bz + oz, hb, -SLAB], [bx + ox, bz + oz, hb, PARAPET], [ax + ox, az + oz, ha, PARAPET]], shade(CONCRETE, f));
        // parapet top and inner face
        builder.quad([[ax + ox, az + oz, ha, PARAPET], [bx + ox, bz + oz, hb, PARAPET], [bx + ix, bz + iz, hb, PARAPET], [ax + ix, az + iz, ha, PARAPET]], PARAPET_TOP, 'up');
        builder.quad([[ax + ix, az + iz, ha, PARAPET], [bx + ix, bz + iz, hb, PARAPET], [bx + ix, bz + iz, hb, 0.05], [ax + ix, az + iz, ha, 0.05]], shade(CONCRETE, 1.05 - f * 0.25));
      }
    }
    // underside (and the top plate), out to a neighbour where there is one
    const hl = wide[0] ?? half, hr = wide[1] ?? half;
    builder.quad([[ax + nx * hr, az + nz * hr, ha, -SLAB], [bx + nx * hr, bz + nz * hr, hb, -SLAB], [bx - nx * hl, bz - nz * hl, hb, -SLAB], [ax - nx * hl, az - nz * hl, ha, -SLAB]], UNDERSIDE, 'down');
    if (sides.plate) builder.quad([[ax + nx * hr, az + nz * hr, ha, 0.04], [bx + nx * hr, bz + nz * hr, hb, 0.04], [bx - nx * hl, bz - nz * hl, hb, 0.04], [ax - nx * hl, az - nz * hl, ha, 0.04]], sides.plate, 'up');
  }
  if (sides.truss) deckTruss(builder, deck, half, toMerc, up, (i, sgn) => reach(i, sgn) != null || coplanarDeckCross(deck, i, plan, selfId));
  // piers, evenly spaced, none right at the ends
  const meters = deck.length / toMerc;
  if (meters < 16) return;
  const count = Math.max(2, Math.round(meters / PIER_GAP));
  for (let p = 1; p < count; p++) {
    const target = deck.length * p / count;
    let i = 1;
    while (i < n - 1 && deck.s[i] < target) i++;
    const t = (target - deck.s[i - 1]) / ((deck.s[i] - deck.s[i - 1]) || 1);
    const [ax, az] = deck.pts[i - 1], [bx, bz] = deck.pts[i];
    const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
    const h = deck.h[i - 1] + (deck.h[i] - deck.h[i - 1]) * t;
    const bed = Math.min(deck.bed[i - 1], deck.bed[i]);
    if (h - bed < 2.5) continue;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const ux = (bx - ax) / len, uz = (bz - az) / len; // along the bridge
    const vx = -uz, vz = ux;                           // across
    const along = 0.8 * toMerc, across = half * 0.8;
    const corner = (a: number, b: number): Pt => [cx + ux * along * a + vx * across * b, cz + uz * along * a + vz * across * b];
    const ring = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    for (let e = 0; e < 4; e++) {
      const [px, pz] = ring[e], [qx, qz] = ring[(e + 1) % 4];
      const ex = qx - px, ez = qz - pz, el = Math.hypot(ex, ez) || 1;
      const f = side(ez / el, -ex / el);
      builder.quad([[px, pz, bed, -1.5], [qx, qz, bed, -1.5], [qx, qz, h, -SLAB], [px, pz, h, -SLAB]], shade(CONCRETE, f * 0.92));
    }
  }
}

/** a road bridge's shoulder each side of the carriageway (m) */
const DECK_SHOULDER = 1.5;
/** a railway bridge's half width (m), and its deck plate */
const RAIL_DECK_HALF = 3.4;
const RAIL_PLATE = hex('#77736c');

/**
 * Distance (mercator) to the nearest piece of another line in `pieces` running alongside
 * a→b on side sgn: parallel, 2.5–8 m off, at about the same height. Null if none.
 */
function beside(
  pieces: { id: number; ax: number; az: number; bx: number; bz: number; h: number }[],
  self: number, ax: number, az: number, bx: number, bz: number, len: number, h: number, sgn: number, toMerc: number,
): number | null {
  const dx = (bx - ax) / len, dz = (bz - az) / len, nx = -dz, nz = dx;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  let best: number | null = null;
  for (const p of pieces) {
    if (p.id === self || Math.abs(p.h - h) > 1.5) continue;
    const ex = p.bx - p.ax, ez = p.bz - p.az, el = Math.hypot(ex, ez) || 1;
    if (Math.abs((ex * dx + ez * dz) / el) < 0.95) continue;
    const t = Math.max(0, Math.min(1, ((mx - p.ax) * ex + (mz - p.az) * ez) / (el * el)));
    const vx = p.ax + ex * t - mx, vz = p.az + ez * t - mz;
    const across = (vx * nx + vz * nz) * sgn;
    if (across < 2.5 * toMerc || across > 8 * toMerc) continue;
    // beside us, not ahead or behind
    if (Math.abs(vx * dx + vz * dz) > across) continue;
    if (best == null || across < best) best = across;
  }
  return best;
}

/** Warren truss: panel length and height (m), member width (m) */
const TRUSS_PANEL = 5, TRUSS_H = 5, TRUSS_W = 0.32;
const TRUSS = hex('#5b6066');

/**
 * A railway bridge's Warren truss along both free sides: diagonals up and down in a row
 * of triangles (/\/\/\) under a top chord, where the deck stands over the ground.
 * Flat walls (both faces), a few dozen triangles a panel pair.
 */
function deckTruss(builder: RoadBuilder, deck: Deck, half: number, toMerc: number, up: boolean[], skip: (i: number, sgn: number) => boolean) {
  const n = deck.pts.length;
  if (deck.length / toMerc < 12) return;
  /** piece index, point and height at arc length s */
  const at = (s: number) => {
    let i = 1;
    while (i < n - 1 && deck.s[i] < s) i++;
    const t = Math.max(0, Math.min(1, (s - deck.s[i - 1]) / ((deck.s[i] - deck.s[i - 1]) || 1)));
    const [ax, az] = deck.pts[i - 1], [bx, bz] = deck.pts[i];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    return { i, x: ax + (bx - ax) * t, z: az + (bz - az) * t, h: deck.h[i - 1] + (deck.h[i] - deck.h[i - 1]) * t, nx: -(bz - az) / len, nz: (bx - ax) / len };
  };
  const panel = TRUSS_PANEL * toMerc, w = TRUSS_W * toMerc;
  const count = Math.max(1, Math.round(deck.length / panel));
  const step = deck.length / count;
  /** a member: a flat strip from (s0, y0) to (s1, y1) on side sgn, `w` wide along the deck */
  const member = (s0: number, y0: number, s1: number, y1: number, sgn: number) => {
    const a = at(s0), b = at(s1);
    const ax = a.x + a.nx * half * sgn, az = a.z + a.nz * half * sgn, bx = b.x + b.nx * half * sgn, bz = b.z + b.nz * half * sgn;
    // all four corners on the line a→b: a true vertical wall even where the deck curves
    const l = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / l * w / 2, uz = (bz - az) / l * w / 2;
    builder.quad([[ax - ux, az - uz, a.h, y0], [ax + ux, az + uz, a.h, y0], [bx + ux, bz + uz, b.h, y1], [bx - ux, bz - uz, b.h, y1]], TRUSS);
  };
  /** a horizontal band from s0 to s1 between heights lo and hi, following the deck */
  const band = (s0: number, s1: number, lo: number, hi: number, sgn: number) => {
    const pieces = Math.max(1, Math.ceil((s1 - s0) / (2 * toMerc)));
    for (let k = 0; k < pieces; k++) {
      const a = at(s0 + (s1 - s0) * k / pieces), b = at(s0 + (s1 - s0) * (k + 1) / pieces);
      const ax = a.x + a.nx * half * sgn, az = a.z + a.nz * half * sgn, bx = b.x + b.nx * half * sgn, bz = b.z + b.nz * half * sgn;
      builder.quad([[ax, az, a.h, lo], [bx, bz, b.h, lo], [bx, bz, b.h, hi], [ax, az, a.h, hi]], TRUSS);
    }
  };
  const bottom = PARAPET - 0.1, top = TRUSS_H;
  for (const sgn of [-1, 1]) {
    for (let p = 0; p < count; p++) {
      const s0 = p * step, s1 = s0 + step / 2, s2 = s0 + step;
      const mid = at(s1);
      // only over open air, and not where a neighbour or a crossing road shares the side
      if (!up[mid.i - 1] && !up[mid.i]) continue;
      if (skip(mid.i, sgn)) continue;
      member(s0, bottom, s1, top, sgn);
      member(s1, top, s2, bottom, sgn);
      // the top chord from this apex to the next: a band along the deck
      if (p + 1 < count && !skip(at(s2).i, sgn)) band(s1, s1 + step, top - 0.35, top, sgn);
    }
  }
}

/** Register a deck for the car, piece by piece. */
function pushDeck(bridges: number[], deck: Deck, half: number) {
  for (let i = 1; i < deck.pts.length; i++) {
    bridges.push(deck.pts[i - 1][0], deck.pts[i - 1][1], deck.pts[i][0], deck.pts[i][1], half, deck.h[i - 1], deck.h[i]);
  }
}

/** A railway or tram line, or null for anything else. */
function railKind(p: Record<string, unknown>): { tram: boolean; gauge: number; wired: boolean } | null {
  const sub = String(p.subclass ?? '');
  const tram = p.class === 'transit' && sub === 'tram';
  const rail = (p.class === 'rail' || p.class === 'transit') && /^(rail|narrow_gauge|light_rail|preserved|subway|funicular)$/.test(sub);
  if (!tram && !rail) return null;
  // the tiles carry no `electrified` tag: main lines and light rail get the overhead line
  return { tram, gauge: sub === 'narrow_gauge' || sub === 'funicular' ? 0.5 : 0.72, wired: sub === 'rail' || sub === 'light_rail' };
}

/**
 * Railway track: a pale shoulder, a darker ballast bed, sparse sleepers and two rails
 * (dark foot, bright head); trams get the rails only, in a dark groove in the street.
 * Everything goes into the one road mesh — more flat triangles, no extra draw calls.
 */
function railTracks(builder: RoadBuilder, layer: VectorTile['layers'][string], k: number, at: Surfaces, bridges: number[], ways: Map<number, Way>, plan: Map<number, Planned>) {
  const toMerc = at.toMerc, groundAt = at.driveAt;
  const shoulder = hex('#8b847a');
  const ballast = hex('#6c665f');
  const sleeper = hex('#4a3d33');
  const foot = hex('#34373b');
  const head = hex('#b4bac0');
  const groove = hex('#26282b');
  /** sleeper pitch (m): sparse on purpose — reads as a track from the car, costs little */
  const SLEEPER_STEP = 1.15;
  // overhead line: masts with a cantilever, a contact wire and a catenary above it
  const mast = hex('#6d7378');
  const wire = hex('#2a2d30');
  const MAST_STEP = 55, MAST_OFF = 2.5, MAST_H = 6.6, CONTACT_Y = 5.6, CATENARY_Y = 6.3;
  /** a mast beside the track at (x, z), its arm reaching over the track centre */
  const overheadMast = (x: number, z: number, nx: number, nz: number, dx: number, dz: number) => {
    const g = (px: number, pz: number) => builder.groundAt(px, pz);
    const mx = x + nx * MAST_OFF * toMerc, mz = z + nz * MAST_OFF * toMerc;
    const w = 0.09 * toMerc;
    // two crossed walls make a post that reads from every side (both faces drawn)
    for (const [ux, uz] of [[nx, nz], [dx, dz]]) {
      const ax = mx - ux * w, az = mz - uz * w, bx = mx + ux * w, bz = mz + uz * w;
      builder.quad([[ax, az, g(ax, az), 0], [bx, bz, g(bx, bz), 0], [bx, bz, g(bx, bz), MAST_H], [ax, az, g(ax, az), MAST_H]], mast);
    }
    // the cantilever: a thin wall from the mast out over the track, from catenary down to contact height
    const ex = x - nx * 0.3 * toMerc, ez = z - nz * 0.3 * toMerc;
    builder.quad([[mx, mz, g(mx, mz), CONTACT_Y - 0.05], [ex, ez, g(ex, ez), CONTACT_Y - 0.05], [ex, ez, g(ex, ez), CATENARY_Y + 0.05], [mx, mz, g(mx, mz), CATENARY_Y + 0.05]], mast);
  };
  // the two rails of a piece: wide dark foot (or tram groove) under a thin bright head
  const railPair = (lay: (ox: number, oz: number, half: number, y: number, rgb: [number, number, number]) => void, nx: number, nz: number, gauge: number, tram: boolean) => {
    for (const side of [-1, 1]) {
      const ox = nx * gauge * side, oz = nz * gauge * side;
      lay(ox, oz, (tram ? 0.07 : 0.06) * toMerc, tram ? 0.185 : 0.1, tram ? groove : foot);
      lay(ox, oz, 0.025 * toMerc, tram ? 0.19 : 0.115, head);
    }
  };
  // every railway deck piece in the tile, to find the tracks that run side by side
  const railDecks: { id: number; ax: number; az: number; bx: number; bz: number; h: number }[] = [];
  for (const [i] of ways) {
    const kind = railKind(layer.feature(i).properties);
    if (!kind || kind.tram) continue;
    for (const deck of plan.get(i)?.decks ?? []) for (let n = 1; n < deck.pts.length; n++) {
      railDecks.push({ id: i, ax: deck.pts[n - 1][0], az: deck.pts[n - 1][1], bx: deck.pts[n][0], bz: deck.pts[n][1], h: (deck.h[n - 1] + deck.h[n]) / 2 });
    }
  }
  /** the nearest railway deck running alongside piece n of `deck` on side sgn (mercator), or null */
  const besideDeck = (deck: Deck, self: number) => (n: number, sgn: number) => {
    const [ax, az] = deck.pts[n - 1], [bx, bz] = deck.pts[n];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    return beside(railDecks, self, ax, az, bx, bz, len, (deck.h[n - 1] + deck.h[n]) / 2, sgn, toMerc);
  };
  // the tracks on the ground, in 16 m cells: a yard's parallel tracks get one ballast field
  type Piece = { id: number; ax: number; az: number; bx: number; bz: number; h: number };
  const CELL = 16 * toMerc;
  const cells = new Map<string, Piece[]>();
  for (const [i, way] of ways) {
    const kind = railKind(layer.feature(i).properties);
    if (!kind || kind.tram) continue;
    for (const line of plan.get(i)?.rest ?? way.lines) for (let j = 0; j + 1 < line.length; j++) {
      const cut = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, layer.extent);
      if (!cut) continue;
      const piece: Piece = { id: i, ax: cut[0] * k, az: cut[1] * k, bx: cut[2] * k, bz: cut[3] * k, h: 0 };
      piece.h = groundAt((piece.ax + piece.bx) / 2, (piece.az + piece.bz) / 2);
      // in every cell its box touches
      const x0 = Math.floor(Math.min(piece.ax, piece.bx) / CELL), x1 = Math.floor(Math.max(piece.ax, piece.bx) / CELL);
      const z0 = Math.floor(Math.min(piece.az, piece.bz) / CELL), z1 = Math.floor(Math.max(piece.az, piece.bz) / CELL);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const key = cx + ',' + cz;
        const list = cells.get(key);
        if (list) list.push(piece); else cells.set(key, [piece]);
      }
    }
  }
  /** pieces near (x, z): its cell and the eight round it */
  const nearPieces = (x: number, z: number) => {
    const out = new Set<Piece>();
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const p of cells.get((cx + a) + ',' + (cz + b)) ?? []) out.add(p);
    return [...out];
  };
  /**
   * How far the next track runs alongside a→b on side sgn — all along it (near both ends
   * and the middle), so a track merely crossing or touching nearby does not count.
   */
  const alongside = (self: number, ax: number, az: number, bx: number, bz: number, len: number, sgn: number) => {
    const ux = (bx - ax) / len, uz = (bz - az) / len, bit = 0.5 * toMerc;
    let far = 0;
    for (const t of [0.15, 0.5, 0.85]) {
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      const d = beside(nearPieces(px, pz), self, px - ux * bit, pz - uz * bit, px + ux * bit, pz + uz * bit, 2 * bit, groundAt(px, pz), sgn, toMerc);
      if (d == null) return null;
      far = Math.max(far, d);
    }
    return far;
  };
  for (const [i, way] of ways) {
    const kind = railKind(layer.feature(i).properties);
    if (!kind) continue;
    const { tram } = kind;
    const gauge = kind.gauge * toMerc;
    const planned = plan.get(i);
    for (const deck of planned?.decks ?? []) {
      // a railway bridge is wider than its track (walkways, cable runs) and carries a truss;
      // tracks side by side share one plate
      const half = (tram ? 2.1 : RAIL_DECK_HALF) * toMerc;
      deckStructure(builder, deck, half, toMerc, plan, i, tram ? {} : { beside: besideDeck(deck, i), plate: RAIL_PLATE, truss: true });
      pushDeck(bridges, deck, half);
      if (!tram) deckRibbon(builder, deck, 1.6 * toMerc, 0.06, ballast, 0);
      for (let n = 1; n < deck.pts.length; n++) {
        const [ax, az] = deck.pts[n - 1], [bx, bz] = deck.pts[n];
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const nx = -(bz - az) / len, nz = (bx - ax) / len;
        railPair((ox, oz, w, y, rgb) => deckRibbon(builder, { pts: [[ax + ox, az + oz], [bx + ox, bz + oz]], h: [deck.h[n - 1], deck.h[n]] }, w, y, rgb, 0), nx, nz, gauge, tram);
      }
      if (kind.wired) {
        deckRibbon(builder, deck, 0.03 * toMerc, CONTACT_Y, wire, 0);
        deckRibbon(builder, deck, 0.03 * toMerc, CATENARY_Y, wire, 0);
      }
    }
    for (const line of planned?.rest ?? way.lines) {
      // distance to the next sleeper, carried across the line's pieces so the pitch stays even
      let toSleeper = SLEEPER_STEP * 0.5;
      let toMast = MAST_STEP * 0.5;
      for (let j = 0; j + 1 < line.length; j++) {
        const cut = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, layer.extent);
        if (!cut) continue;
        const [ax, az, bx, bz] = [cut[0] * k, cut[1] * k, cut[2] * k, cut[3] * k];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-9) continue;
        builder.groundAt = groundAt;
        const nx = -(bz - az) / len, nz = (bx - ax) / len;
        if (!tram) {
          builder.segment(ax, az, bx, bz, 1.65 * toMerc, 0.05, shoulder);
          builder.segment(ax, az, bx, bz, 1.2 * toMerc, 0.06, ballast);
          if (j > 0) {
            builder.disc(ax, az, 1.65 * toMerc, 0.05, shoulder, 6);
            builder.disc(ax, az, 1.2 * toMerc, 0.06, ballast, 6);
          }
          // a track running alongside for this whole piece: ballast across the gap too, so
          // a yard reads as one field of tracks, not strips with ground between
          if (len > 6 * toMerc) for (const sgn of [-1, 1]) {
            const d = alongside(i, ax, az, bx, bz, len, sgn);
            if (d == null) continue;
            const ox = nx * sgn * d / 2, oz = nz * sgn * d / 2;
            builder.segment(ax + ox, az + oz, bx + ox, bz + oz, d / 2 + 0.2 * toMerc, 0.055, ballast);
          }
          // sleepers across the bed, a little wider than the gauge
          const lenM = len / toMerc, reach = (kind.gauge + 0.45) * toMerc;
          for (let s = toSleeper; s < lenM; s += SLEEPER_STEP) {
            const cx = ax + (bx - ax) * s / lenM, cz = az + (bz - az) * s / lenM;
            builder.segment(cx - nx * reach, cz - nz * reach, cx + nx * reach, cz + nz * reach, 0.11 * toMerc, 0.08, sleeper);
          }
          toSleeper = ((toSleeper - lenM) % SLEEPER_STEP + SLEEPER_STEP) % SLEEPER_STEP;
          if (kind.wired) {
            builder.segment(ax, az, bx, bz, 0.03 * toMerc, CONTACT_Y, wire);
            builder.segment(ax, az, bx, bz, 0.03 * toMerc, CATENARY_Y, wire);
            const dx = (bx - ax) / len, dz = (bz - az) / len;
            for (let s = toMast; s < lenM; s += MAST_STEP) {
              overheadMast(ax + (bx - ax) * s / lenM, az + (bz - az) * s / lenM, nx, nz, dx, dz);
            }
            toMast = ((toMast - lenM) % MAST_STEP + MAST_STEP) % MAST_STEP;
          }
        }
        railPair((ox, oz, w, y, rgb) => builder.segment(ax + ox, az + oz, bx + ox, bz + oz, w, y, rgb), nx, nz, gauge, tram);
      }
    }
    builder.groundAt = groundAt;
  }
}

/** how far either side of a hedge's line its lawn reaches (m), and a hedge section's half length */
const LAWN_HALF = 1.05, HEDGE_HALF = 3.6;

/**
 * The lawn under hedges: a green strip under each section that has another next to it
 * (a run of hedge stands in a planted verge; a lone bush just stands on the ground).
 * Segments as x0, z0, x1, z1 in tile units.
 */
function hedgeLawns(plants: { x: number; z: number; species: string; yaw: number }[], toMerc: number): number[] {
  const hedges = plants.filter((p) => p.species === 'hedge');
  const cell = 8 * toMerc, reach = 7.5 * toMerc;
  const cells = new Map<string, typeof hedges>();
  for (const h of hedges) {
    const key = Math.floor(h.x / cell) + ',' + Math.floor(h.z / cell);
    const list = cells.get(key);
    if (list) list.push(h); else cells.set(key, [h]);
  }
  const out: number[] = [];
  for (const h of hedges) {
    const cx = Math.floor(h.x / cell), cz = Math.floor(h.z / cell);
    let paired = false;
    for (let a = -1; a <= 1 && !paired; a++) for (let b = -1; b <= 1 && !paired; b++) {
      for (const o of cells.get((cx + a) + ',' + (cz + b)) ?? []) if (o !== h && Math.hypot(o.x - h.x, o.z - h.z) < reach) { paired = true; break; }
    }
    if (!paired) continue;
    // +X of the hedge model lies along the street: (cos yaw, -sin yaw) in tile x/z
    const dx = Math.cos(h.yaw) * HEDGE_HALF * toMerc, dz = -Math.sin(h.yaw) * HEDGE_HALF * toMerc;
    out.push(h.x - dx, h.z - dz, h.x + dx, h.z + dz);
  }
  return out;
}

/** the share of a tile round ours whose neighbour roads go into the bridge plan */
const CONTEXT_MARGIN = 0.25;

/** The neighbours' roads and railways in our tile frame: cut to their own squares and to a band round ours. */
function neighbourWays(neighbours: { dx: number; dy: number; vt: VectorTile }[], extent: number): Map<number, Way> {
  const out = new Map<number, Way>();
  const m = extent * CONTEXT_MARGIN;
  neighbours.forEach(({ dx, dy, vt }, n) => {
    const layer = vt.layers.transportation;
    if (!layer) return;
    const scale = extent / layer.extent;
    for (const [i, way] of transportWays(layer)) {
      const lines = way.lines
        .flatMap((line) => clipLineBox(line, 0, 0, layer.extent, layer.extent))
        .map((line) => line.map((p) => ({ x: (p.x + dx * layer.extent) * scale, y: (p.y + dy * layer.extent) * scale })))
        .flatMap((line) => clipLineBox(line, -m, -m, extent + m, extent + m));
      if (!lines.length) continue;
      const p = layer.feature(i).properties;
      const style = roadStyle(String(p.class ?? ''), String(p.subclass ?? ''), Number(p.ramp) === 1);
      const half = style ? style.width / 2 + 0.18 + (style.width < 1.5 ? 0.35 : DECK_SHOULDER) : railKind(p)?.tram ? 2.1 : RAIL_DECK_HALF;
      out.set(1e7 * (n + 1) + i, { ...way, lines, half });
    }
  });
  return out;
}

function roadMesh(vt: VectorTile, span: number, grid: number, at: Surfaces, bridges: number[], pitchLines: number[] = [], lawns: number[] = [], neighbours: { dx: number; dy: number; vt: VectorTile }[] = []): MeshData {
  const towerSpots = new Set<string>();
  const { driveAt, groundAt: bedAt } = at;
  const builder = new RoadBuilder(driveAt, span / grid, grid);
  // white pitch markings, painted on the ground under the roads' ribbons
  const chalk = hex('#f4f4ee');
  for (let i = 0; i < pitchLines.length; i += 5) builder.segment(pitchLines[i], pitchLines[i + 1], pitchLines[i + 2], pitchLines[i + 3], 0.06 * at.toMerc, 0.04, chalk);
  // the lawn under hedges, under the roads (a ribbon over the ground, below every road)
  const lawn = hex('#a9cf92');
  for (let i = 0; i < lawns.length; i += 4) builder.segment(lawns[i], lawns[i + 1], lawns[i + 2], lawns[i + 3], LAWN_HALF * at.toMerc, 0.03, lawn);
  const layer = vt.layers.transportation;
  if (layer) {
    const k = span / layer.extent;
    const toMerc = at.toMerc;
    const ways = transportWays(layer);
    // points another line runs through (not ends): a road ending there meets it side-on (a T),
    // and a round cap there would stick out past a narrower crossing road as an "ear"
    const through = new Set<string>();
    for (const way of ways.values()) for (const line of way.lines) for (let n = 1; n + 1 < line.length; n++) through.add(line[n].x + ',' + line[n].y);
    // bridges, overpasses and their ramps, worked out once for rails and both road passes
    const extra = neighbours.length ? neighbourWays(neighbours, layer.extent) : undefined;
    const plan = planBridges(ways, layer.extent, span, at, extra);
    // a neighbour's deck that reaches our edge: not drawn here (its tile draws it), but the
    // car on our side of the edge drives on it
    if (extra) for (const [id, planned] of plan) {
      const half = extra.get(id)?.half;
      if (half != null) for (const deck of planned.decks) pushDeck(bridges, deck, half * toMerc);
    }
    railTracks(builder, layer, k, at, bridges, ways, plan);
    // the drawn roads round their corners (the plan's lines stay as they are for the rest)
    const drawn = roundedRoadLines(ways, plan, toMerc / k);
    // casings first (lower), then fills, each a flat ribbon slightly above ground
    for (const pass of ['casing', 'fill'] as const) {
      for (const [i, way] of ways) {
        const p = layer.feature(i).properties;
        const style = roadStyle(String(p.class ?? ''), String(p.subclass ?? ''), Number(p.ramp) === 1);
        if (!style) continue;
        const half = (style.width / 2 + (pass === 'casing' ? 0.18 : 0)) * toMerc;
        const y = style.lift + (pass === 'fill' ? 0.04 : 0);
        const rgb = hex(pass === 'fill' ? style.fill : style.casing);
        // Round joins only where the line actually bends (or ends); straight runs
        // and gentle curves need none. Narrow paths get cheaper discs.
        const steps = style.width < 2 ? 6 : 8;
        const planned = plan.get(i);
        // a road bridge has a shoulder each side, out to the parapets: room to drive on it
        // without dropping off (footbridges keep a narrow edge)
        const edge = (style.width / 2 + 0.18 + (style.width < 1.5 ? 0.35 : DECK_SHOULDER)) * toMerc;
        for (const deck of planned?.decks ?? []) {
          if (pass === 'casing') {
            // the parapets stand just outside the shoulders, on a concrete edge
            deckStructure(builder, deck, edge, toMerc, plan, i);
            // footbridges: stair towers where an end hangs in the air
            if (style.width < 1.5) stairTowers(builder, deck, toMerc, span, towerSpots, plan);
            // the shoulders out to the parapets in the carriageway's own asphalt (one surface,
            // the casing reads as the edge line); round joins as smooth as the road's
            deckRibbon(builder, deck, edge, y - 0.01, hex(style.fill), steps);
          } else pushDeck(bridges, deck, edge);
          deckRibbon(builder, deck, half, y, rgb, steps);
        }
        // footpaths on the ground: the fill alone — a casing round a path a metre wide
        // was a second ribbon (and a fifth of the road triangles) for a hairline edge
        if (pass === 'casing' && style.width < 1.5) continue;
        for (const line of drawn.get(i) ?? planned?.rest ?? way.lines) {
          for (let j = 0; j + 1 < line.length; j++) {
            const c = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, layer.extent);
            if (!c) continue;
            const [ax, az, bx, bz] = [c[0] * k, c[1] * k, c[2] * k, c[3] * k];
            const ha = driveAt(ax, az), hb = driveAt(bx, bz);
            // ribbon always follows the drive surface — no per-span artificial decks
            // (those floated as disconnected sticks at mismatched heights)
            builder.groundAt = driveAt;
            if (pass === 'fill') {
              const midX = (ax + bx) / 2, midZ = (az + bz) / 2;
              // causeway / water shelf: register a deck so the car doesn't fall into the bath
              if (driveAt(midX, midZ) - bedAt(midX, midZ) > 0.05) {
                bridges.push(ax, az, bx, bz, half, ha, hb);
              }
            }
            builder.segment(ax, az, bx, bz, half, y, rgb);
            const startsHere = c[0] === line[j].x && c[1] === line[j].y;
            if (!startsHere) continue;
            if (j === 0) {
              if (!through.has(line[0].x + ',' + line[0].y)) builder.disc(ax, az, half, y, rgb, steps);
              continue;
            }
            const prev = line[j - 1], q = line[j], r = line[j + 1];
            const ux = q.x - prev.x, uy = q.y - prev.y, vx = r.x - q.x, vy = r.y - q.y;
            const cos = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
            // round join for anything but a near-straight run — bevel alone left slits at bends
            if (cos < 0.985) builder.disc(ax, az, half, y, rgb, steps);
            else if (cos < 0.99999) builder.bevel(ax, az, ux, uy, vx, vy, half, y, rgb);
          }
          const last = line.length - 1;
          if (last > 0) {
            const e = line[last];
            if (e.x >= 0 && e.y >= 0 && e.x <= layer.extent && e.y <= layer.extent && !through.has(e.x + ',' + e.y)) builder.disc(e.x * k, e.y * k, half, y, rgb, steps);
          }
        }
        builder.groundAt = driveAt;
      }
    }
    laneMarkings(builder, layer, ways, drawn, plan, k, toMerc, driveAt);
    zebraCrossings(builder, layer, ways, k, toMerc, driveAt);
  }
  return meshOf(builder);
}

/**
 * Road lines with their corners rounded for drawing: every bend sharper than ~12° is cut
 * by up to 8 m (a third of the shorter arm) on each side and filled with a short arc.
 * Points other lines share (junctions, joins) stay put, so roads still meet.
 * `unitsPerMeter`: tile units in a metre.
 */
function roundedRoadLines(ways: Map<number, Way>, plan: Map<number, Planned>, unitsPerMeter: number) {
  const uses = new Map<string, number>();
  const note = (q: XY) => { const key = q.x + ',' + q.y; uses.set(key, (uses.get(key) ?? 0) + 1); };
  for (const way of ways.values()) for (const line of way.lines) for (const q of line) note(q);
  const fixed = (q: XY) => (uses.get(q.x + ',' + q.y) ?? 0) > 1;
  const cutMax = 8 * unitsPerMeter;
  const out = new Map<number, XY[][]>();
  for (const [i, way] of ways) {
    if (way.foot) continue;
    const lines = plan.get(i)?.rest ?? way.lines;
    out.set(i, lines.map((line) => {
      if (line.length < 3) return line;
      const result: XY[] = [line[0]];
      for (let n = 1; n + 1 < line.length; n++) {
        const p = line[n - 1], q = line[n], r = line[n + 1];
        const ux = q.x - p.x, uy = q.y - p.y, vx = r.x - q.x, vy = r.y - q.y;
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        const cos = lu && lv ? (ux * vx + uy * vy) / (lu * lv) : 1;
        if (fixed(q) || cos > 0.978 || !lu || !lv) { result.push(q); continue; }
        // cut back along both arms and run a quadratic arc through the corner
        const cut = Math.min(cutMax, lu / 3, lv / 3);
        const a = { x: q.x - ux / lu * cut, y: q.y - uy / lu * cut };
        const b = { x: q.x + vx / lv * cut, y: q.y + vy / lv * cut };
        const steps = cos < 0.5 ? 5 : 3;
        for (let t = 0; t <= steps; t++) {
          const f = t / steps, g = 1 - f;
          result.push({ x: g * g * a.x + 2 * g * f * q.x + f * f * b.x, y: g * g * a.y + 2 * g * f * q.y + f * f * b.y });
        }
      }
      result.push(line[line.length - 1]);
      return result;
    }));
  }
  return out;
}

/**
 * Painted lines on the asphalt, by the kind of road: a motorway a dashed lane line and solid
 * edges, a trunk or primary road a solid centre line and edges, secondary / tertiary a dashed
 * centre line, a minor street a sparse thin dash. Lanes, tracks, ramps, paths and bridge decks
 * stay plain; the paint stops 7 m short of a junction so lines do not cross it. Flat strips
 * in the one road mesh — no extra draw calls.
 */
function laneMarkings(builder: RoadBuilder, layer: VectorTile['layers'][string], ways: Map<number, Way>, drawn: Map<number, XY[][]>, plan: Map<number, Planned>, k: number, toMerc: number, driveAt: (x: number, z: number) => number) {
  // junctions: points where three or more arms of drivable roads meet
  const arms = new Map<string, number>();
  for (const [i, way] of ways) {
    if (way.foot) continue;
    const p = layer.feature(i).properties;
    if (!roadStyle(String(p.class ?? ''), String(p.subclass ?? ''), Number(p.ramp) === 1)) continue;
    for (const line of way.lines) {
      for (let n = 0; n < line.length; n++) {
        const key = line[n].x + ',' + line[n].y;
        arms.set(key, (arms.get(key) ?? 0) + (n === 0 || n === line.length - 1 ? 1 : 2));
      }
    }
  }
  // junctions in a grid of clearR cells: a lookup touches the 3×3 cells round the point
  const clearR = 7 * toMerc;
  const cells = new Map<string, { x: number; z: number }[]>();
  for (const [key, count] of arms) {
    if (count < 3) continue;
    const [x, y] = key.split(',').map(Number);
    const j = { x: x * k, z: y * k };
    const cell = `${Math.floor(j.x / clearR)},${Math.floor(j.z / clearR)}`;
    const list = cells.get(cell);
    if (list) list.push(j); else cells.set(cell, [j]);
  }
  const nearJunction = (x: number, z: number) => {
    const cx = Math.floor(x / clearR), cz = Math.floor(z / clearR);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of cells.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(j.x - x, j.z - z) < clearR) return true;
    }
    return false;
  };
  const paint = hex('#e8e6dc');
  builder.groundAt = driveAt;
  for (const [i, way] of ways) {
    if (way.foot || way.bridge) continue;
    const p = layer.feature(i).properties;
    const cls = String(p.class ?? '');
    if (Number(p.ramp) === 1 || p.brunnel === 'tunnel') continue;
    const style = roadStyle(cls, String(p.subclass ?? ''), false);
    if (!style) continue;
    // centre: [half width, dash, gap] (gap 0 = solid); edges solid on the big roads
    const motorway = cls === 'motorway';
    const main = cls === 'trunk' || cls === 'primary';
    const centre: [number, number, number] | null = motorway ? [0.07, 3, 6]
      : main ? [0.07, 1, 0]
        : cls === 'secondary' || cls === 'tertiary' ? [0.065, 3, 5]
          : cls === 'minor' ? [0.05, 2, 6] : null;
    if (!centre) continue;
    const edge = motorway || main ? style.width / 2 - 0.35 : null;
    const y = style.lift + 0.05;
    for (const line of drawn.get(i) ?? plan.get(i)?.rest ?? way.lines) {
      let phase = 0; // metres into the dash pattern, carried along the line
      for (let j = 0; j + 1 < line.length; j++) {
        const c = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, layer.extent);
        if (!c) continue;
        const [ax, az, bx, bz] = [c[0] * k, c[1] * k, c[2] * k, c[3] * k];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-9) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len, nx = -uz, nz = ux;
        const lenM = len / toMerc;
        // the paint in pieces of ≤ 3 m so each can stop short of a junction
        const [half, dash, gap] = centre;
        const period = dash + gap;
        let s = 0;
        while (s < lenM) {
          let e: number, on: boolean;
          if (!gap) { e = Math.min(lenM, s + 3); on = true; }
          else {
            const at = (phase + s) % period;
            on = at < dash;
            e = Math.min(lenM, s + (on ? dash - at : period - at));
          }
          if (on && e - s > 0.2) {
            const sx = ax + ux * s * toMerc, sz = az + uz * s * toMerc;
            const ex = ax + ux * e * toMerc, ez = az + uz * e * toMerc;
            if (!nearJunction((sx + ex) / 2, (sz + ez) / 2)) {
              builder.segment(sx, sz, ex, ez, half * toMerc, y, paint);
              if (edge) {
                for (const side of [-1, 1]) {
                  const ox = nx * edge * side * toMerc, oz = nz * edge * side * toMerc;
                  // edges are solid: under a dashed centre line they fill the gaps too
                  builder.segment(sx + ox, sz + oz, ex + ox, ez + oz, 0.06 * toMerc, y, paint);
                }
              }
            }
          }
          if (!on && edge && e - s > 0.2) {
            const sx = ax + ux * s * toMerc, sz = az + uz * s * toMerc;
            const ex = ax + ux * e * toMerc, ez = az + uz * e * toMerc;
            if (!nearJunction((sx + ex) / 2, (sz + ez) / 2)) {
              for (const side of [-1, 1]) {
                const ox = nx * edge * side * toMerc, oz = nz * edge * side * toMerc;
                builder.segment(sx + ox, sz + oz, ex + ox, ez + oz, 0.06 * toMerc, y, paint);
              }
            }
          }
          s = e;
        }
        phase = (phase + lenM) % (period || 1);
      }
    }
  }
}

/** streets that get zebra crossings at their junctions (not motorways, not lanes and tracks) */
const ZEBRA_CLASSES = /^(primary|secondary|tertiary|minor)$/;

/**
 * Zebra crossings. The map data has no crossings at this zoom, so they go where a city
 * has them: on every arm of a junction of ordinary streets, just before the junction
 * (clear of the crossing road). White stripes along the road, a metre apart, painted
 * a hair above the asphalt.
 */
function zebraCrossings(builder: RoadBuilder, layer: VectorTile['layers'][string], ways: Map<number, Way>, k: number, toMerc: number, driveAt: (x: number, z: number) => number) {
  type Arm = { x: number; y: number; dx: number; dy: number; len: number; half: number; lift: number };
  const nodes = new Map<string, Arm[]>();
  for (const [i, way] of ways) {
    if (way.bridge || way.foot) continue;
    const p = layer.feature(i).properties;
    const cls = String(p.class ?? '');
    if (!ZEBRA_CLASSES.test(cls) || p.brunnel === 'tunnel') continue;
    const style = roadStyle(cls, String(p.subclass ?? ''), Number(p.ramp) === 1);
    if (!style) continue;
    for (const line of way.lines) for (let n = 0; n < line.length; n++) {
      const q = line[n];
      if (q.x < 0 || q.y < 0 || q.x > layer.extent || q.y > layer.extent) continue;
      const key = q.x + ',' + q.y;
      const list = nodes.get(key) ?? [];
      // the arms leaving this point: back along the line and on along it
      for (const o of [line[n - 1], line[n + 1]]) {
        if (!o) continue;
        const dx = o.x - q.x, dy = o.y - q.y, len = Math.hypot(dx, dy);
        if (len > 0) list.push({ x: q.x, y: q.y, dx: dx / len, dy: dy / len, len: len * k, half: style.width / 2, lift: style.lift });
      }
      nodes.set(key, list);
    }
  }
  const white = hex('#f2f1ea');
  const stripe = 0.25 * toMerc, run = 1.5 * toMerc;
  for (const arms of nodes.values()) {
    if (arms.length < 3) continue; // a bend or a plain joint, no junction
    const widest = Math.max(...arms.map((a) => a.half));
    for (const arm of arms) {
      // past the crossing road's edge, with a step of kerb
      const back = (widest + 2.6) * toMerc;
      if (arm.len < back + run * 1.5) continue; // too short an arm to fit one
      const cx = arm.x * k + arm.dx * back, cz = arm.y * k + arm.dy * back;
      const px = -arm.dy, pz = arm.dx; // across the road
      const across = arm.half * 2 * 0.86;
      const count = Math.max(2, Math.floor(across / 1.0));
      builder.groundAt = driveAt;
      for (let s = 0; s < count; s++) {
        const off = (s - (count - 1) / 2) * 1.0 * toMerc;
        const sx = cx + px * off, sz = cz + pz * off;
        builder.segment(sx - arm.dx * run, sz - arm.dy * run, sx + arm.dx * run, sz + arm.dy * run, stripe, arm.lift + 0.055, white);
      }
    }
  }
}

// ---- assembly --------------------------------------------------------------

export function buildWorldTile(buffer: ArrayBuffer, tile: TileId, options: WorldBuildOptions): WorldTileData {
  const span = tileSpan(tile.z);
  const corner = tileCorner(tile);
  const metersScale = Math.cos(latFromMercator(corner[1] - span / 2) * Math.PI / 180);
  const vt = new VectorTile(new PbfReader(buffer));
  const dem = options.dem;
  // vector ground; everything placed on it follows the (water-carved) terrain mesh
  const ground = buildGround(vt, span, options.grid, dem, metersScale);
  const groundAt = (x: number, z: number) => gridGround(ground.heights, options.grid, x / span, z / span);
  // roads stay a finger above any nearby water — bank dips must not drown the pavement
  const ROAD_CLEAR = 0.18;
  const driveAt = (x: number, z: number) => {
    const g = groundAt(x, z);
    const water = gridWaterLevel(ground.waterLevel, options.grid, x / span, z / span);
    return water == null ? g : Math.max(g, water + ROAD_CLEAR);
  };
  const waterAt = (x: number, z: number) => gridWaterLevel(ground.waterLevel, options.grid, x / span, z / span);
  const bridgeList: number[] = [];
  // statues, fountains, bus shelters, pitch lines and goals
  const furniture = streetFurniture(vt, span, metersScale);
  const features: Record<string, GeoFeature[]> = {};
  for (const name of GAMEPLAY_LAYERS) {
    const layer = vt.layers[name];
    const list: GeoFeature[] = [];
    if (layer) for (let i = 0; i < layer.length; i++) list.push(layer.feature(i).toGeoJSON(tile.x, tile.y, tile.z) as unknown as GeoFeature);
    features[name] = list;
  }
  // the planted streets, once: the trees and hedges for the vegetation, and the strip of
  // lawn a hedge stands on for the road mesh
  const streets = planStreets(corner, span, metersScale, features as unknown as Record<string, MapFeature[]>);
  // the tiles around: their roads go into the bridge plan (an unreadable one is left out)
  const around = (options.neighbours ?? []).flatMap(({ dx, dy, buffer: b }) => {
    try { return b.byteLength ? [{ dx, dy, vt: new VectorTile(new PbfReader(new Uint8Array(b))) }] : []; } catch { return []; }
  });
  const roads = roadMesh(vt, span, options.grid, { driveAt, groundAt, waterAt, toMerc: 1 / metersScale }, bridgeList, furniture.lines, hedgeLawns(streets.plants, 1 / metersScale), around);
  // streams sit on the water surface — following the carved bed made torn blue ribbons
  const streamAt = (x: number, z: number) => {
    const g = groundAt(x, z);
    const water = gridWaterLevel(ground.waterLevel, options.grid, x / span, z / span);
    return water == null ? g : Math.max(g, water + 0.04);
  };
  const streams = streamMesh(vt, span, metersScale, streamAt, options.grid);
  const bridges = new Float32Array(bridgeList);
  // on a bridge / causeway the surface is the deck
  const surfaceAt = (x: number, z: number) => Math.max(groundAt(x, z), bridgeDeck(bridges, x, z) ?? -Infinity);

  return {
    tile,
    corner,
    metersScale,
    dem,
    ground,
    bridges,
    roads,
    streams,
    buildings: buildTile(vt, tile, {
      buildingAssemblies: options.buildingAssemblies,
      chunks: options.chunks,
      windows: false,
      dem,
      // same height field as the visible ground mesh — keeps feet on the plaza
      terrain: { heights: ground.heights, grid: options.grid },
      inset: options.inset,
      legacyColors: true,
      detailed: { region: options.region },
      // no houses punching through overpasses — short sheds under the deck may stay
      onElevatedBridge: (x, z, crest, foot, top) => {
        const deck = bridgeDeck(bridges, x, z, 1.55);
        if (deck == null || deck - crest < 1.8) return false;
        const underside = deck - 1;
        return foot < deck + 1.2 && top > underside;
      },
    }),
    vegetation: buildVegetation(corner, span, metersScale, features as unknown as Record<string, MapFeature[]>, surfaceAt, furniture, streets),
    features,
    layers: Object.keys(vt.layers),
    raw: buffer,
  };
}

export function worldTransferables(data: WorldTileData): ArrayBuffer[] {
  const out = [...buildingTransferables(data.buildings), ...vegetationTransferables(data.vegetation)];
  out.push(...groundTransferables(data.ground), data.bridges.buffer as ArrayBuffer);
  for (const mesh of [data.roads, data.streams]) {
    out.push(mesh.positions.buffer as ArrayBuffer, mesh.ground.buffer as ArrayBuffer, mesh.index.buffer as ArrayBuffer);
    if (mesh.colors) out.push(mesh.colors.buffer as ArrayBuffer);
    if (mesh.uvs) out.push(mesh.uvs.buffer as ArrayBuffer);
  }
  if (data.dem) out.push(data.dem.buffer as ArrayBuffer);
  out.push(data.raw);
  return out;
}
