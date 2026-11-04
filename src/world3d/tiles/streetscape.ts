// Planted streets: avenue trees, hedges and street lamps along roads.
// A street is planted, not grown: one species per street with an even spacing,
// chosen per district and road class, so neighbouring streets match (a quarter
// of plane trees, another of stone pines, cypress rows, clipped hedges). Parks
// keep their free planting from game/Vegetation. Lamps stand closer to the kerb,
// half a step off the trees.

import type { MapFeature } from '../../game/WaterCollisionController.ts';
import { mercatorX, mercatorY } from '../mercator.ts';
import { isPedestrian, roadStyle } from './roadStyle.ts';

type Pt = [number, number];

export type StreetPlant = {
  /** tile-local mercator meters */
  x: number; z: number;
  species: 'plane' | 'pine' | 'cypress' | 'jacaranda' | 'hedge';
  /** size factor, the same along one street */
  s: number;
  yaw: number;
};
export type Lamp = { x: number; z: number; yaw: number };

type Style = { species: StreetPlant['species'] | null; spacing: number };

// district × road-class choice; weights per class group
// Most streets stay bare; planted ones are spaced generously (not a forest).
const TABLE: Record<'major' | 'mid' | 'minor', [number, Style][]> = {
  major: [[0.18, { species: 'plane', spacing: 26 }], [0.12, { species: 'pine', spacing: 34 }], [0.06, { species: 'jacaranda', spacing: 22 }], [0.09, { species: 'hedge', spacing: 3.4 }], [0.55, { species: null, spacing: 0 }]],
  mid: [[0.14, { species: 'plane', spacing: 24 }], [0.05, { species: 'jacaranda', spacing: 20 }], [0.08, { species: 'cypress', spacing: 15 }], [0.08, { species: 'hedge', spacing: 3.4 }], [0.65, { species: null, spacing: 0 }]],
  minor: [[0.05, { species: 'hedge', spacing: 3.4 }], [0.05, { species: 'plane', spacing: 28 }], [0.04, { species: 'cypress', spacing: 16 }], [0.86, { species: null, spacing: 0 }]],
};

