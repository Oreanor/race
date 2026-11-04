// Everything one z14 tile contributes to the world, built off the main thread:
// terrain mesh, a ground raster (landuse / landcover / park / water), road
// ribbons draped on the same DEM, far-building chunks and GeoJSON features for
// gameplay. Raw PBF bytes are kept too, so any other layer (poi, housenumber,
// place, mountain_peak, names…) can be decoded later for visualisation.

import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { buildTile, transferables as buildingTransferables, type TileData } from './buildTile.ts';
import { buildGround, groundTransferables, type GroundData } from './groundVector.ts';
import { latFromMercator, tileCorner, tileSpan, type TileId } from '../mercator.ts';
import { buildVegetation, vegetationTransferables, type VegetationData } from './vegetationTile.ts';
import { roadStyle } from './roadStyle.ts';
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
  /** bridge decks: x0, z0, x1, z1, half width, deck height (tile-local mercator meters, m) */
  bridges: Float32Array;
  roads: MeshData;
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

/** Deck height if (x, z) lies on a bridge, else null. */
export function bridgeDeck(bridges: Float32Array, x: number, z: number): number | null {
  let deck: number | null = null;
  for (let i = 0; i < bridges.length; i += 6) {
    const ax = bridges[i], az = bridges[i + 1], bx = bridges[i + 2], bz = bridges[i + 3], half = bridges[i + 4];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= half * 1.4) deck = Math.max(deck ?? -Infinity, bridges[i + 5]);
  }
  return deck;
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
  constructor(groundAt: (x: number, z: number) => number) { this.groundAt = groundAt; }

  private vertex(x: number, y: number, z: number, rgb: [number, number, number]) {
    this.positions.push(x, y, z);
    this.ground.push(this.groundAt(x, z));
    this.colors.push(rgb[0], rgb[1], rgb[2]);
    return this.positions.length / 3 - 1;
  }

  /** Straight ribbon a→b, `half` wide on each side, subdivided to follow terrain. */
  segment(ax: number, az: number, bx: number, bz: number, half: number, y: number, rgb: [number, number, number], step: number) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const nx = -dz / len * half, nz = dx / len * half;
    const parts = Math.max(1, Math.ceil(len / step));
    let prevL = -1, prevR = -1;
    for (let i = 0; i <= parts; i++) {
      const t = i / parts;
      const x = ax + dx * t, z = az + dz * t;
      const l = this.vertex(x + nx, y, z + nz, rgb);
      const r = this.vertex(x - nx, y, z - nz, rgb);
      if (prevL >= 0) this.index.push(prevL, l, prevR, prevR, l, r); // CCW seen from above
      prevL = l; prevR = r;
    }
  }

  /** Round join / cap. */
  disc(x: number, z: number, radius: number, y: number, rgb: [number, number, number], steps = 8) {
    const centre = this.vertex(x, y, z, rgb);
    const first = this.positions.length / 3;
    for (let i = 0; i < steps; i++) {
      const a = i / steps * Math.PI * 2;
      this.vertex(x + Math.cos(a) * radius, y, z + Math.sin(a) * radius, rgb);
    }
    for (let i = 0; i < steps; i++) {
      const a = first + i, b = first + (i + 1) % steps;
      this.index.push(centre, b, a);
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

function roadMesh(vt: VectorTile, span: number, metersScale: number, groundAt: (x: number, z: number) => number, bridges: number[]): MeshData {
  const builder = new RoadBuilder(groundAt);
  // streams, canals, ditches: thin water ribbons (rivers come as water polygons)
  const ways = vt.layers.waterway;
  if (ways) {
    const k = span / ways.extent;
    const toMerc = 1 / metersScale;
    const rgb = hex('#4aa9c4');
    for (let i = 0; i < ways.length; i++) {
      const f = ways.feature(i);
      if (f.type !== 2 || f.properties.brunnel === 'tunnel') continue;
      const cls = String(f.properties.class ?? '');
      if (cls === 'river') continue;
      const half = (cls === 'canal' ? 4 : 1.3) * toMerc;
      for (const line of f.loadGeometry()) for (let j = 0; j + 1 < line.length; j++) {
        const c = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, ways.extent);
        if (c) builder.segment(c[0] * k, c[1] * k, c[2] * k, c[3] * k, half, 0.04, rgb, 10 * toMerc);
      }
    }
  }
  const layer = vt.layers.transportation;
  if (layer) {
    const k = span / layer.extent;
    const toMerc = 1 / metersScale;
    // casings first (lower), then fills, each a flat ribbon slightly above ground
    for (const pass of ['casing', 'fill'] as const) {
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        if (feature.type !== 2) continue;
        const p = feature.properties;
        if (p.brunnel === 'tunnel') continue;
        const style = roadStyle(String(p.class ?? ''), String(p.subclass ?? ''), Number(p.ramp) === 1);
        if (!style) continue;
        const half = (style.width / 2 + (pass === 'casing' ? 0.18 : 0)) * toMerc;
        const y = style.lift + (pass === 'fill' ? 0.03 : 0);
        const rgb = hex(pass === 'fill' ? style.fill : style.casing);
        // Round joins only where the line actually bends (or ends); straight runs
        // and gentle curves need none. Narrow paths get cheaper discs.
        const steps = style.width < 2 ? 6 : 8;
        const isBridge = p.brunnel === 'bridge';
        for (const line of feature.loadGeometry()) {
          // bridges: one flat deck at the height of their banks, never down into the river
          if (isBridge && line.length > 1) {
            const a = line[0], z = line[line.length - 1];
            const deck = Math.max(groundAt(a.x * k, a.y * k), groundAt(z.x * k, z.y * k)) + 0.5;
            builder.groundAt = () => deck;
            if (pass === 'fill') for (let j = 0; j + 1 < line.length; j++) bridges.push(line[j].x * k, line[j].y * k, line[j + 1].x * k, line[j + 1].y * k, half, deck);
          } else builder.groundAt = groundAt;
          for (let j = 0; j + 1 < line.length; j++) {
            const c = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, layer.extent);
            if (!c) continue;
            const [ax, az, bx, bz] = [c[0] * k, c[1] * k, c[2] * k, c[3] * k];
            builder.segment(ax, az, bx, bz, half, y, rgb, 10 * toMerc);
            const startsHere = c[0] === line[j].x && c[1] === line[j].y;
            if (!startsHere) continue;
            if (j === 0) { builder.disc(ax, az, half, y, rgb, steps); continue; }
            const p = line[j - 1], q = line[j], r = line[j + 1];
            const ux = q.x - p.x, uy = q.y - p.y, vx = r.x - q.x, vy = r.y - q.y;
            const cos = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
            if (cos < 0.97) builder.disc(ax, az, half, y, rgb, steps);
          }
          const last = line.length - 1;
          if (last > 0) {
            const e = line[last];
            if (e.x >= 0 && e.y >= 0 && e.x <= layer.extent && e.y <= layer.extent) builder.disc(e.x * k, e.y * k, half, y, rgb, steps);
          }
        }
        builder.groundAt = groundAt;
      }
    }
  }
  return {
    positions: new Float32Array(builder.positions),
    ground: new Float32Array(builder.ground),
    colors: new Uint8Array(builder.colors),
    index: new Uint32Array(builder.index),
  };
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
  const bridgeList: number[] = [];
  const roads = roadMesh(vt, span, metersScale, groundAt, bridgeList);
  const bridges = new Float32Array(bridgeList);
  // on a bridge the surface is the deck
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
    buildings: buildTile(vt, tile, { chunks: options.chunks, windows: false, dem, inset: options.inset, legacyColors: true, detailed: { region: options.region } }),
    vegetation: buildVegetation(corner, span, metersScale, features as unknown as Record<string, MapFeature[]>, surfaceAt),
    features,
    layers: Object.keys(vt.layers),
    raw: buffer,
  };
}

export function worldTransferables(data: WorldTileData): ArrayBuffer[] {
  const out = [...buildingTransferables(data.buildings), ...vegetationTransferables(data.vegetation)];
  out.push(...groundTransferables(data.ground), data.bridges.buffer as ArrayBuffer);
  for (const mesh of [data.roads]) {
    out.push(mesh.positions.buffer as ArrayBuffer, mesh.ground.buffer as ArrayBuffer, mesh.index.buffer as ArrayBuffer);
    if (mesh.colors) out.push(mesh.colors.buffer as ArrayBuffer);
    if (mesh.uvs) out.push(mesh.uvs.buffer as ArrayBuffer);
  }
  if (data.dem) out.push(data.dem.buffer as ArrayBuffer);
  out.push(data.raw);
  return out;
}
