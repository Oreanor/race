// Everything one z14 tile contributes to the world, built off the main thread:
// terrain mesh, a ground raster (landuse / landcover / park / water), road
// ribbons draped on the same DEM, far-building chunks and GeoJSON features for
// gameplay. Raw PBF bytes are kept too, so any other layer (poi, housenumber,
// place, mountain_peak, names…) can be decoded later for visualisation.

import { PbfReader } from 'pbf';
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { buildTile, transferables as buildingTransferables, type TileData } from './buildTile.ts';
import type { BuildingAssembly } from './buildingAssembly.ts';
import { buildGround, clipHalf, groundTransferables, type GroundData } from './groundVector.ts';
import { roadTerrain } from './roadTerrain.ts';

type Pt = [number, number];
import { latFromMercator, tileCorner, tileSpan, type TileId } from '../mercator.ts';
import { buildVegetation, vegetationTransferables, type VegetationData } from './vegetationTile.ts';
import { planStreets } from './streetscape.ts';
import { roadStyle, isPedestrian, roadDeckHalf, SLEEPER_PITCH, TRACK_HALF } from './roadStyle.ts';
import { planRoadNetwork, type RoadDeck as Deck, type RoadWay as Way, type PlannedRoad as Planned, type RoadSurfaces as Surfaces, type RoadXY as XY } from './roadNetwork.ts';
import { buildRoadSurface, deckSections, deckSideOpening, surfaceHeight, type RoadSurfaceData } from './roadSurface.ts';
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
  /** Exact upward-facing road triangles, shared by rendering and drive queries. */
  roadSurface: RoadSurfaceData;
  roads: MeshData;
  /** built for the map only (see WorldBuildOptions.lite): replaced by a full tile near the car */
  lite?: boolean;
  /** the railway beds on the ground: one textured strip a track (shoulder, ballast, sleepers, rails) */
  rails: MeshData;
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
  neighbours?: { dx: number; dy: number; buffer: ArrayBuffer; dem?: Float32Array | null }[];
  /**
   * A tile for the map only: ground, water, roads, buildings and plants, but no street
   * furniture and no bridge solve (from above a bridge reads as a road over the river) and
   * no neighbours' roads — several times quicker. The full tile replaces it once it comes
   * within reach of the car.
   */
  lite?: boolean;
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

/** The smoothed dry-bank grid must never become an invisible floor over water. */
export function driveTerrainHeight(visual: number, water: number | null) {
  return water != null && visual < water - 0.1 ? water - 0.12 : visual;
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
  surface: number[] = [];
  captureSurface = false;

  private surfaceTriangle(a: number, b: number, c: number) {
    if (!this.captureSurface) return;
    for (const i of [a, b, c]) this.surface.push(this.positions[i * 3], this.ground[i] + this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
  }

  groundAt: (x: number, z: number) => number;
  /** terrain cell size: every triangle is cut along the cells and their diagonals */
  cell: number;
  grid: number;
  /** a textured builder (the track bed): texture coordinates for every vertex, from this */
  uvAt: ((x: number, z: number) => [number, number]) | null = null;
  uvs: number[] | null;
  constructor(groundAt: (x: number, z: number) => number, cell: number, grid: number, textured = false) {
    this.groundAt = groundAt; this.cell = cell; this.grid = grid;
    this.uvs = textured ? [] : null;
  }

  private vertex(x: number, y: number, z: number, rgb: [number, number, number]) {
    this.positions.push(x, y, z);
    this.ground.push(this.groundAt(x, z));
    this.colors.push(rgb[0], rgb[1], rgb[2]);
    if (this.uvs) this.uvs.push(...(this.uvAt ? this.uvAt(x, z) : [0, 0]));
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
        for (let k = 1; k + 1 < half.length; k++) {
          this.index.push(first, first + k, first + k + 1);
          this.surfaceTriangle(first, first + k, first + k + 1);
        }
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
    for (const triangle of [[0, 1, 2], [0, 2, 3]]) {
      const [a, b, c] = triangle.map(i => corners[i]);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const [i, j, k] = triangle.map(i => first + i);
      if (!facing || (facing === 'up') === (cross < 0)) this.index.push(i, j, k);
      if (!facing || (facing === 'up') !== (cross < 0)) this.index.push(i, k, j);
    }
    if (facing === 'up') {
      this.surfaceTriangle(first, first + 1, first + 2);
      this.surfaceTriangle(first, first + 2, first + 3);
    }
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
    ...(builder.uvs ? { uvs: new Float32Array(builder.uvs) } : {}),
  };
}

/** Streams, canals, ditches: water ribbons (rivers come as water polygons). */
/** Inside a water polygon (river, lake, sea; not a pool), in tile-span units. */
function waterTest(vt: VectorTile, span: number): (x: number, z: number) => boolean {
  const layer = vt.layers.water;
  const polys: { rings: [number, number][][]; box: [number, number, number, number] }[] = [];
  if (layer) {
    const k = span / layer.extent;
    for (let f = 0; f < layer.length; f++) {
      const feature = layer.feature(f);
      if (feature.type !== 3 || feature.properties.class === 'swimming_pool') continue;
      for (const polygon of classifyRings(feature.loadGeometry())) {
        const rings = polygon.map((ring) => ring.map((p) => [p.x * k, p.y * k] as [number, number])).filter((r) => r.length >= 3);
        if (!rings.length) continue;
        const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, z] of rings[0]) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], z); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], z); }
        polys.push({ rings, box });
      }
    }
  }
  return (x, z) => polys.some(({ rings, box }) => {
    if (x < box[0] || x > box[2] || z < box[1] || z > box[3]) return false;
    let hit = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  });
}

