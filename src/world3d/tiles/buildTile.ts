// Turns one OpenFreeMap PBF tile into GPU-ready typed arrays.
//
// Pure and DOM-free: runs inside the tile worker and in node tests.
// Output is batched per chunk (a sub-square of the tile): one indexed geometry
// for all walls + roofs in the chunk, plus one instance list for windows.
// Geometry is relative to the tile's north-west corner, in mercator meters
// horizontally (x east, z south) and true meters vertically.

import { PbfReader } from 'pbf';
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import earcut from 'earcut';
import { createRecipe, hashSeed, HOUSE_PALETTE, indexFor, portuguesePastel, type BuildingRecipe } from '../../game/buildings/BuildingStyles.ts';
import { layoutFacade } from '../../game/buildings/FacadeGenerator.ts';
import { buildRoof, canPitch, simplifyRing, type RoofKind as PitchedKind, type RoofPoint } from '../../game/buildings/RoofGenerator.ts';
import { PIECES, ROOF_LIP } from '../../game/buildings/pieces.ts';
import type { InstanceSet } from './vegetationTile.ts';
import { buildingStyleKey, primaryTileSeam } from '../../game/buildings/wallOverlap.ts';
import { clusterBuildingStyleKeys, ringArea } from '../../game/buildings/buildingStyleCluster.ts';
import { cutCoveredWalls } from './wallCut.ts';
import { tileCorner, tileSpan, latFromMercator, type TileId } from '../mercator.ts';
import { DEM_SIZE, sampleDem } from './dem.ts';

/** Facade texture layout: one bay (BAY m wide, 4 windows) by one floor. */
export const BAY = 8;
export const FLOOR = 3.2;
/** UV that samples the blank wall corner of the facade texture. */
const SOLID_U = 0.012;
const SOLID_V = 0.02;
const ROOF_SHADE = 1;

/**
 * Compact window instances (8 floats each instead of a 16-float matrix + color).
 * offsets: centre x, y, z (tile-local) and raw DEM ground under the building (m). axes: along-wall vector x, z scaled to the
 * window width (mercator meters), window height (m), glass variant (0/1).
 * The outward normal is (axis.z, -axis.x) normalised.
 */
export type WindowData = {
  count: number;
  offsets: Float32Array;
  axes: Float32Array;
};

export type ChunkData = {
  /** chunk centre, tile-local mercator meters */
  cx: number;
  cz: number;
  /** horizontal half-size, mercator meters */
  radius: number;
  maxHeight: number;
  buildings: number;
  positions: Float32Array;
  normals: Int8Array;
  colors: Uint8Array;
  /** u, v (facade texture coords in bays/floors), glass variant */
  facade: Float32Array;
  /** raw DEM height (m) under each vertex; the shader multiplies by terrain exaggeration */
  ground: Float32Array;
  /** building centre per vertex (tile-local x, z) */
  center: Float32Array;
  /** window grid per wall vertex: columns, rows, column step (m), row step (m); 0 columns = no windows */
  win: Float32Array;
  /** window frame width and height (m) */
  winSize: Float32Array;
  index: Uint32Array;
  windows: WindowData;
};

export type TileStats = {
  features: number;
  buildings: number;
  triangles: number;
  windows: number;
  bytes: number;
  decodeMs: number;
};

/**
 * Building footprints for gameplay (collisions, later: AI, spawn search).
 * coords: x, z pairs, tile-local mercator meters. ringStart[i] is the first pair
 * of ring i; buildingStart[b] is the first ring of building b (ring 0 = outer).
 * Both arrays carry a terminal entry. bounds: minX, minZ, maxX, maxZ per building.
 * heights: peak roof clearance (m) above the building base.
 * roofs: 8 floats per building — eaves, peak, ridgeAx, ridgeAz, ridgeBx, ridgeBz,
 * halfWidth (true m; 0 = flat), crest (raw DEM under the footprint).
 */
export type FootprintData = {
  coords: Float32Array;
  ringStart: Uint32Array;
  buildingStart: Uint32Array;
  bounds: Float32Array;
  heights: Float32Array;
  roofs: Float32Array;
};

/** floats per building in FootprintData.roofs */
export const ROOF_STRIDE = 8;

/** Small roof props, instanced: chimneys and vents (same rules as BuildingManager). */
export type AccentData = { chimney: InstanceSet; vent: InstanceSet; antenna: InstanceSet; dish: InstanceSet; ac: InstanceSet };

export type TileData = {
  tile: TileId;
  footprints: FootprintData;
  accents: AccentData;
  corner: [number, number];
  /** cos(latitude) at the tile centre: mercator meters → true meters */
  metersScale: number;
  chunks: ChunkData[];
  stats: TileStats;
};

export type BuildOptions = {
  /** chunks per tile edge; total chunks = n*n */
  chunks: number;
  /** emit instanced window placements */
  windows: boolean;
  /** decoded terrarium heights of the same tile, or null for flat ground */
  dem?: Float32Array | null;
  /**
   * Processed terrain grid (same as the ground mesh: water-carved, road-flattened).
   * When set, building feet sample this instead of raw DEM — otherwise houses float
   * above plazas/roads where the mesh was lowered under the DEM.
   */
  terrain?: { heights: Float32Array; grid: number };
  /** shrink footprints and roofs by this many meters, so a detailed copy drawn
   *  on top hides this one completely (no z-fighting) */
  inset?: number;
  /** colour buildings with the same key as rendering/CityBuildings */
  legacyColors?: boolean;
  /**
   * Full look of the old detailed layer: building recipes (style, colours,
   * windows per style), roof lips, pitched roofs, chimneys and vents.
   * Value is the region (country) that biases architecture styles.
   */
  detailed?: { region: string };
  /**
   * True when this building would punch through an elevated deck (tile-local x/z, crest/foot/top m).
   * Skipped so overpasses keep a clear carriageway and their piers.
   */
  onElevatedBridge?: (x: number, z: number, crest: number, foot: number, top: number) => boolean;
};

