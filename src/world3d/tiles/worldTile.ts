// Everything one z14 tile contributes to the world, built off the main thread:
// terrain mesh, a ground raster (landuse / landcover / park / water), road
// ribbons draped on the same DEM, far-building chunks and GeoJSON features for
// gameplay. Raw PBF bytes are kept too, so any other layer (poi, housenumber,
// place, mountain_peak, names…) can be decoded later for visualisation.

import { PbfReader } from 'pbf';
import { VectorTile, type VectorTileLayer } from '@mapbox/vector-tile';
import { buildTile, transferables as buildingTransferables, type TileData } from './buildTile.ts';
import { DEM_SIZE, sampleDem } from './dem.ts';
import { latFromMercator, tileCorner, tileSpan, type TileId } from '../mercator.ts';
import { buildVegetation, vegetationTransferables, type VegetationData } from './vegetationTile.ts';
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
  terrain: MeshData;
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

// ---- ground raster ---------------------------------------------------------

const BACKGROUND = '#dcdad3';
const GREEN = '#b1d59b';
const WOOD = '#69a577';
const WATER = '#52b8ca';
const WATERWAY = '#369fb7';

function landColor(layer: string, cls: string, sub: string) {
  if (layer === 'park') return GREEN;
  if (layer === 'landcover') {
    if (cls === 'wood') return WOOD;
    if (cls === 'sand') return '#efe3c2';
    if (cls === 'rock') return '#d6d2c8';
    if (cls === 'ice') return '#f3f6f6';
    if (cls === 'wetland') return '#a9cfa6';
    return GREEN; // grass, farmland, …
  }
  if (/park|grass|cemetery|pitch|playground|garden/.test(cls) || /park|garden/.test(sub)) return GREEN;
  if (/residential|neighbourhood|suburb|quarter/.test(cls)) return '#e5e2da';
  if (/school|hospital|university|college|kindergarten|library/.test(cls)) return '#f8dfda';
  if (/commercial|retail|industrial|railway|military/.test(cls)) return '#e3e0d8';
  if (/stadium|track/.test(cls)) return '#d5d3c9';
  return null;
}

type Ctx = OffscreenCanvasRenderingContext2D;

function tracePolygon(ctx: Ctx, layer: VectorTileLayer, index: number, scale: number) {
  const rings = layer.feature(index).loadGeometry();
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((p, i) => (i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
    ctx.closePath();
  }
}

/** Paints the flat ground layers into a canvas covering exactly the tile. */
export function paintGround(ctx: Ctx, size: number, vt: VectorTile, metersScale: number, span: number) {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, size, size);
  const passes: [string, (p: Record<string, unknown>) => string | null][] = [
    ['landuse', (p) => landColor('landuse', String(p.class ?? ''), String(p.subclass ?? ''))],
    ['landcover', (p) => landColor('landcover', String(p.class ?? ''), String(p.subclass ?? ''))],
    ['park', () => GREEN],
    ['water', (p) => (p.class === 'swimming_pool' ? '#7fd0de' : WATER)],
  ];
  for (const [name, color] of passes) {
    const layer = vt.layers[name];
    if (!layer) continue;
    const scale = size / layer.extent;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (feature.type !== 3) continue;
      const fill = color(feature.properties);
      if (!fill) continue;
      ctx.fillStyle = fill;
      tracePolygon(ctx, layer, i, scale);
      ctx.fill('evenodd');
    }
  }
  // Roads in the raster too: far tiles draw only this (no ribbon geometry).
  const roads = vt.layers.transportation;
  if (roads) {
    const scale = size / roads.extent;
    const pxPerMeter = size / (span * metersScale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of ['casing', 'fill'] as const) {
      for (let i = 0; i < roads.length; i++) {
        const feature = roads.feature(i);
        if (feature.type !== 2 || feature.properties.brunnel === 'tunnel') continue;
        const style = roadStyle(String(feature.properties.class ?? ''), String(feature.properties.subclass ?? ''), Number(feature.properties.ramp) === 1);
        if (!style) continue;
        ctx.strokeStyle = pass === 'fill' ? style.fill : style.casing;
        ctx.lineWidth = Math.max(0.8, (style.width + (pass === 'casing' ? 0.36 : 0)) * pxPerMeter);
        ctx.beginPath();
        for (const line of feature.loadGeometry()) line.forEach((p, j) => (j ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
        ctx.stroke();
      }
    }
  }
  const waterway = vt.layers.waterway;
  if (waterway) {
    const scale = size / waterway.extent;
    const pxPerMeter = size / (span * metersScale);
    ctx.strokeStyle = WATERWAY;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < waterway.length; i++) {
      const feature = waterway.feature(i);
      if (feature.type !== 2 || feature.properties.brunnel === 'tunnel') continue;
      const cls = String(feature.properties.class ?? '');
      ctx.lineWidth = Math.max(1, (cls === 'river' ? 14 : cls === 'canal' ? 8 : 2.5) * pxPerMeter);
      ctx.beginPath();
      for (const line of feature.loadGeometry()) line.forEach((p, j) => (j ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
      ctx.stroke();
    }
  }
}

// ---- terrain mesh ----------------------------------------------------------

function terrainMesh(span: number, grid: number, dem: Float32Array | null): MeshData {
  const n = grid + 1;
  const skirt = 4 * n; // one extra vertex per edge vertex, hanging down
  const positions = new Float32Array((n * n + skirt) * 3);
  const ground = new Float32Array(n * n + skirt);
  const uvs = new Float32Array((n * n + skirt) * 2);
  const index: number[] = [];
  const height = (u: number, v: number) => dem ? sampleDem(dem, u * DEM_SIZE, v * DEM_SIZE) : 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    const u = i / grid, v = j / grid;
    positions.set([u * span, 0, v * span], k * 3);
    ground[k] = height(u, v);
    uvs.set([u, v], k * 2);
  }
  for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    // CCW seen from +Y (x right, z down the screen when looking from above)
    index.push(a, c, b, b, c, d);
  }
  // Skirts hide hairline cracks where neighbouring tiles sample their own DEM edge.
  let s = n * n;
  const edges: number[][] = [
    Array.from({ length: n }, (_, i) => i),
    Array.from({ length: n }, (_, i) => (n - 1) * n + (n - 1 - i)),
    Array.from({ length: n }, (_, j) => (n - 1 - j) * n),
    Array.from({ length: n }, (_, j) => j * n + n - 1),
  ];
  for (const edge of edges) {
    const first = s;
    for (const k of edge) {
      positions.set([positions[k * 3], -6, positions[k * 3 + 2]], s * 3);
      ground[s] = ground[k];
      uvs.set([uvs[k * 2], uvs[k * 2 + 1]], s * 2);
      s++;
    }
    for (let t = 0; t < n - 1; t++) {
      const a = edge[t], b = edge[t + 1], c = first + t, d = first + t + 1;
      index.push(a, b, c, b, d, c, a, c, b, b, c, d); // both windings: skirts are seen from either side
    }
  }
  return { positions, ground, uvs, index: new Uint32Array(index) };
}