function streamMesh(vt: VectorTile, span: number, metersScale: number, groundAt: (x: number, z: number) => number, grid: number): MeshData {
  const builder = new RoadBuilder(groundAt, span / grid, grid);
  const ways = vt.layers.waterway;
  if (ways) {
    const wet = waterTest(vt, span);
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
        const ax = c[0] * k, az = c[1] * k, bx = c[2] * k, bz = c[3] * k;
        // a stream ends at the bank of the river or lake it runs into: its line goes on
        // through the water, and drawn there it was a blue strip across the river
        const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (3 * toMerc)));
        let from = -1;
        for (let n = 0; n <= pieces; n++) {
          const dry = n < pieces && !wet(ax + (bx - ax) * (n + 0.5) / pieces, az + (bz - az) * (n + 0.5) / pieces);
          if (dry && from < 0) from = n;
          if (!dry && from >= 0) {
            builder.segment(ax + (bx - ax) * from / pieces, az + (bz - az) * from / pieces, ax + (bx - ax) * n / pieces, az + (bz - az) * n / pieces, half, 0.04, natural);
            from = -1;
          }
        }
        // round joins so the bends have no notches
        if (j > 0 && c[0] === line[j].x && c[1] === line[j].y && !wet(ax, az)) builder.disc(ax, az, half, 0.04, natural, 8);
      }
    }
  }
  return meshOf(builder);
}

// ---- bridges ----------------------------------------------------------------

const SLAB = 0.9, PARAPET = 0.75, PIER_GAP = 28;
const CONCRETE = hex('#8c8880');
const PARAPET_TOP = hex('#aaa59c');
const UNDERSIDE = hex('#4c4a46');

function transportWays(layer: VectorTile['layers'][string]): Map<number, Way> {
  const ways = new Map<number, Way>();
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i), p = feature.properties;
    if (feature.type !== 2 || p.brunnel === 'tunnel') continue;
    const cls = String(p.class ?? ''), sub = String(p.subclass ?? '');
    const style = roadStyle(cls, sub, Number(p.ramp) === 1), rail = railKind(p);
    if (!style && !rail) continue;
    const bridge = p.brunnel === 'bridge';
    ways.set(i, {
      lines: feature.loadGeometry().map(line => line.map(({ x, y }) => ({ x, y }))),
      bridge, level: Number(p.layer ?? (bridge ? 1 : 0)) || 0,
      foot: isPedestrian(cls, sub), rail: !!rail,
      half: style ? roadDeckHalf(style) : rail?.tram ? 2.1 : RAIL_DECK_HALF,
      source: feature.id == null ? undefined : cls + ':' + feature.id,
    });
  }
  return ways;
}

/** Plan topology and heights together; no height edits after the solve. */
export function planBridges(ownWays: Map<number, Way>, extent: number, span: number, at: Surfaces, extra?: Map<number, Way>): Map<number, Planned> {
  return planRoadNetwork(nearStructures(waysInContext(ownWays, extra ?? new Map(), extent), extent, span, at.toMerc), extent, span, at);
}

/** how far (m) from a bridge or a raised way a road still goes into the height solve (its ramps) */
const STRUCTURE_REACH = 400;

