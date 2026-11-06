// Everything one z14 tile contributes to the world, built off the main thread:
// terrain mesh, a ground raster (landuse / landcover / park / water), road
// ribbons draped on the same DEM, far-building chunks and GeoJSON features for
// gameplay. Raw PBF bytes are kept too, so any other layer (poi, housenumber,
// place, mountain_peak, names…) can be decoded later for visualisation.

import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { buildTile, transferables as buildingTransferables, type TileData } from './buildTile.ts';
import { buildGround, clipHalf, groundTransferables, type GroundData } from './groundVector.ts';

type Pt = [number, number];
import { latFromMercator, tileCorner, tileSpan, type TileId } from '../mercator.ts';
import { buildVegetation, vegetationTransferables, type VegetationData } from './vegetationTile.ts';
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
  dem: Float32Array | null;
  chunks: number;
  inset: number;
  /** terrain grid cells per tile edge */
  grid: number;
  /** country: biases building styles like the old detailed layer */
  region: string;
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
export const BRIDGE_STRIDE = 7;

/** Deck height if (x, z) lies on a bridge, else null. */
export function bridgeDeck(bridges: Float32Array, x: number, z: number): number | null {
  let deck: number | null = null;
  for (let i = 0; i < bridges.length; i += BRIDGE_STRIDE) {
    const ax = bridges[i], az = bridges[i + 1], bx = bridges[i + 2], bz = bridges[i + 3], half = bridges[i + 4];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    // only slightly wider than the ribbon — a parallel lower road must not snap to the deck
    if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= half * 1.08) deck = Math.max(deck ?? -Infinity, bridges[i + 5] + (bridges[i + 6] - bridges[i + 5]) * t);
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

/** Liang–Barsky: clip segment to the tile square, so neighbours never overlap. */
function clipSegment(ax: number, ay: number, bx: number, by: number, extent: number): [number, number, number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax, extent - ax, ay, extent - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
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
type Way = { lines: XY[][]; bridge: boolean; level: number; /** paths, steps, platforms: nothing to clear over */ foot: boolean };

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
  // a slight camber over water, just for the look
  const wet = water.some((w) => w != null);
  const hump = wet ? Math.min(0.8, meters * 0.015) : 0;
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
  // never under the ground: a straight line between the ends dips into any rise between
  // them (a hump, a bank higher than the ends), and the road beside it tears; there it
  // runs on the ground like a causeway
  for (let i = 0; i < h.length; i++) h[i] = Math.max(h[i], at.driveAt(pts[i][0], pts[i][1]) + 0.05);
  return { pts, s, h, bed, length };
}

/** A deck cut to the tile square [0, span]²: the pieces inside, heights carried over. */
function clipDeck(deck: Deck, span: number, at: Surfaces): Deck[] {
  const out: Deck[] = [];
  let cur: Deck | null = null;
  for (let i = 1; i < deck.pts.length; i++) {
    const [ax, az] = deck.pts[i - 1], [bx, bz] = deck.pts[i];
    const c = clipSegment(ax, az, bx, bz, span);
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

/** Roads and railways of the tile, by feature index (tunnels left out). */
export function transportWays(layer: VectorTile['layers'][string]): Map<number, Way> {
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
export function planBridges(ways: Map<number, Way>, extent: number, span: number, at: Surfaces): Map<number, Planned> {
  const k = span / extent;
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
          if (o === i || other.level >= way.level || other.foot) continue;
          for (const ol of other.lines) {
            const ob = boxes.get(ol)!;
            if (ob[0] > box[2] || ob[2] < box[0] || ob[1] > box[3] || ob[3] < box[1]) continue;
            if (ol.some((q) => mine.has(key(q)))) continue; // joined to the bridge, not under it
            for (let a = 0; a + 1 < line.length; a++) for (let b = 0; b + 1 < ol.length; b++) {
              const t = crossing(line[a], line[a + 1], ol[b], ol[b + 1]);
              if (t == null) continue;
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
  const plan = new Map<number, Planned>();
  for (const [i, decks] of full) plan.set(i, { decks: decks.flatMap((d) => clipDeck(d, span, at)), rest: [] });
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
          planned.decks.push(...clipDeck(deck, span, at));
        } else planned.rest.push(run.map(([x, z]) => ({ x: x / k, y: z / k })));
        start = n;
      }
    }
    if (ramped) plan.set(i, planned);
  }
  return plan;
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
    if (joints && i + 1 < deck.pts.length) builder.disc(bx, bz, half, y, rgb, joints);
  }
  builder.groundAt = saved;
}

/**
 * Stair towers at a footbridge's ends that hang in the air: a concrete box from the
 * ground up past the parapet. Ends cut by the tile border are not ends. `seen` keeps
 * one tower per spot where a bridge and its approach meet.
 */
function stairTowers(builder: RoadBuilder, deck: Deck, toMerc: number, span: number, seen: Set<string>) {
  const n = deck.pts.length;
  if (n < 2) return;
  const shade = (rgb: [number, number, number], f: number): [number, number, number] => [rgb[0] * f, rgb[1] * f, rgb[2] * f];
  const edge = 0.5 * toMerc;
  for (const [i, j] of [[0, 1], [n - 1, n - 2]]) {
    const [x, z] = deck.pts[i];
    if (x < edge || z < edge || x > span - edge || z > span - edge) continue;
    const h = deck.h[i], bed = deck.bed[i];
    if (h - bed < 2.2) continue;
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
 * The bridge itself where it stands clear of the ground: the slab's sides and
 * underside, a low parapet on each side and concrete piers down into the river.
 */
function deckStructure(builder: RoadBuilder, deck: Deck, half: number, toMerc: number) {
  const n = deck.pts.length;
  const up = deck.h.map((h, i) => h - deck.bed[i] > 1.2);
  const side = (nx: number, nz: number) => 0.7 + 0.2 * (nx * 0.6 + nz * 0.8);
  const shade = (rgb: [number, number, number], f: number): [number, number, number] => [rgb[0] * f, rgb[1] * f, rgb[2] * f];
  const wall = 0.3 * toMerc;
  for (let i = 1; i < n; i++) {
    if (!up[i - 1] && !up[i]) continue;
    const [ax, az] = deck.pts[i - 1], [bx, bz] = deck.pts[i];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    const ha = deck.h[i - 1], hb = deck.h[i];
    for (const sgn of [-1, 1]) {
      const ox = nx * half * sgn, oz = nz * half * sgn;
      const ix = nx * (half - wall) * sgn, iz = nz * (half - wall) * sgn;
      const f = side(nx * sgn, nz * sgn);
      // outer face: from under the slab to the parapet top
      builder.quad([[ax + ox, az + oz, ha, -SLAB], [bx + ox, bz + oz, hb, -SLAB], [bx + ox, bz + oz, hb, PARAPET], [ax + ox, az + oz, ha, PARAPET]], shade(CONCRETE, f));
      // parapet top and inner face
      builder.quad([[ax + ox, az + oz, ha, PARAPET], [bx + ox, bz + oz, hb, PARAPET], [bx + ix, bz + iz, hb, PARAPET], [ax + ix, az + iz, ha, PARAPET]], PARAPET_TOP, 'up');
      builder.quad([[ax + ix, az + iz, ha, PARAPET], [bx + ix, bz + iz, hb, PARAPET], [bx + ix, bz + iz, hb, 0.05], [ax + ix, az + iz, ha, 0.05]], shade(CONCRETE, 1.05 - f * 0.25));
    }
    // underside
    builder.quad([[ax + nx * half, az + nz * half, ha, -SLAB], [bx + nx * half, bz + nz * half, hb, -SLAB], [bx - nx * half, bz - nz * half, hb, -SLAB], [ax - nx * half, az - nz * half, ha, -SLAB]], UNDERSIDE, 'down');
  }
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

/** Register a deck for the car, piece by piece. */
function pushDeck(bridges: number[], deck: Deck, half: number) {
  for (let i = 1; i < deck.pts.length; i++) {
    bridges.push(deck.pts[i - 1][0], deck.pts[i - 1][1], deck.pts[i][0], deck.pts[i][1], half, deck.h[i - 1], deck.h[i]);
  }
}

/** A railway or tram line, or null for anything else. */
function railKind(p: Record<string, unknown>): { tram: boolean; gauge: number } | null {
  const sub = String(p.subclass ?? '');
  const tram = p.class === 'transit' && sub === 'tram';
  const rail = (p.class === 'rail' || p.class === 'transit') && /^(rail|narrow_gauge|light_rail|preserved|subway|funicular)$/.test(sub);
  if (!tram && !rail) return null;
  return { tram, gauge: sub === 'narrow_gauge' || sub === 'funicular' ? 0.5 : 0.72 };
}

/** Railway track: a gravel bed with two steel rails; trams get the rails only (in the street). */
function railTracks(builder: RoadBuilder, layer: VectorTile['layers'][string], k: number, at: Surfaces, bridges: number[], ways: Map<number, Way>, plan: Map<number, Planned>) {
  const toMerc = at.toMerc, groundAt = at.driveAt;
  const bed = hex('#9c958c');
  const steel = hex('#5f656b');
  for (const [i, way] of ways) {
    const kind = railKind(layer.feature(i).properties);
    if (!kind) continue;
    const { tram } = kind;
    const gauge = kind.gauge * toMerc;
    const planned = plan.get(i);
    for (const deck of planned?.decks ?? []) {
      const half = 2.1 * toMerc;
      deckStructure(builder, deck, half, toMerc);
      pushDeck(bridges, deck, half);
      if (!tram) deckRibbon(builder, deck, 1.5 * toMerc, 0.06, bed, 0);
      for (const sideSign of [-1, 1]) {
        for (let n = 1; n < deck.pts.length; n++) {
          const [ax, az] = deck.pts[n - 1], [bx, bz] = deck.pts[n];
          const len = Math.hypot(bx - ax, bz - az) || 1;
          const ox = -(bz - az) / len * gauge * sideSign, oz = (bx - ax) / len * gauge * sideSign;
          deckRibbon(builder, { pts: [[ax + ox, az + oz], [bx + ox, bz + oz]], h: [deck.h[n - 1], deck.h[n]] }, 0.05 * toMerc, tram ? 0.19 : 0.11, steel, 0);
        }
      }
    }
    for (const line of planned?.rest ?? way.lines) {
      for (let j = 0; j + 1 < line.length; j++) {
        const cut = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, layer.extent);
        if (!cut) continue;
        const [ax, az, bx, bz] = [cut[0] * k, cut[1] * k, cut[2] * k, cut[3] * k];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-9) continue;
        builder.groundAt = groundAt;
        const nx = -(bz - az) / len, nz = (bx - ax) / len;
        if (!tram) {
          builder.segment(ax, az, bx, bz, 1.5 * toMerc, 0.06, bed);
          if (j > 0) builder.disc(ax, az, 1.5 * toMerc, 0.06, bed, 8);
        }
        const y = tram ? 0.19 : 0.11;
        for (const side of [-1, 1]) {
          const ox = nx * gauge * side, oz = nz * gauge * side;
          builder.segment(ax + ox, az + oz, bx + ox, bz + oz, 0.05 * toMerc, y, steel);
        }
      }
    }
    builder.groundAt = groundAt;
  }
}

function roadMesh(vt: VectorTile, span: number, grid: number, at: Surfaces, bridges: number[], pitchLines: number[] = []): MeshData {
  const towerSpots = new Set<string>();
  const { driveAt, groundAt: bedAt } = at;
  const builder = new RoadBuilder(driveAt, span / grid, grid);
  // white pitch markings, painted on the ground under the roads' ribbons
  const chalk = hex('#f4f4ee');
  for (let i = 0; i < pitchLines.length; i += 5) builder.segment(pitchLines[i], pitchLines[i + 1], pitchLines[i + 2], pitchLines[i + 3], 0.06 * at.toMerc, 0.04, chalk);
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
    const plan = planBridges(ways, layer.extent, span, at);
    railTracks(builder, layer, k, at, bridges, ways, plan);
    // casings first (lower), then fills, each a flat ribbon slightly above ground
    for (const pass of ['casing', 'fill'] as const) {
      for (const [i, way] of ways) {
        const p = layer.feature(i).properties;
        const style = roadStyle(String(p.class ?? ''), String(p.subclass ?? ''), Number(p.ramp) === 1);
        if (!style) continue;
        const half = (style.width / 2 + (pass === 'casing' ? 0.18 : 0)) * toMerc;
        const y = style.lift + (pass === 'fill' ? 0.03 : 0);
        const rgb = hex(pass === 'fill' ? style.fill : style.casing);
        // Round joins only where the line actually bends (or ends); straight runs
        // and gentle curves need none. Narrow paths get cheaper discs.
        const steps = style.width < 2 ? 6 : 8;
        const planned = plan.get(i);
        for (const deck of planned?.decks ?? []) {
          if (pass === 'casing') {
            // the parapets stand just outside the pavement, on a concrete edge
            deckStructure(builder, deck, half + 0.35 * toMerc, toMerc);
            // footbridges: stair towers where an end hangs in the air
            if (style.width < 1.5) stairTowers(builder, deck, toMerc, span, towerSpots);
            deckRibbon(builder, deck, half + 0.35 * toMerc, y - 0.01, CONCRETE, 0);
          } else pushDeck(bridges, deck, half);
          deckRibbon(builder, deck, half, y, rgb, steps);
        }
        for (const line of planned?.rest ?? way.lines) {
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
            // sharp bends: a round join; gentle ones: just the outer wedge (no notch, no bulge)
            if (cos < 0.9) builder.disc(ax, az, half, y, rgb, steps);
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
  }
  return meshOf(builder);
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
  const roads = roadMesh(vt, span, options.grid, { driveAt, groundAt, waterAt, toMerc: 1 / metersScale }, bridgeList, furniture.lines);
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

  const features: Record<string, GeoFeature[]> = {};
  for (const name of GAMEPLAY_LAYERS) {
    const layer = vt.layers[name];
    const list: GeoFeature[] = [];
    if (layer) for (let i = 0; i < layer.length; i++) list.push(layer.feature(i).toGeoJSON(tile.x, tile.y, tile.z) as unknown as GeoFeature);
    features[name] = list;
  }
  return {
    tile,
    corner,
    metersScale,
    dem,
    ground,
    bridges,
    roads,
    streams,
    buildings: buildTile(vt, tile, { chunks: options.chunks, windows: false, dem, inset: options.inset, legacyColors: true, detailed: { region: options.region } }),
    vegetation: buildVegetation(corner, span, metersScale, features as unknown as Record<string, MapFeature[]>, surfaceAt, furniture),
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