/** Bilinear sample of the terrain height grid at tile fraction (u, v). */
function sampleTerrainGrid(heights: Float32Array, grid: number, u: number, v: number) {
  const n = grid + 1;
  const x = Math.min(grid, Math.max(0, u * grid)), y = Math.min(grid, Math.max(0, v * grid));
  const i = Math.min(grid - 1, Math.floor(x)), j = Math.min(grid - 1, Math.floor(y));
  const fu = x - i, fv = y - j;
  const ha = heights[j * n + i], hb = heights[j * n + i + 1], hc = heights[(j + 1) * n + i], hd = heights[(j + 1) * n + i + 1];
  return fu + fv <= 1 ? ha + (hb - ha) * fu + (hc - ha) * fv : hd + (hc - hd) * (1 - fu) + (hb - hd) * (1 - fv);
}

/** How far walls dig into the ground so a small DEM/mesh mismatch never shows a gap. */
/** reach below sampled crest so walls still meet DEM on slopes / tile seams */
const WALL_SKIRT = 3.5;

type Pt = [number, number];

class ChunkBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  facade: number[] = [];
  ground: number[] = [];
  center: number[] = [];
  win: number[] = [];
  winSize: number[] = [];
  index: number[] = [];
  /** window grid applied to the vertices being written */
  grid: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  /** per-building context for vertices */
  cx = 0;
  cz = 0;
  windowOffsets: number[] = [];
  windowAxes: number[] = [];
  buildings = 0;
  maxHeight = 0;

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, rgb: Pt3, u: number, v: number, glass: number, ground = 0) {
    this.positions.push(x, y, z);
    this.ground.push(ground);
    this.center.push(this.cx, this.cz);
    const g = this.grid;
    this.win.push(g[0], g[1], g[2], g[3]);
    this.winSize.push(g[4], g[5]);
    this.normals.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
    this.colors.push(rgb[0], rgb[1], rgb[2]);
    this.facade.push(u, v, glass);
    return this.positions.length / 3 - 1;
  }

  quad(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, nx: number, nz: number, rgb: Pt3, u1: number, v0: number, v1: number, glass: number, textured: boolean, g: [number, number, number, number], u0 = 0) {
    const uA = textured ? u0 : SOLID_U;
    const uB = textured ? u1 : SOLID_U;
    const vA = textured ? v0 : SOLID_V;
    const vB = textured ? v1 : SOLID_V;
    const i = this.vertex(ax, y0, az, nx, 0, nz, rgb, uA, vA, glass, g[0]);
    this.vertex(bx, y0, bz, nx, 0, nz, rgb, uB, vA, glass, g[1]);
    this.vertex(bx, y1, bz, nx, 0, nz, rgb, uB, vB, glass, g[2]);
    this.vertex(ax, y1, az, nx, 0, nz, rgb, uA, vB, glass, g[3]);
    // triangle (A0, B1, B0) faces (dz, -dx); flip when the outward normal is opposite
    const facesOut = (bz - az) * nx - (bx - ax) * nz > 0;
    if (facesOut) this.index.push(i, i + 2, i + 1, i, i + 3, i + 2);
    else this.index.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
}

type Pt3 = [number, number, number];

function rgbBytes(hex: string): Pt3 {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const WALLS = portuguesePastel.wallColors.map(rgbBytes);

/** Shift each channel by up to ±3 (of 255) from the building seed. */
function jitterRgb(rgb: Pt3, seed: number): Pt3 {
  const d = (salt: number) => ((Math.imul(seed ^ salt, 0x9e3779b1) >>> 0) % 7) - 3;
  return [
    Math.max(0, Math.min(255, rgb[0] + d(0x1b873593))),
    Math.max(0, Math.min(255, rgb[1] + d(0x85ebca6b))),
    Math.max(0, Math.min(255, rgb[2] + d(0xc2b2ae35))),
  ];
}
const ROOFS = portuguesePastel.roofColors.map(rgbBytes);
const GLASS_VARIANTS = portuguesePastel.windowColors.length;

/** Sutherland–Hodgman against the tile square [0, extent]². Keeps winding. */
export function clipRing(ring: Pt[], extent: number): Pt[] {
  let out = ring;
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + (b[1] - a[1]) * (0 - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= extent, (a, b) => [extent, a[1] + (b[1] - a[1]) * (extent - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + (b[0] - a[0]) * (0 - a[1]) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= extent, (a, b) => [a[0] + (b[0] - a[0]) * (extent - a[1]) / (b[1] - a[1]), extent]],
  ];
  for (const [inside, cross] of edges) {
    if (out.length < 3) return [];
    const next: Pt[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const ina = inside(a);
      const inb = inside(b);
      if (ina) {
        next.push(a);
        if (!inb) next.push(cross(a, b));
      } else if (inb) next.push(cross(a, b));
    }
    out = next;
  }
  return out;
}

function signedArea(ring: Pt[]) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/**
 * True for an edge that sits on a tile border the neighbour already seals.
 *
 * Buildings clipped across a tile (by us or by the vector source) get a fake
 * edge along the cut. Skipping that edge on *both* tiles left a hole into the
 * hollow shell — visible on large footprints that barely spill over a boundary
 * (Forum Coimbra, etc.). Own the min edges (x=0, y=0); the neighbour owns the
 * shared line via those, so we drop only the max edges (x=extent, y=extent).
 */
export function omitBorderWall(a: Pt, b: Pt, extent: number) {
  const e = 0.5;
  return (a[0] >= extent - e && b[0] >= extent - e)
    || (a[1] >= extent - e && b[1] >= extent - e);
}

function prepareRing(points: { x: number; y: number }[], extent: number): Pt[] {
  const ring: Pt[] = points.map((p) => [p.x, p.y]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop();
  let inside = true;
  for (const p of ring) if (p[0] < 0 || p[1] < 0 || p[0] > extent || p[1] > extent) { inside = false; break; }
  const clipped = inside ? ring : clipRing(ring, extent);
  // drop duplicate consecutive points produced by clipping
  const clean: Pt[] = [];
  for (const p of clipped) {
    const prev = clean[clean.length - 1];
    if (!prev || Math.abs(prev[0] - p[0]) > 1e-6 || Math.abs(prev[1] - p[1]) > 1e-6) clean.push(p);
  }
  if (clean.length > 1) {
    const a = clean[0];
    const b = clean[clean.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) clean.pop();
  }
  return clean.length >= 3 ? clean : [];
}

/** Move every vertex inward by `d` (tile pixels) along the corner bisector. */
function insetRing(ring: Pt[], sign: number, d: number): Pt[] {
  if (d <= 0) return ring;
  const n = ring.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n], c = ring[i], q = ring[(i + 1) % n];
    const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
    const l2 = Math.hypot(q[0] - c[0], q[1] - c[1]) || 1;
    // outward normals of the two edges
    const n1x = sign * (c[1] - p[1]) / l1, n1z = sign * -(c[0] - p[0]) / l1;
    const n2x = sign * (q[1] - c[1]) / l2, n2z = sign * -(q[0] - c[0]) / l2;
    let bx = n1x + n2x, bz = n1z + n2z;
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-6) { out.push(c); continue; }
    bx /= bl; bz /= bl;
    const cos = Math.max(0.35, bx * n1x + bz * n1z); // limit long miters on sharp corners
    out.push([c[0] - bx * d / cos, c[1] - bz * d / cos]);
  }
  return out;
}