/**
 * Only the ways that can take part in a deck go to the height solve: bridges, raised ways
 * (layer above 0), and the roads within STRUCTURE_REACH of one (the ramps up to them and
 * the roads they cross). A road far from any of them lies on the ground anyway: solving it
 * cost every tile a node every 8 m on every road of a 3 × 3 window (Moscow: ~0.5 s a tile).
 */
function nearStructures(ways: Map<number, Way>, extent: number, span: number, toMerc: number): Map<number, Way> {
  const reach = STRUCTURE_REACH * toMerc / (span / extent);
  const box = (way: Way) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const line of way.lines) for (const p of line) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return [x0, y0, x1, y1] as const;
  };
  const anchors: (readonly [number, number, number, number])[] = [];
  for (const way of ways.values()) if (way.bridge || way.level > 0) anchors.push(box(way));
  const out = new Map<number, Way>();
  if (!anchors.length) return out;
  for (const [id, way] of ways) {
    if (way.bridge || way.level > 0) { out.set(id, way); continue; }
    const [x0, y0, x1, y1] = box(way);
    if (anchors.some(([a0, b0, a1, b1]) => x0 <= a1 + reach && x1 >= a0 - reach && y0 <= b1 + reach && y1 >= b0 - reach)) out.set(id, way);
  }
  return out;
}

/** True when this footbridge end continues into another planned deck. */
function deckContinuesNear(plan: Map<number, Planned>, self: Deck, x: number, z: number, h: number, toMerc: number) {
  for (const planned of plan.values()) for (const other of planned.decks) {
    if (other === self) continue;
    for (let i = 1; i < other.pts.length; i++) {
      const [ax, az] = other.pts[i - 1], [bx, bz] = other.pts[i];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(x - ax - t * dx, z - az - t * dz) < 0.5 * toMerc && Math.abs(h - other.h[i - 1] - (other.h[i] - other.h[i - 1]) * t) < 0.1) return true;
    }
  }
  return false;
}

/** Lay a ribbon along the deck (the road or rail bed on it), piece by piece. */
function deckRibbon(builder: RoadBuilder, deck: Pick<Deck, 'pts' | 'h' | 'frame' | 'half'>, half: number, y: number, rgb: [number, number, number], _joints: number, physical = false) {
  const sections = deckSections(deck, half, physical);
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1], b = sections[i];
    builder.quad([[...a.left, a.h, y], [...b.left, b.h, y], [...b.right, b.h, y], [...a.right, a.h, y]], rgb, 'up');
  }
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
type DeckPiece = { id: number; deck: Deck; n: number };
const deckPieceGrids = new WeakMap<Map<number, Planned>, Map<string, DeckPiece[]>>();
function deckPiecesAt(plan: Map<number, Planned>, x: number, z: number): DeckPiece[] {
  const cell = 32;
  let grid = deckPieceGrids.get(plan);
  if (!grid) {
    grid = new Map();
    for (const [id, p] of plan) for (const deck of p.decks) for (let n = 1; n < deck.pts.length; n++) {
      const a = deck.pts[n - 1], b = deck.pts[n], pad = Math.max(deck.half?.[n - 1] ?? 8, deck.half?.[n] ?? 8) * 2;
      const piece = { id, deck, n };
      for (let cx = Math.floor((Math.min(a[0], b[0]) - pad) / cell); cx <= Math.floor((Math.max(a[0], b[0]) + pad) / cell); cx++) {
        for (let cz = Math.floor((Math.min(a[1], b[1]) - pad) / cell); cz <= Math.floor((Math.max(a[1], b[1]) + pad) / cell); cz++) {
          const key = `${cx},${cz}`, list = grid.get(key) ?? []; list.push(piece); grid.set(key, list);
        }
      }
    }
    deckPieceGrids.set(plan, grid);
  }
  return grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? [];
}