function hash(a: number, b: number, salt: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ salt, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x27d4eb2d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function pickStyle(group: keyof typeof TABLE, roll: number): Style {
  let cursor = roll;
  for (const [w, style] of TABLE[group]) { cursor -= w; if (cursor <= 0) return style; }
  return TABLE[group][TABLE[group].length - 1][1];
}

/** Simple uniform grid over tile-local points/segments. */
class Grid<T> {
  private cells = new Map<string, T[]>();
  private size: number;
  constructor(size: number) { this.size = size; }
  private key(x: number, z: number) { return `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`; }
  addBox(x0: number, z0: number, x1: number, z1: number, item: T) {
    for (let gx = Math.floor(x0 / this.size); gx <= Math.floor(x1 / this.size); gx++)
      for (let gz = Math.floor(z0 / this.size); gz <= Math.floor(z1 / this.size); gz++) {
        const k = `${gx},${gz}`;
        const list = this.cells.get(k);
        if (list) list.push(item); else this.cells.set(k, [item]);
      }
  }
  at(x: number, z: number) { return this.cells.get(this.key(x, z)) ?? []; }
}

function insideRing(x: number, z: number, ring: Pt[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

function segmentDistance(x: number, z: number, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}

export function planStreets(
  corner: [number, number],
  span: number,
  metersScale: number,
  features: Record<string, MapFeature[]>,
): { plants: StreetPlant[]; lamps: Lamp[] } {
  const toMerc = 1 / metersScale;
  const local = (p: number[]): Pt => [mercatorX(p[0]) - corner[0], corner[1] - mercatorY(p[1])];
  const inTile = (x: number, z: number) => x >= 0 && z >= 0 && x < span && z < span;

  // obstacles: building and water outlines
  const blocks = new Grid<Pt[]>(40 * toMerc);
  for (const f of [...(features.building ?? []), ...(features.water ?? [])]) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates as number[][][]] : g.type === 'MultiPolygon' ? g.coordinates as number[][][][] : [];
    for (const poly of polys) {
      const ring = (poly[0] ?? []).map(local);
      if (ring.length < 3) continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of ring) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
      blocks.addBox(x0, z0, x1, z1, ring);
    }
  }

  // roads: lines with their half width (mercator meters)
  type Road = { line: Pt[]; half: number; cls: string; sub: string; bridge: boolean };
  const roads: Road[] = [];
  const segs = new Grid<{ a: Pt; b: Pt; half: number }>(30 * toMerc);
  for (const f of features.transportation ?? []) {
    const p = f.properties ?? {};
    if (p.brunnel === 'tunnel') continue;
    const cls = String(p.class ?? ''), sub = String(p.subclass ?? '');
    const style = roadStyle(cls, sub, Number(p.ramp) === 1);
    if (!style) continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates as number[][]] : g.type === 'MultiLineString' ? g.coordinates as number[][][] : [];
    for (const raw of lines) {
      const line = raw.map(local);
      const half = style.width / 2 * toMerc;
      roads.push({ line, half, cls, sub, bridge: p.brunnel === 'bridge' });
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        segs.addBox(Math.min(a[0], b[0]) - half, Math.min(a[1], b[1]) - half, Math.max(a[0], b[0]) + half, Math.max(a[1], b[1]) + half, { a, b, half });
      }
    }
  }

  const clear = (x: number, z: number, kerb: number, radius: number) => {
    for (const s of segs.at(x, z)) if (segmentDistance(x, z, s.a, s.b) < s.half + kerb) return false;
    for (const ring of blocks.at(x, z)) {
      if (insideRing(x, z, ring)) return false;
      for (const [dx, dz] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) if (insideRing(x + dx, z + dz, ring)) return false;
    }
    return true;
  };

  const plants: StreetPlant[] = [];
  const lamps: Lamp[] = [];
  const district = 360 * toMerc;
  for (const road of roads) {
    if (isPedestrian(road.cls, road.sub) || road.line.length < 2) continue;
    const group = /motorway|trunk|primary/.test(road.cls) ? 'major' : /secondary|tertiary/.test(road.cls) ? 'mid' : 'minor';
    const mid = road.line[Math.floor(road.line.length / 2)];
    const gx = Math.floor((corner[0] + mid[0]) / district), gz = Math.floor((corner[1] - mid[1]) / district);
    const style = road.bridge ? { species: null, spacing: 0 } : pickStyle(group, hash(gx, gz, group.length * 7919));
    const size = 0.9 + hash(gx, gz, 31) * 0.25; // one size per district
    // one side per street, wide steps; only half of the small streets are lit
    const lampStep = (group === 'major' ? 52 : group === 'mid' ? 60 : 68) * toMerc;
    const lampSides = group === 'minor' && hash(gx, gz, 11) < 0.5 ? [] : [hash(gx, gz, 5) < 0.5 ? 1 : -1];
    const treeOffset = road.half + (style.species === 'hedge' ? 1.1 : 2.6) * toMerc;
    const lampOffset = road.half + (road.bridge ? 0.35 : 0.8) * toMerc;
    const treeStep = style.spacing * toMerc;
    let walked = 0;
    for (let i = 1; i < road.line.length; i++) {
      const a = road.line[i - 1], b = road.line[i];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const ux = dx / len, uz = dz / len;
      // left normal in x east / z south
      const nx = uz, nz = -ux;
      const yaw = Math.atan2(ux, -uz);
      if (style.species && treeStep > 0) {
        for (let d = (treeStep - (walked % treeStep)) % treeStep; d < len; d += treeStep) {
          for (const side of [1, -1]) {
            const x = a[0] + ux * d + nx * treeOffset * side, z = a[1] + uz * d + nz * treeOffset * side;
            if (!inTile(x, z) || !clear(x, z, (style.species === 'hedge' ? 0.6 : 1.5) * toMerc, (style.species === 'hedge' ? 0.7 : 1.6) * toMerc)) continue;
            // hedge sections lie along the street (+X of the bush model = road direction)
            const along = Math.atan2(-uz, ux);
            plants.push({ x, z, species: style.species, s: size, yaw: style.species === 'hedge' ? along : yaw + hash(Math.round(x * 10), Math.round(z * 10), 3) * 6.28 });
          }
        }
      }
      // lamps half a tree step off, so they never stand in a trunk
      const offset = treeStep > 0 && style.species !== 'hedge' ? treeStep / 2 : 0;
      for (let d = ((lampStep - ((walked + offset) % lampStep)) % lampStep); d < len; d += lampStep) {
        for (const side of lampSides) {
          const x = a[0] + ux * d + nx * lampOffset * side, z = a[1] + uz * d + nz * lampOffset * side;
          if (!inTile(x, z) || !clear(x, z, 0.3 * toMerc, 0.4 * toMerc)) continue;
          // the arm reaches over the road: from the pole toward the centre line
          // lamp model: arm along +X; Y rotation by θ sends +X to (cos θ, −sin θ)
          lamps.push({ x, z, yaw: Math.atan2(nz * side, -nx * side) });
        }
      }
      walked += len;
    }
  }
  return { plants, lamps };
}