/** Tile pixel to lng/lat exactly like VectorTileFeature.toGeoJSON. */
function lngLatOf(tile: TileId, extent: number, x: number, y: number): [number, number] {
  const size = extent * 2 ** tile.z;
  const x0 = extent * tile.x;
  const y0 = extent * tile.y;
  const y2 = 180 - (y + y0) * 360 / size;
  return [(x + x0) * 360 / size - 180, 360 / Math.PI * Math.atan(Math.exp(y2 * Math.PI / 180)) - 90];
}

function linearRgb(hex: string): Pt3 {
  const v = Number.parseInt(hex.slice(1), 16);
  const f = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return [f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)];
}

/** Same spot rule as BuildingManager.decorPoint. */
function decorPoint(points: RoofPoint[], seed: number): RoofPoint {
  let sx = 0, sz = 0;
  for (const p of points) { sx += p.x; sz += p.z; }
  const corner = points[indexFor(points.length, seed)] ?? points[0];
  const n = points.length || 1;
  return { x: sx / n * 0.55 + corner.x * 0.45, z: sz / n * 0.55 + corner.z * 0.45 };
}

class Props {
  matrices: number[] = [];
  ground: number[] = [];
  colors: number[] = [];
  /** `yaw`: turned about the vertical (radians), +z of the model toward (sin, cos) */
  push(x: number, y: number, z: number, toMerc: number, ground: number, rgb: Pt3, yaw = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.matrices.push(c * toMerc, 0, -s * toMerc, 0, 0, 1, 0, 0, s * toMerc, 0, c * toMerc, 0, x, y, z, 1);
    this.ground.push(ground);
    this.colors.push(rgb[0], rgb[1], rgb[2]);
  }
  done(): InstanceSet {
    return { count: this.ground.length, matrices: new Float32Array(this.matrices), ground: new Float32Array(this.ground), colors: new Float32Array(this.colors) };
  }
}

/**
 * Window grid of one wall from layoutFacade (as the detailed layer painted it):
 * columns are evenly spaced, rows are one per floor, all panes the same size.
 */
function windowGrid(length: number, base: number, top: number, recipe: BuildingRecipe) {
  const panes = layoutFacade(length, base, base, top, recipe, { lod: 1, detail: 'medium', door: false, front: false, downspout: false })
    .filter((p) => p.mesh === 'glassSimple' || p.mesh === 'glass');
  if (!panes.length) return null;
  const xs = [...new Set(panes.map((p) => Math.round(p.along * 1000) / 1000))].sort((a, b) => a - b);
  const ys = [...new Set(panes.map((p) => Math.round(p.y * 1000) / 1000))].sort((a, b) => a - b);
  const frame = PIECES.windowSimple;
  const w = frame.w * panes[0].sx;
  const h = frame.h * panes[0].sy;
  const step = xs.length > 1 ? xs[1] - xs[0] : Math.max(w * 2, length);
  const rowStep = ys.length > 1 ? ys[1] - ys[0] : Math.max(h * 2, top - base);
  return { n: xs.length, m: ys.length, step, rowStep, w, h, u0: xs[0] - step / 2, v0: ys[0] - rowStep / 2 };
}

// Instanced window size in true meters.
const WINDOW_W = 1.2;
const WINDOW_H = 1.5;
const WINDOW_SPACING = 2.7;