function deckSideCovered(deck: Deck, i: number, side: number, half: number, plan: Map<number, Planned> | undefined, selfId: number) {
  if (!plan) return false;
  const sections = deckSections(deck, half, true);
  const a = sections[i - 1], b = sections[i];
  const pa = side > 0 ? a.left : a.right, pb = side > 0 ? b.left : b.right;
  for (const { id, deck: other, n } of deckPiecesAt(plan, (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)) {
    if (id === selfId) continue;
    if (deckSideOpening(deck, i, side, half, other, n)) return true;
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
  const sections = deckSections(deck, half, true);
  for (let i = 1; i < n; i++) {
    if (!up[i - 1] && !up[i]) continue;
    const a = sections[i - 1], b = sections[i];
    const wide = [reach(i, -1), reach(i, 1)];
    for (const sgn of [-1, 1]) {
      if (wide[sgn < 0 ? 0 : 1] != null) continue;
      const pa = sgn > 0 ? a.left : a.right, pb = sgn > 0 ? b.left : b.right;
      const ia: Pt = [pa[0] - a.normal[0] * wall * sgn, pa[1] - a.normal[1] * wall * sgn];
      const ib: Pt = [pb[0] - b.normal[0] * wall * sgn, pb[1] - b.normal[1] * wall * sgn];
      const f = side(a.normal[0] * sgn, a.normal[1] * sgn);
      const open = deckSideCovered(deck, i, sgn, half, plan, selfId);
      builder.quad([[...pa, a.h, -SLAB], [...pb, b.h, -SLAB], [...pb, b.h, open ? 0.05 : PARAPET], [...pa, a.h, open ? 0.05 : PARAPET]], shade(CONCRETE, f));
      if (!open) {
        builder.quad([[...pa, a.h, PARAPET], [...pb, b.h, PARAPET], [...ib, b.h, PARAPET], [...ia, a.h, PARAPET]], PARAPET_TOP, 'up');
        builder.quad([[...ia, a.h, PARAPET], [...ib, b.h, PARAPET], [...ib, b.h, 0.05], [...ia, a.h, 0.05]], shade(CONCRETE, 1.05 - f * 0.25));
      }
    }
    const sidePoint = (section: typeof a, sgn: number): Pt => {
      const w = wide[sgn < 0 ? 0 : 1] ?? section.half;
      return [section.x + section.normal[0] * w * sgn, section.z + section.normal[1] * w * sgn];
    };
    const al = sidePoint(a, 1), ar = sidePoint(a, -1), bl = sidePoint(b, 1), br = sidePoint(b, -1);
    builder.quad([[...al, a.h, -SLAB], [...bl, b.h, -SLAB], [...br, b.h, -SLAB], [...ar, a.h, -SLAB]], UNDERSIDE, 'down');
    if (sides.plate) {
      const saved = builder.captureSurface; builder.captureSurface = true;
      builder.quad([[...al, a.h, 0.04], [...bl, b.h, 0.04], [...br, b.h, 0.04], [...ar, a.h, 0.04]], sides.plate, 'up');
      builder.captureSurface = saved;
    }
  }
  if (sides.truss) deckTruss(builder, deck, half, toMerc, up, (i, sgn) => reach(i, sgn) != null || deckSideCovered(deck, i, sgn, half, plan, selfId));
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
function railTracks(builder: RoadBuilder, layer: VectorTile['layers'][string], k: number, at: Surfaces, bridges: number[], ways: Map<number, Way>, plan: Map<number, Planned>, bed?: RoadBuilder) {
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
      // metres along the line so far: the textured bed's sleepers run on without a jump
      let traveled = 0;
      let toMast = MAST_STEP * 0.5;
      for (let j = 0; j + 1 < line.length; j++) {
        const cut = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, layer.extent);
        if (!cut) continue;
        const [ax, az, bx, bz] = [cut[0] * k, cut[1] * k, cut[2] * k, cut[3] * k];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-9) continue;
        builder.groundAt = groundAt;
        const nx = -(bz - az) / len, nz = (bx - ax) / len;
        const lenM = len / toMerc;
        if (!tram && bed) {
          // the track bed in one textured strip: shoulder, ballast, sleepers and rails are in
          // the texture (u across, v along in sleeper pitches, carried on along the line)
          const ux = (bx - ax) / len, uz = (bz - az) / len, start = traveled;
          bed.groundAt = groundAt;
          bed.uvAt = (x, z) => [((x - ax) * nx + (z - az) * nz) / (TRACK_HALF * toMerc), (start + ((x - ax) * ux + (z - az) * uz) / toMerc) / SLEEPER_PITCH];
          bed.segment(ax, az, bx, bz, TRACK_HALF * toMerc, 0.06, ballast);
          // the outer side of a bend into the next piece, mapped as this one goes on
          const nb = line[j + 2];
          if (nb && cut[2] === line[j + 1].x && cut[3] === line[j + 1].y) bed.bevel(bx, bz, bx - ax, bz - az, nb.x * k - bx, nb.y * k - bz, TRACK_HALF * toMerc, 0.06, ballast);
          bed.uvAt = null;
        } else if (!tram) {
          builder.segment(ax, az, bx, bz, 1.65 * toMerc, 0.05, shoulder);
          builder.segment(ax, az, bx, bz, 1.2 * toMerc, 0.06, ballast);
          if (j > 0) {
            builder.disc(ax, az, 1.65 * toMerc, 0.05, shoulder, 6);
            builder.disc(ax, az, 1.2 * toMerc, 0.06, ballast, 6);
          }
        }
        traveled += lenM;
        if (!tram) {
          // a track running alongside for this whole piece: ballast across the gap too, so
          // a yard reads as one field of tracks, not strips with ground between
          if (len > 6 * toMerc) for (const sgn of [-1, 1]) {
            const d = alongside(i, ax, az, bx, bz, len, sgn);
            if (d == null) continue;
            const ox = nx * sgn * d / 2, oz = nz * sgn * d / 2;
            builder.segment(ax + ox, az + oz, bx + ox, bz + oz, d / 2 + 0.2 * toMerc, 0.055, ballast);
          }
          // sleepers across the bed, a little wider than the gauge (the textured bed has them)
          if (!bed) {
            const reach = (kind.gauge + 0.45) * toMerc;
            for (let s = toSleeper; s < lenM; s += SLEEPER_STEP) {
              const cx = ax + (bx - ax) * s / lenM, cz = az + (bz - az) * s / lenM;
              builder.segment(cx - nx * reach, cz - nz * reach, cx + nx * reach, cz + nz * reach, 0.11 * toMerc, 0.08, sleeper);
            }
            toSleeper = ((toSleeper - lenM) % SLEEPER_STEP + SLEEPER_STEP) % SLEEPER_STEP;
          }
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
        // the rails (on the textured bed at standard gauge; trams and narrow gauge drawn)
        if (tram || !bed || kind.gauge !== 0.72) railPair((ox, oz, w, y, rgb) => builder.segment(ax + ox, az + oz, bx + ox, bz + oz, w, y, rgb), nx, nz, gauge, tram);
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
const CONTEXT_MARGIN = 0.5;

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
      const half = style ? (style.width < 1.5 ? style.width / 2 + 0.53 : roadDeckHalf(style)) : railKind(p)?.tram ? 2.1 : RAIL_DECK_HALF;
      out.set(1e7 * (n + 1) + i, { ...way, lines, half });
    }
  });
  return out;
}