// ---- roads -----------------------------------------------------------------

type RoadStyle = { width: number; fill: string; casing: string; lift: number };

/**
 * Widths match what MapLibre drew at the chase zoom (paintCity: rank × pavement
 * × zoom factor, ≈ 25.6 px/m at zoom 20.55), so the city reads the same.
 */
function roadStyle(cls: string, sub: string, ramp: boolean): RoadStyle | null {
  if (/^(rail|transit|ferry|aerialway|pier|bridge|bus_guideway|raceway)$/.test(cls)) return null;
  const pedestrian = cls === 'path' || /pedestrian|footway|cycleway|steps|path|platform/.test(sub);
  const major = /motorway|trunk|primary/.test(cls);
  const link = ramp || /service|track/.test(cls);
  const rank = pedestrian ? 0.5 : major ? 1.45 : link ? 0.82 : 1;
  const pavement = pedestrian ? 2.1 : 5;
  const width = rank * pavement * 0.84;
  const fill = pedestrian ? '#c4c1ba' : major ? '#9d9e99' : /secondary|tertiary/.test(cls) ? '#aaaba5' : '#b5b5af';
  const casing = pedestrian ? '#d5d0c6' : major ? '#d2cec5' : /secondary|tertiary/.test(cls) ? '#d6d2c9' : '#dbd7ce';
  return { width, fill, casing, lift: pedestrian ? 0.05 : major ? 0.12 : 0.09 };
}

function hex(color: string): [number, number, number] {
  const v = Number.parseInt(color.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

class RoadBuilder {
  positions: number[] = [];
  ground: number[] = [];
  colors: number[] = [];
  index: number[] = [];

  private groundAt: (x: number, z: number) => number;
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

function roadMesh(vt: VectorTile, span: number, metersScale: number, groundAt: (x: number, z: number) => number): MeshData {
  const builder = new RoadBuilder(groundAt);
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
        for (const line of feature.loadGeometry()) {
          for (let j = 0; j + 1 < line.length; j++) {
            const c = clipSegment(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y, layer.extent);
            if (!c) continue;
            const [ax, az, bx, bz] = [c[0] * k, c[1] * k, c[2] * k, c[3] * k];
            builder.segment(ax, az, bx, bz, half, y, rgb, 24 * toMerc);
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
  const groundAt = (x: number, z: number) => dem ? sampleDem(dem, x / span * DEM_SIZE, z / span * DEM_SIZE) : 0;

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
    terrain: terrainMesh(span, options.grid, dem),
    roads: roadMesh(vt, span, metersScale, groundAt),
    buildings: buildTile(vt, tile, { chunks: options.chunks, windows: false, dem, inset: options.inset, legacyColors: true, detailed: { region: options.region } }),
    vegetation: buildVegetation(corner, span, metersScale, features as unknown as Record<string, MapFeature[]>, groundAt),
    features,
    layers: Object.keys(vt.layers),
    raw: buffer,
  };
}

export function worldTransferables(data: WorldTileData): ArrayBuffer[] {
  const out = [...buildingTransferables(data.buildings), ...vegetationTransferables(data.vegetation)];
  for (const mesh of [data.terrain, data.roads]) {
    out.push(mesh.positions.buffer as ArrayBuffer, mesh.ground.buffer as ArrayBuffer, mesh.index.buffer as ArrayBuffer);
    if (mesh.colors) out.push(mesh.colors.buffer as ArrayBuffer);
    if (mesh.uvs) out.push(mesh.uvs.buffer as ArrayBuffer);
  }
  if (data.dem) out.push(data.dem.buffer as ArrayBuffer);
  out.push(data.raw);
  return out;
}