export function buildTile(buffer: ArrayBuffer | Uint8Array | VectorTile, tile: TileId, options: BuildOptions): TileData {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const span = tileSpan(tile.z);
  const corner = tileCorner(tile);
  const metersScale = Math.cos(latFromMercator(corner[1] - span / 2) * Math.PI / 180);
  const toMerc = 1 / metersScale; // true meters → mercator meters
  const n = Math.max(1, Math.floor(options.chunks));
  const builders: ChunkBuilder[] = Array.from({ length: n * n }, () => new ChunkBuilder());
  const stats: TileStats = { features: 0, buildings: 0, triangles: 0, windows: 0, bytes: 0, decodeMs: 0 };

  const chimneys = new Props();
  const vents = new Props();
  // roof clutter (TV masts, satellite dishes) and air conditioners hung on the walls
  const antennas = new Props();
  const dishes = new Props();
  const coolers = new Props();
  const fpCoords: number[] = [];
  const fpRings: number[] = [];
  const fpBuildings: number[] = [];
  const fpBounds: number[] = [];
  const fpHeights: number[] = [];
  const fpRoofs: number[] = [];

  // walls are collected and resolved per tile, then emitted (see pass 2)
  type Face = {
    owner: string; ax: number; az: number; bx: number; bz: number; y0: number; y1: number; order: number;
    chunk: ChunkBuilder; cx: number; cz: number; nx: number; nz: number; length: number; ground: [number, number];
    crest: number; base: number; top: number; wall: Pt3; roof: Pt3; glass: number; recipe: BuildingRecipe;
  };
  const faces: Face[] = [];
  /**
   * Buildings with a parapet → its top. Its outer face is the wall going on up, emitted with
   * the walls (pass 2) so it is cut where a neighbour's wall covers it; those walls get no roof lip.
   */
  const parapetOwners = new Map<string, number>();

  const vt = buffer instanceof VectorTile ? buffer : new VectorTile(new PbfReader(buffer));
  const layer = vt.layers.building;
  const dem = options.dem ?? null;
  const terrain = options.terrain ?? null;
  if (layer) {
    const extent = layer.extent;
    const k = span / extent; // tile pixels → mercator meters
    const demScale = DEM_SIZE / extent;
    // Prefer the same height field the ground mesh uses (carved/flattened); raw DEM
    // sits above plazas and road beds and leaves houses hanging in the air.
    const groundAt = (p: Pt) => terrain
      ? sampleTerrainGrid(terrain.heights, terrain.grid, p[0] / extent, p[1] / extent)
      : dem ? sampleDem(dem, p[0] * demScale, p[1] * demScale) : 0;
    const inset = (options.inset ?? 0) * toMerc / k; // meters → tile pixels

    // Pass 1. OSM often has a building outline plus its parts (building:part) with
    // the same or overlapping footprints. Identical footprints keep only the
    // tallest copy; buildings that contain or sit
    // inside another one get no pitched roof, so roofs never cut through walls.
    type Candidate = {
      id: string; fp: string; height: number; base: number; measured: number;
      ring: { x: number; y: number }[]; cx: number; cy: number; box: number[];
    };
    const parsed: (ReturnType<typeof classifyRings> | null)[] = [];
    const best = new Map<string, Candidate>();
    for (let f = 0; f < layer.length; f++) {
      const feature = layer.feature(f);
      const props = feature.properties;
      if (feature.type !== 3 || props.hide_3d === true || props.hide_3d === 'true') { parsed.push(null); continue; }
      const reported = Number(props.render_height ?? props.height);
      const base0 = Math.max(0, Number(props.render_min_height ?? props.min_height ?? 0) || 0);
      const measured0 = Math.max(3, Math.min(320, Number.isFinite(reported) && reported > 0 ? reported : 10));
      const height0 = Math.max(base0 + 3, measured0);
      const polygons = classifyRings(feature.loadGeometry());
      parsed.push(polygons);
      polygons.forEach((polygon, pi) => {
        const ring = polygon[0];
        if (!ring || ring.length < 3) return;
        const fp = [...new Set(ring.map((p) => `${p.x},${p.y}`))].sort().join(';');
        let sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of ring) { sx += p.x; sy += p.y; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        const candidate: Candidate = {
          id: `${f}:${pi}`, fp, height: height0, base: base0, measured: measured0, ring,
          cx: sx / ring.length, cy: sy / ring.length, box: [x0, y0, x1, y1],
        };
        const prior = best.get(fp);
        if (!prior || height0 > prior.height + 0.05) best.set(fp, candidate);
      });
    }
    const keep = new Set([...best.values()].map((c) => c.id));
    const crowded = new Set<string>();
    const buried = new Set<string>();
    {
      const cell = 64;
      const grid = new Map<string, Candidate[]>();
      for (const c of best.values()) {
        const key = `${Math.floor(c.cx / cell)},${Math.floor(c.cy / cell)}`;
        const list = grid.get(key);
        if (list) list.push(c); else grid.set(key, [c]);
      }
      const insideRing = (x: number, y: number, ring: { x: number; y: number }[]) => {
        let hit = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
        }
        return hit;
      };
      for (const a of best.values()) {
        for (let gx = Math.floor(a.box[0] / cell); gx <= Math.floor(a.box[2] / cell); gx++) {
          for (let gy = Math.floor(a.box[1] / cell); gy <= Math.floor(a.box[3] / cell); gy++) {
            for (const b of grid.get(`${gx},${gy}`) ?? []) {
              if (b === a || b.cx < a.box[0] || b.cx > a.box[2] || b.cy < a.box[1] || b.cy > a.box[3]) continue;
              if (!insideRing(b.cx, b.cy, a.ring)) continue;
              crowded.add(a.id);
              crowded.add(b.id);
              // a part inside another building and not taller is buried in it
              if (b.height <= a.height + 0.05) buried.add(b.id);
            }
          }
        }
      }
    }

    // Abutting parts (shared wall) → one style key (largest footprint wins), so
    // diagonal OSM cuts do not paint the same house two colours.
    const styleParts = [];
    for (const c of best.values()) {
      if (!keep.has(c.id) || buried.has(c.id)) continue;
      const outer = prepareRing(c.ring, extent);
      if (outer.length < 3) continue;
      const ringLngLat = outer.map((p) => lngLatOf(tile, extent, p[0], p[1]));
      const seamPx = primaryTileSeam(outer.map((p) => ({ x: p[0], y: p[1] })), extent);
      const seamLngLat = seamPx.map((p) => lngLatOf(tile, extent, p.x, p.y));
      styleParts.push({
        id: c.id,
        height: c.height,
        area: ringArea(c.ring),
        ring: c.ring,
        styleKey: buildingStyleKey(c.measured, c.base, ringLngLat, seamLngLat),
      });
    }
    const styleKeyById = clusterBuildingStyleKeys(styleParts, { pxToMeters: k * metersScale });

    for (let f = 0; f < layer.length; f++) {
      const feature = layer.feature(f);
      stats.features++;
      if (feature.type !== 3) continue;
      const props = feature.properties;
      if (props.hide_3d === true || props.hide_3d === 'true') continue;
      const reported = Number(props.render_height ?? props.height);
      const base = Math.max(0, Number(props.render_min_height ?? props.min_height ?? 0) || 0);
      // same clamps as GameEngine.rememberPart, so keys and heights match the detailed layer
      const measured = Math.max(3, Math.min(320, Number.isFinite(reported) && reported > 0 ? reported : 10));
      const height = Math.max(base + 3, measured);
      const polygons = parsed[f];
      if (!polygons) continue;
      for (let pi = 0; pi < polygons.length; pi++) {
        const polygon = polygons[pi];
        if (!keep.has(`${f}:${pi}`) || buried.has(`${f}:${pi}`)) continue;
        const buildingId = `${f}:${pi}`;
        const outer = prepareRing(polygon[0], extent);
        if (outer.length < 3) continue;
        const rings = [outer, ...polygon.slice(1).map((ring) => prepareRing(ring, extent)).filter((ring) => ring.length >= 3)];
        // Colour/style seed: clustered abutting parts share one key; tile-cut
        // halves agree via the span of the primary seam (see buildingStyleKey).
        const ringLngLat = outer.map((p) => lngLatOf(tile, extent, p[0], p[1]));
        const seamPx = primaryTileSeam(outer.map((p) => ({ x: p[0], y: p[1] })), extent);
        const seamLngLat = seamPx.map((p) => lngLatOf(tile, extent, p.x, p.y));
        const key = styleKeyById.get(buildingId) ?? buildingStyleKey(measured, base, ringLngLat, seamLngLat);
        const seed = hashSeed(key);
        let wall = WALLS[indexFor(WALLS.length, seed)];
        let roof = ROOFS[indexFor(ROOFS.length, seed ^ 0x51f0c3)];
        const glassIndex = indexFor(GLASS_VARIANTS, seed ^ 0x6d2b79f5);
        let cxSum = 0;
        let czSum = 0;
        for (const p of outer) { cxSum += p[0]; czSum += p[1]; }
        const gx = Math.min(n - 1, Math.max(0, Math.floor(cxSum / outer.length / extent * n)));
        const gz = Math.min(n - 1, Math.max(0, Math.floor(czSum / outer.length / extent * n)));
        const chunk = builders[gz * n + gx];
        chunk.cx = cxSum / outer.length * k;
        chunk.cz = czSum / outer.length * k;
        // the ground it stands on: the highest point under its corners; a building cut by the
        // tile's edge takes it from the cut only, so both halves (built by two tiles, each
        // seeing its own half) stand at one height instead of one stepping down
        const onEdge = (p: Pt) => p[0] <= 0.5 || p[1] <= 0.5 || p[0] >= extent - 0.5 || p[1] >= extent - 0.5;
        const cut = outer.filter(onEdge);
        let crest = 0;
        for (const p of cut.length >= 2 ? cut : outer) crest = Math.max(crest, groundAt(p));
        // overpass through this volume → no house (keeps the deck / piers clear)
        if (options.onElevatedBridge) {
          let sx = 0, sz = 0;
          for (const p of outer) { sx += p[0] * k; sz += p[1] * k; }
          const samples: Pt[] = [[sx / outer.length, sz / outer.length]];
          for (const p of outer) samples.push([p[0] * k, p[1] * k]);
          for (let i = 0; i < outer.length; i++) {
            const a = outer[i], b = outer[(i + 1) % outer.length];
            samples.push([(a[0] + b[0]) * 0.5 * k, (a[1] + b[1]) * 0.5 * k]);
          }
          const foot = crest + base, top = crest + height;
          if (samples.some(([x, z]) => options.onElevatedBridge!(x, z, crest, foot, top))) continue;
        }
        chunk.buildings++;
        const recipe = options.detailed
          ? createRecipe({ id: 0, key, height: measured, base }, HOUSE_PALETTE, 'auto', options.detailed.region)
          : null;
        stats.buildings++;
        chunk.maxHeight = Math.max(chunk.maxHeight, height);

        fpBuildings.push(fpRings.length);
        let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
        for (const ring of rings) {
          fpRings.push(fpCoords.length / 2);
          for (const p of ring) {
            const x = p[0] * k, z = p[1] * k;
            fpCoords.push(x, z);
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
            if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
          }
        }
        fpBounds.push(bx0, bz0, bx1, bz1);
        // peak filled in after the roof is chosen (wall height until then)
        fpHeights.push(height);

        const clear = height - base;
        // Facade: plinth, a window body tiled in whole floors, and a cap.
        const plinth = Math.min(0.42, Math.max(0.16, clear * 0.1));
        const cap = Math.min(0.5, Math.max(0.18, clear * 0.09));
        const usable = clear - plinth - cap;
        let floors = Math.max(1, Math.round(usable / FLOOR));
        while (floors > 1 && usable / floors < 2.2) floors--;
        const hasWindows = clear >= 2.2 && usable > 0.8;
        const body0 = base + plinth;
        const body1 = height - cap;

        const top = height - (options.inset ?? 0);
        if (recipe) {
          wall = rgbBytes(recipe.colors.wall);
          roof = rgbBytes(recipe.colors.roof);
        }
        // a barely visible per-building shade: the facade shader seeds each building's
        // window rhythm and trim from its wall colour, and 8 palette colours alone would
        // give whole streets the same facade
        wall = jitterRgb(wall, seed);
        const shrunk: Pt[][] = [];
        for (let r = 0; r < rings.length; r++) {
          const source = rings[r];
          const sign = (signedArea(source) > 0 ? 1 : -1) * (r === 0 ? 1 : -1);
          const ring = insetRing(source, sign, inset);
          shrunk.push(ring);
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            if (omitBorderWall(source[i], source[(i + 1) % source.length], extent)) continue;
            const g: [number, number, number, number] = [groundAt(a), groundAt(b), crest, crest];
            const ax = a[0] * k, az = a[1] * k, bx = b[0] * k, bz = b[1] * k;
            const dx = bx - ax;
            const dz = bz - az;
            const lengthMerc = Math.hypot(dx, dz);
            if (lengthMerc < 1e-3) continue;
            const nx = sign * dz / lengthMerc;
            const nz = sign * -dx / lengthMerc;
            const length = lengthMerc * metersScale;
            if (recipe) {
              faces.push({
                // a wall standing on the ground reaches down to it whatever its crest (neighbours
                // on a slope have different crests): only a raised part (min_height) starts higher
                owner: key, ax, az, bx, bz, y0: base > 0.3 ? crest + base : -1e6, y1: crest + top, order: faces.length,
                chunk, cx: chunk.cx, cz: chunk.cz, nx, nz, length, ground: [g[0], g[1]],
                crest, base, top, wall, roof, glass: glassIndex, recipe,
              });
              continue;
            }
            const textured = hasWindows && length >= 1.55;
            if (!textured) {
              chunk.quad(ax, az, bx, bz, base - WALL_SKIRT, top, nx, nz, wall, 0, 0, 0, glassIndex, false, g);
              continue;
            }
            const bays = length >= 3.4 ? Math.max(1, Math.round(length / BAY)) : 0;
            // walls hang from the crest; the lower band reaches down to the sloped ground
            chunk.quad(ax, az, bx, bz, base - WALL_SKIRT, body0, nx, nz, wall, 0, 0, 0, glassIndex, false, g);
            chunk.quad(ax, az, bx, bz, body0, body1, nx, nz, wall, bays, 0, floors, glassIndex, bays > 0, [crest, crest, crest, crest]);
            chunk.quad(ax, az, bx, bz, body1, top, nx, nz, wall, 0, 0, 0, glassIndex, false, [crest, crest, crest, crest]);
            if (options.windows && length >= 2.5) {
              const columns = Math.floor((length - 0.6) / WINDOW_SPACING);
              if (columns < 1) continue;
              const step = length / columns;
              const floorH = (body1 - body0) / floors;
              const w = Math.min(WINDOW_W, step * 0.7);
              const h = Math.min(WINDOW_H, floorH * 0.6);
              const tx = dx / lengthMerc;
              const tz = dz / lengthMerc;
              // axis such that (axis.z, -axis.x) is the outward normal
              const ox = sign * tx * w * toMerc;
              const oz = sign * tz * w * toMerc;
              const lift = 0.05 * toMerc;
              for (let fl = 0; fl < floors; fl++) {
                const y = body0 + floorH * (fl + 0.55);
                for (let c = 0; c < columns; c++) {
                  const along = (c + 0.5) * step * toMerc;
                  const px = ax + tx * along + nx * lift;
                  const pz = az + tz * along + nz * lift;
                  chunk.windowOffsets.push(px, y, pz, crest);
                  chunk.windowAxes.push(ox, oz, h, glassIndex);
                }
              }
            }
          }
        }

        // Pitched roof (as the detailed layer chose it), only for free-standing footprints.
        const points: RoofPoint[] = recipe ? outer.map((p) => ({ x: (p[0] * k - chunk.cx) * metersScale, z: (p[1] * k - chunk.cz) * metersScale })) : [];
        const roofKind = recipe?.roofKind ?? 'flat';
        const wantsPitch = roofKind !== 'flat' && roofKind !== 'parapet';
        const pitched = Boolean(recipe) && wantsPitch && !crowded.has(buildingId)
          && (roofKind === 'compound' || canPitch(simplifyRing(points)));
        const ridge = pitched ? buildRoof(points, top + ROOF_LIP - 0.04, roofKind as PitchedKind, recipe!.seed) : null;
        // a low parapet round a flat roof: chosen ones, and some taller blocks whose footprint
        // could not take the pitched roof they were given
        const parapet = Boolean(recipe) && !ridge && !crowded.has(buildingId)
          && (roofKind === 'parapet' || (clear >= 12 && recipe!.seed % 5 < 2));

        // Flat roof (not under a pitched one: the two would fight for the same pixels).
        const flat: number[] = [];
        const holes: number[] = [];
        for (let r = 0; r < shrunk.length; r++) {
          if (r > 0) holes.push(flat.length / 2);
          for (const p of shrunk[r]) flat.push(p[0] * k, p[1] * k);
        }
        const triangles = ridge ? [] : earcut(flat, holes, 2);
        const capY = recipe ? top + ROOF_LIP : top;
        // collision roof: pitched falls from the ridge to the eaves; flat is a slab
        const eavesY = ridge ? ridge.eavesY : capY;
        const peakY = ridge ? ridge.ridgeY : capY;
        fpHeights[fpHeights.length - 1] = peakY;
        if (ridge) {
          fpRoofs.push(
            eavesY, peakY,
            chunk.cx + ridge.ridgeA.x * toMerc, chunk.cz + ridge.ridgeA.z * toMerc,
            chunk.cx + ridge.ridgeB.x * toMerc, chunk.cz + ridge.ridgeB.z * toMerc,
            ridge.halfWidth, crest,
          );
        } else {
          fpRoofs.push(eavesY, peakY, 0, 0, 0, 0, 0, crest);
        }
        if (triangles.length) {
          const start = chunk.positions.length / 3;
          for (let i = 0; i < flat.length; i += 2) {
            chunk.vertex(flat[i], capY, flat[i + 1], 0, 1, 0, roof, SOLID_U, SOLID_V, ROOF_SHADE, crest);
          }
          // earcut returns clockwise triangles in x/z-down space; flip for an upward face
          for (let t = 0; t < triangles.length; t += 3) {
            const p0 = triangles[t], p1 = triangles[t + 1], p2 = triangles[t + 2];
            const cross = (flat[p1 * 2] - flat[p0 * 2]) * (flat[p2 * 2 + 1] - flat[p0 * 2 + 1]) - (flat[p1 * 2 + 1] - flat[p0 * 2 + 1]) * (flat[p2 * 2] - flat[p0 * 2]);
            // three: front faces are CCW seen from +Y, i.e. cross (x,z) < 0
            if (cross < 0) chunk.index.push(start + p0, start + p1, start + p2);
            else chunk.index.push(start + p0, start + p2, start + p1);
          }
        }
        if (parapet) {
          // the wall going up past the roof: outer face in the wall's own plane from its top,
          // a thin top and an inner face, in wall colour; the walls skip their roof lip
          const ring = shrunk[0];
          const sign = signedArea(rings[0]) > 0 ? 1 : -1;
          const h = 0.55 + (recipe!.seed % 4) * 0.12;
          const thick = 0.26 * toMerc;
          const y1 = capY + h;
          parapetOwners.set(key, y1);
          const inner: Pt3 = [Math.round(wall[0] * 0.86), Math.round(wall[1] * 0.86), Math.round(wall[2] * 0.86)];
          const g4: [number, number, number, number] = [crest, crest, crest, crest];
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            const ax = a[0] * k, az = a[1] * k, bx = b[0] * k, bz = b[1] * k;
            const len = Math.hypot(bx - ax, bz - az);
            if (len < 1e-3) continue;
            const nx = sign * (bz - az) / len, nz = sign * -(bx - ax) / len;
            const ox = 0, oz = 0, ix = -nx * thick, iz = -nz * thick;
            chunk.quad(ax + ix, az + iz, bx + ix, bz + iz, capY - 0.02, y1, -nx, -nz, inner, 0, 0, 0, glassIndex, false, g4);
            const v0 = chunk.vertex(ax + ox, y1, az + oz, 0, 1, 0, wall, SOLID_U, SOLID_V, glassIndex, crest);
            chunk.vertex(bx + ox, y1, bz + oz, 0, 1, 0, wall, SOLID_U, SOLID_V, glassIndex, crest);
            chunk.vertex(bx + ix, y1, bz + iz, 0, 1, 0, wall, SOLID_U, SOLID_V, glassIndex, crest);
            chunk.vertex(ax + ix, y1, az + iz, 0, 1, 0, wall, SOLID_U, SOLID_V, glassIndex, crest);
            // front faces are CCW seen from +Y (cross in x/z < 0)
            const cross = (bx - ax) * (iz + az - az) - (bz - az) * (ix + ax - ax);
            if (cross < 0) chunk.index.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
            else chunk.index.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
          }
        }
        if (recipe) {
          if (ridge) {
            const start = chunk.positions.length / 3;
            for (let i = 0; i < ridge.positions.length; i += 9) {
              const tri = [0, 3, 6].map((o) => [chunk.cx + ridge.positions[i + o] * toMerc, ridge.positions[i + o + 1], chunk.cz + ridge.positions[i + o + 2] * toMerc]);
              const nxr = ridge.normals[i], nyr = ridge.normals[i + 1], nzr = ridge.normals[i + 2];
              // keep the side the normal points to as the front face
              const ux = tri[1][0] - tri[0][0], uy = tri[1][1] - tri[0][1], uz = tri[1][2] - tri[0][2];
              const vx = tri[2][0] - tri[0][0], vy = tri[2][1] - tri[0][1], vz = tri[2][2] - tri[0][2];
              const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
              const order = gx * nxr + gy * nyr + gz * nzr >= 0 ? [0, 1, 2] : [0, 2, 1];
              const base0 = chunk.positions.length / 3;
              for (let t = 0; t < 3; t++) chunk.vertex(tri[t][0], tri[t][1], tri[t][2], nxr, nyr, nzr, roof, SOLID_U, SOLID_V, ROOF_SHADE, crest);
              chunk.index.push(base0 + order[0], base0 + order[1], base0 + order[2]);
            }
            void start;
            chunk.maxHeight = Math.max(chunk.maxHeight, ridge.ridgeY + 1);
          }
          const at = (p: RoofPoint) => [chunk.cx + p.x * toMerc, chunk.cz + p.z * toMerc] as const;
          if (recipe.features.chimney) {
            const size = PIECES.chimney;
            const spot = ridge
              ? { x: ridge.ridgeA.x + (ridge.ridgeB.x - ridge.ridgeA.x) * (0.22 + (recipe.seed % 40) / 100), z: ridge.ridgeA.z + (ridge.ridgeB.z - ridge.ridgeA.z) * (0.22 + (recipe.seed % 40) / 100) }
              : decorPoint(points, recipe.seed);
            const y = ridge ? ridge.ridgeY + size.h * 0.35 : top + 0.42 + size.h * 0.42;
            const [x, z] = at(spot);
            chimneys.push(x, y, z, toMerc, crest, linearRgb(recipe.colors.roof));
          }
          if (recipe.features.vent) {
            const spot = decorPoint(points, recipe.seed ^ 91);
            const y = ridge ? ridge.ridgeY + 0.12 : top + 0.42 + PIECES.vent.h * 0.5;
            const [x, z] = at(spot);
            vents.push(x, y, z, toMerc, crest, linearRgb(recipe.colors.metal));
          }
          // a TV mast on one roof in three, a satellite dish on one flat roof in four
          const roll = (salt: number) => ((recipe.seed ^ salt) * 2654435761 >>> 0) / 4294967296;
          if (roll(0x51ed) < 0.33) {
            const spot = ridge
              ? { x: ridge.ridgeA.x + (ridge.ridgeB.x - ridge.ridgeA.x) * 0.7, z: ridge.ridgeA.z + (ridge.ridgeB.z - ridge.ridgeA.z) * 0.7 }
              : decorPoint(points, recipe.seed ^ 0x2b7);
            const [x, z] = at(spot);
            antennas.push(x, ridge ? ridge.ridgeY : top + 0.42, z, toMerc, crest, [0.18, 0.18, 0.2], roll(0x77) * Math.PI);
          }
          if (!ridge && roll(0xd15) < 0.25) {
            const [x, z] = at(decorPoint(points, recipe.seed ^ 0x4c1));
            dishes.push(x, top + 0.42, z, toMerc, crest, [0.82, 0.82, 0.8], roll(0x99) * Math.PI * 2);
          }
        }
      }
    }
  }

  // Pass 2. Coincident walls (shared by neighbours, or by an outline and its
  // parts) keep one owner per height range — no double walls flickering, and a
  // roof lip only where the wall really reaches its own top.
  if (faces.length) {
    const lip = 0.08 * toMerc;
    // walls up to 40 cm apart are one wall: OSM neighbours rarely share their vertices
    // exactly, and two faces that close flicker through each other from any distance
    for (const { wall: face, t0, t1, top: cap } of cutCoveredWalls(faces, 0.4 * toMerc)) {
      const chunk = face.chunk;
      chunk.cx = face.cx;
      chunk.cz = face.cz;
      const ax = face.ax + (face.bx - face.ax) * t0, az = face.az + (face.bz - face.az) * t0;
      const bx = face.ax + (face.bx - face.ax) * t1, bz = face.az + (face.bz - face.az) * t1;
      const ga = face.ground[0] + (face.ground[1] - face.ground[0]) * t0;
      const gb = face.ground[0] + (face.ground[1] - face.ground[0]) * t1;
      // a wall on the ground hangs into it (no gap on a slope / DEM mismatch); a raised part
      // starts at its base, else the skirt would cover the wall of the part below and flicker
      const y0 = face.base > 0.3 ? face.base : face.base - WALL_SKIRT;
      // under a raised part the wall stops where that part begins (no roof lip up there)
      const capped = cap != null && cap - face.crest < face.top - 0.05;
      const wallTop = capped ? Math.max(y0 + 0.1, cap - face.crest) : face.top;
      const grid = windowGrid(face.length, face.base, face.top, face.recipe);
      chunk.grid = grid ? [grid.n, grid.m, grid.step, grid.rowStep, grid.w, grid.h] : [0, 0, 0, 0, 0, 0];
      const u0 = grid ? (face.length * t0 - grid.u0) / grid.step : 0;
      const u1 = grid ? (face.length * t1 - grid.u0) / grid.step : 0;
      const v0 = grid ? (y0 - grid.v0) / grid.rowStep : 0;
      const v1 = grid ? (wallTop - grid.v0) / grid.rowStep : 0;
      chunk.quad(ax, az, bx, bz, y0, wallTop, face.nx, face.nz, face.wall, u1, v0, v1, face.glass, true, [ga, gb, face.crest, face.crest], u0);
      chunk.grid = [0, 0, 0, 0, 0, 0];
      // air conditioners on some walls of two floors or more: one or two boxes hung out on
      // the upper floors, never on the ground floor
      {
        const span = face.length * (t1 - t0);
        const seed = (face.recipe.seed ^ Math.round(face.ax * 997) ^ Math.round(face.az * 991)) >>> 0;
        const roll = (salt: number) => (((seed ^ salt) * 2654435761) >>> 0) / 4294967296;
        if (span > 5 && wallTop - face.base > 6 && roll(0xac) < 0.3) {
          const units = roll(0xad) < 0.4 ? 2 : 1;
          for (let u = 0; u < units; u++) {
            const along = t0 + (t1 - t0) * (0.2 + 0.6 * roll(0xb0 + u));
            const floors = Math.max(1, Math.floor((wallTop - face.base - 3.5) / 3.1));
            const y = face.base + 3.4 + 3.1 * Math.floor(roll(0xc0 + u) * floors) + 0.35;
            const x = face.ax + (face.bx - face.ax) * along + face.nx * 0.2 * toMerc;
            const z = face.az + (face.bz - face.az) * along + face.nz * 0.2 * toMerc;
            coolers.push(x, y, z, toMerc, face.crest, [0.86, 0.86, 0.83], Math.atan2(face.nx, face.nz));
          }
        }
      }
      if (capped) continue;
      const parapetTop = parapetOwners.get(face.owner);
      if (parapetTop != null) {
        chunk.quad(ax, az, bx, bz, face.top, parapetTop, face.nx, face.nz, face.wall, 0, 0, 0, face.glass, false, [face.crest, face.crest, face.crest, face.crest]);
        continue;
      }
      chunk.quad(ax + face.nx * lip, az + face.nz * lip, bx + face.nx * lip, bz + face.nz * lip,
        face.top, face.top + ROOF_LIP, face.nx, face.nz, face.roof, 0, 0, 0, face.glass, false, [face.crest, face.crest, face.crest, face.crest]);
    }
  }

  const chunkSpan = span / n;
  const chunks: ChunkData[] = [];
  builders.forEach((b, i) => {
    if (!b.index.length) return;
    const gx = i % n;
    const gz = Math.floor(i / n);
    const windows: WindowData = {
      count: b.windowOffsets.length / 4,
      offsets: new Float32Array(b.windowOffsets),
      axes: new Float32Array(b.windowAxes),
    };
    const chunk: ChunkData = {
      cx: (gx + 0.5) * chunkSpan,
      cz: (gz + 0.5) * chunkSpan,
      radius: chunkSpan / 2,
      maxHeight: b.maxHeight,
      buildings: b.buildings,
      positions: new Float32Array(b.positions),
      normals: new Int8Array(b.normals),
      colors: new Uint8Array(b.colors),
      facade: new Float32Array(b.facade),
      ground: new Float32Array(b.ground),
      center: new Float32Array(b.center),
      win: new Float32Array(b.win),
      winSize: new Float32Array(b.winSize),
      index: new Uint32Array(b.index),
      windows,
    };
    stats.triangles += chunk.index.length / 3;
    stats.windows += windows.count;
    stats.bytes += chunk.positions.byteLength + chunk.normals.byteLength + chunk.colors.byteLength
      + chunk.facade.byteLength + chunk.ground.byteLength + chunk.center.byteLength + chunk.win.byteLength + chunk.winSize.byteLength + chunk.index.byteLength + windows.offsets.byteLength + windows.axes.byteLength;
    chunks.push(chunk);
  });
  stats.decodeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
  fpRings.push(fpCoords.length / 2);
  fpBuildings.push(fpRings.length - 1);
  const footprints: FootprintData = {
    coords: new Float32Array(fpCoords),
    ringStart: new Uint32Array(fpRings),
    buildingStart: new Uint32Array(fpBuildings),
    bounds: new Float32Array(fpBounds),
    heights: new Float32Array(fpHeights),
    roofs: new Float32Array(fpRoofs),
  };
  stats.bytes += footprints.coords.byteLength + footprints.ringStart.byteLength + footprints.buildingStart.byteLength
    + footprints.bounds.byteLength + footprints.heights.byteLength + footprints.roofs.byteLength;
  return { tile, corner, metersScale, chunks, footprints, accents: { chimney: chimneys.done(), vent: vents.done(), antenna: antennas.done(), dish: dishes.done(), ac: coolers.done() }, stats };
}

/** Typed arrays to hand to postMessage as transferables. */
export function transferables(data: TileData): ArrayBuffer[] {
  const f = data.footprints;
  const out: ArrayBuffer[] = [f.coords.buffer, f.ringStart.buffer, f.buildingStart.buffer, f.bounds.buffer, f.heights.buffer, f.roofs.buffer] as ArrayBuffer[];
  for (const set of [data.accents.chimney, data.accents.vent, data.accents.antenna, data.accents.dish, data.accents.ac]) out.push(set.matrices.buffer as ArrayBuffer, set.ground.buffer as ArrayBuffer, set.colors!.buffer as ArrayBuffer);
  for (const c of data.chunks) {
    out.push(c.positions.buffer as ArrayBuffer, c.normals.buffer as ArrayBuffer, c.colors.buffer as ArrayBuffer,
      c.facade.buffer as ArrayBuffer, c.ground.buffer as ArrayBuffer, c.center.buffer as ArrayBuffer, c.index.buffer as ArrayBuffer,
      c.win.buffer as ArrayBuffer, c.winSize.buffer as ArrayBuffer,
      c.windows.offsets.buffer as ArrayBuffer, c.windows.axes.buffer as ArrayBuffer);
  }
  return out;
}