function roadMesh(vt: VectorTile, span: number, grid: number, at: Surfaces, bridges: number[], surface: number[], pitchLines: number[] = [], lawns: number[] = [], neighbours: { dx: number; dy: number; vt: VectorTile }[] = [], bed?: RoadBuilder, lite = false): MeshData {
  const towerSpots = new Set<string>();
  const { driveAt, groundAt: bedAt } = at;
  const builder = new RoadBuilder(driveAt, span / grid, grid);
  builder.surface = surface;
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
    // a map-only tile draws every road on the ground: no deck to solve
    const plan = lite ? new Map<number, Planned>() : planBridges(ways, layer.extent, span, at, extra);
    // a neighbour's deck that reaches our edge: not drawn here (its tile draws it), but the
    // car on our side of the edge drives on it
    if (extra) for (const [id, planned] of plan) {
      const half = extra.get(id)?.half;
      if (half != null) for (const deck of planned.decks) {
        pushDeck(bridges, deck, half * toMerc);
        const sections = deckSections(deck, half * toMerc, true);
        const lift = extra.get(id)?.rail ? 0.04 : 0.13;
        for (let n = 1; n < sections.length; n++) {
          const a = sections[n - 1], b = sections[n], pad = Math.max(a.half, b.half) * 2;
          if (Math.max(a.x, b.x) < -pad || Math.max(a.z, b.z) < -pad || Math.min(a.x, b.x) > span + pad || Math.min(a.z, b.z) > span + pad) continue;
          for (const [p, h] of [[a.left, a.h], [b.left, b.h], [b.right, b.h], [a.left, a.h], [b.right, b.h], [a.right, a.h]] as [Pt, number][]) surface.push(p[0], h + lift, p[1]);
        }
      }
    }
    railTracks(builder, layer, k, at, bridges, ways, plan, bed);
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
        const edge = (style.width < 1.5 ? style.width / 2 + 0.53 : roadDeckHalf(style)) * toMerc;
        for (const deck of planned?.decks ?? []) {
          builder.captureSurface = false;
          if (pass === 'casing') {
            // the parapets stand just outside the shoulders, on a concrete edge
            deckStructure(builder, deck, edge, toMerc, plan, i);
            // footbridges: stair towers where an end hangs in the air
            if (style.width < 1.5) stairTowers(builder, deck, toMerc, span, towerSpots, plan);
            // the shoulders out to the parapets in the carriageway's own asphalt (one surface,
            // the casing reads as the edge line); round joins as smooth as the road's
            builder.captureSurface = true;
            deckRibbon(builder, deck, edge, 0.13, hex(style.fill), steps, true);
          } else pushDeck(bridges, deck, edge);
          builder.captureSurface = pass === 'fill';
          deckRibbon(builder, deck, half, pass === 'fill' ? 0.18 : 0.14, rgb, steps);
        }
        builder.captureSurface = pass === 'fill';
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
        builder.captureSurface = false;
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
  const around = (options.neighbours ?? []).flatMap(({ dx, dy, buffer: b, dem }) => {
    try { return b.byteLength ? [{ dx, dy, dem, vt: new VectorTile(new PbfReader(new Uint8Array(b))) }] : []; } catch { return []; }
  });
  const terrainAt = roadTerrain(ground, dem, around, span, options.grid, metersScale);
  const groundAt = (x: number, z: number) => {
    const { ground: g, u, v } = terrainAt(x, z);
    return gridGround(g.heights, options.grid, u, v);
  };
  // roads stay a finger above any nearby water — bank dips must not drown the pavement
  const ROAD_CLEAR = 0.18;
  const driveAt = (x: number, z: number) => {
    const { ground: sample, u, v } = terrainAt(x, z);
    const g = gridGround(sample.heights, options.grid, u, v);
    const water = gridWaterLevel(sample.waterLevel, options.grid, u, v);
    return water == null ? g : Math.max(g, water + ROAD_CLEAR);
  };
  const waterAt = (x: number, z: number) => {
    const { ground: g, u, v } = terrainAt(x, z);
    return gridWaterLevel(g.waterLevel, options.grid, u, v);
  };
  const bridgeList: number[] = [];
  const surfaceList: number[] = [];
  // statues, fountains, bus shelters, pitch lines and goals
  // a map-only tile has no benches, shelters or pitch lines (nobody stands next to them)
  const furniture = options.lite ? { monuments: [], fountains: [], shelters: [], goals: [], lines: [] } as unknown as ReturnType<typeof streetFurniture> : streetFurniture(vt, span, metersScale);
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
  // the railway beds go into their own small textured mesh (a texture instead of sleepers and rails)
  const railBed = new RoadBuilder(driveAt, span / options.grid, options.grid, true);
  const roads = roadMesh(vt, span, options.grid, { driveAt, groundAt, waterAt, toMerc: 1 / metersScale }, bridgeList, surfaceList, furniture.lines, hedgeLawns(streets.plants, 1 / metersScale), around, railBed, options.lite === true);
  const rails = meshOf(railBed);
  // streams sit on the water surface — following the carved bed made torn blue ribbons
  const streamAt = (x: number, z: number) => {
    const g = groundAt(x, z);
    const water = gridWaterLevel(ground.waterLevel, options.grid, x / span, z / span);
    return water == null ? g : Math.max(g, water + 0.04);
  };
  const streams = streamMesh(vt, span, metersScale, streamAt, options.grid);
  const bridges = new Float32Array(bridgeList);
  const roadSurface = buildRoadSurface(new Float32Array(surfaceList));
  // on a bridge / causeway the surface is the deck
  const surfaceAt = (x: number, z: number) => Math.max(groundAt(x, z), surfaceHeight(roadSurface, x, z) ?? -Infinity);

  return {
    tile,
    corner,
    metersScale,
    dem,
    ground,
    bridges,
    roadSurface,
    roads,
    lite: options.lite === true,
    rails,
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
        const deck = surfaceHeight(roadSurface, x, z);
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
  out.push(data.roadSurface.triangles.buffer as ArrayBuffer, data.roadSurface.offsets.buffer as ArrayBuffer, data.roadSurface.entries.buffer as ArrayBuffer);
  for (const mesh of [data.roads, data.rails, data.streams]) {
    out.push(mesh.positions.buffer as ArrayBuffer, mesh.ground.buffer as ArrayBuffer, mesh.index.buffer as ArrayBuffer);
    if (mesh.colors) out.push(mesh.colors.buffer as ArrayBuffer);
    if (mesh.uvs) out.push(mesh.uvs.buffer as ArrayBuffer);
  }
  if (data.dem) out.push(data.dem.buffer as ArrayBuffer);
  out.push(data.raw);
  return out;
}
