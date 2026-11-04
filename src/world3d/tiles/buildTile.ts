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
import { buildRoof, canPitch, simplifyRing, type RoofPoint } from '../../game/buildings/RoofGenerator.ts';
import { PIECES, ROOF_LIP } from '../../game/buildings/pieces.ts';
import type { InstanceSet } from './vegetationTile.ts';
import { footprintKey } from '../../game/buildings/wallOverlap.ts';
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
 */
export type FootprintData = {
  coords: Float32Array;
  ringStart: Uint32Array;
  buildingStart: Uint32Array;
  bounds: Float32Array;
  heights: Float32Array;
};

/** Small roof props, instanced: chimneys and vents (same rules as BuildingManager). */
export type AccentData = { chimney: InstanceSet; vent: InstanceSet };

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
};

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

/** Edge lies on the tile border: it belongs to the clip, not to a real wall. */
function onBorder(a: Pt, b: Pt, extent: number) {
  const e = 0.5;
  return (a[0] <= e && b[0] <= e) || (a[0] >= extent - e && b[0] >= extent - e)
    || (a[1] <= e && b[1] <= e) || (a[1] >= extent - e && b[1] >= extent - e);
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
  push(x: number, y: number, z: number, toMerc: number, ground: number, rgb: Pt3) {
    this.matrices.push(toMerc, 0, 0, 0, 0, 1, 0, 0, 0, 0, toMerc, 0, x, y, z, 1);
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
  const fpCoords: number[] = [];
  const fpRings: number[] = [];
  const fpBuildings: number[] = [];
  const fpBounds: number[] = [];
  const fpHeights: number[] = [];

  const vt = buffer instanceof VectorTile ? buffer : new VectorTile(new PbfReader(buffer));
  const layer = vt.layers.building;
  const dem = options.dem ?? null;
  if (layer) {
    const extent = layer.extent;
    const k = span / extent; // tile pixels → mercator meters
    const demScale = DEM_SIZE / extent;
    const groundAt = (p: Pt) => dem ? sampleDem(dem, p[0] * demScale, p[1] * demScale) : 0;
    const inset = (options.inset ?? 0) * toMerc / k; // meters → tile pixels
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
      const polygons = classifyRings(feature.loadGeometry());
      for (const polygon of polygons) {
        const outer = prepareRing(polygon[0], extent);
        if (outer.length < 3) continue;
        const rings = [outer, ...polygon.slice(1).map((ring) => prepareRing(ring, extent)).filter((ring) => ring.length >= 3)];
        let key: string;
        if (options.legacyColors) {
          // CityBuildings colours by `${height}:${base}:${footprintKey(lng/lat rings)}`
          const geo = polygon.map((ring) => ring.map((p) => lngLatOf(tile, extent, p.x, p.y)));
          key = `${Math.round(measured)}:${base.toFixed(1)}:${footprintKey(geo)}`;
        } else {
          // Stable per-building key from its global position. Feature ids are not
          // per building: OpenFreeMap merges many buildings into one MultiPolygon.
          let minX = Infinity, minY = Infinity;
          for (const p of polygon[0]) { if (p.x < minX || (p.x === minX && p.y < minY)) { minX = p.x; minY = p.y; } }
          key = `p${tile.z}:${tile.x * extent + minX}:${tile.y * extent + minY}`;
        }
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
        let crest = 0;
        for (const p of outer) crest = Math.max(crest, groundAt(p));
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
        const shrunk: Pt[][] = [];
        for (let r = 0; r < rings.length; r++) {
          const source = rings[r];
          const sign = (signedArea(source) > 0 ? 1 : -1) * (r === 0 ? 1 : -1);
          const ring = insetRing(source, sign, inset);
          shrunk.push(ring);
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            if (onBorder(source[i], source[(i + 1) % source.length], extent)) continue;
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
              // one quad per wall; windows are drawn by the shader from the grid
              const grid = windowGrid(length, base, top, recipe);
              chunk.grid = grid ? [grid.n, grid.m, grid.step, grid.rowStep, grid.w, grid.h] : [0, 0, 0, 0, 0, 0];
              const u0 = grid ? (0 - grid.u0) / grid.step : 0;
              const u1 = grid ? (length - grid.u0) / grid.step : 0;
              const v0 = grid ? (base - 1 - grid.v0) / grid.rowStep : 0;
              const v1 = grid ? (top - grid.v0) / grid.rowStep : 0;
              chunk.quad(ax, az, bx, bz, base - 1, top, nx, nz, wall, u1, v0, v1, glassIndex, true, g, u0);
              chunk.grid = [0, 0, 0, 0, 0, 0];
              // roof lip (parapet) in roof colour, a hair outside the wall
              const lip = 0.08 * toMerc;
              chunk.quad(ax + nx * lip, az + nz * lip, bx + nx * lip, bz + nz * lip, top, top + ROOF_LIP, nx, nz, roof, 0, 0, 0, glassIndex, false, [crest, crest, crest, crest]);
              continue;
            }
            const textured = hasWindows && length >= 1.55;
            if (!textured) {
              chunk.quad(ax, az, bx, bz, base - 1, top, nx, nz, wall, 0, 0, 0, glassIndex, false, g);
              continue;
            }
            const bays = length >= 3.4 ? Math.max(1, Math.round(length / BAY)) : 0;
            // walls hang from the crest; the lower band reaches down to the sloped ground
            chunk.quad(ax, az, bx, bz, base - 1, body0, nx, nz, wall, 0, 0, 0, glassIndex, false, g);
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

        // Flat roof.
        const flat: number[] = [];
        const holes: number[] = [];
        for (let r = 0; r < shrunk.length; r++) {
          if (r > 0) holes.push(flat.length / 2);
          for (const p of shrunk[r]) flat.push(p[0] * k, p[1] * k);
        }
        const triangles = earcut(flat, holes, 2);
        const capY = recipe ? top + ROOF_LIP : top;
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
        if (recipe) {
          // footprint in meters around the building centre (x east, z south), like CityBuildings
          const points: RoofPoint[] = outer.map((p) => ({ x: (p[0] * k - chunk.cx) * metersScale, z: (p[1] * k - chunk.cz) * metersScale }));
          const pitched = recipe.roofKind !== 'flat' && canPitch(simplifyRing(points));
          const ridge = pitched ? buildRoof(points, top + ROOF_LIP - 0.04, recipe.roofKind as 'gable' | 'hip' | 'tile') : null;
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
        }
      }
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
  };
  stats.bytes += footprints.coords.byteLength + footprints.ringStart.byteLength + footprints.buildingStart.byteLength + footprints.bounds.byteLength;
  return { tile, corner, metersScale, chunks, footprints, accents: { chimney: chimneys.done(), vent: vents.done() }, stats };
}

/** Typed arrays to hand to postMessage as transferables. */
export function transferables(data: TileData): ArrayBuffer[] {
  const f = data.footprints;
  const out: ArrayBuffer[] = [f.coords.buffer, f.ringStart.buffer, f.buildingStart.buffer, f.bounds.buffer, f.heights.buffer] as ArrayBuffer[];
  for (const set of [data.accents.chimney, data.accents.vent]) out.push(set.matrices.buffer as ArrayBuffer, set.ground.buffer as ArrayBuffer, set.colors!.buffer as ArrayBuffer);
  for (const c of data.chunks) {
    out.push(c.positions.buffer as ArrayBuffer, c.normals.buffer as ArrayBuffer, c.colors.buffer as ArrayBuffer,
      c.facade.buffer as ArrayBuffer, c.ground.buffer as ArrayBuffer, c.center.buffer as ArrayBuffer, c.index.buffer as ArrayBuffer,
      c.win.buffer as ArrayBuffer, c.winSize.buffer as ArrayBuffer,
      c.windows.offsets.buffer as ArrayBuffer, c.windows.axes.buffer as ArrayBuffer);
  }
  return out;
}
