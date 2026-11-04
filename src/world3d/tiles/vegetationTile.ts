// Vegetation of one tile, planned once and completely in the tile worker.
// Same planting rules and tree shapes as rendering/VegetationLayer, but no plant
// cap, no distance bands and no re-planting while driving: a tile's trees exist
// from the moment the tile arrives (beyond the fog) and never change after.

import { planParkFences, planVegetation, type VegetationInput } from '../../game/Vegetation.ts';
import type { MapFeature } from '../../game/WaterCollisionController.ts';
import { latFromMercator, lngFromMercator, mercatorX, mercatorY } from '../mercator.ts';
import { planStreets } from './streetscape.ts';

export type InstanceSet = {
  count: number;
  /** column-major mat4 per instance, tile-local (mercator meters horizontally, meters up) */
  matrices: Float32Array;
  /** raw DEM height under each instance; the shader adds it × terrain exaggeration */
  ground: Float32Array;
  /** linear RGB per instance (leaves only) */
  colors?: Float32Array;
};

export type VegetationData = {
  trunks: InstanceSet;
  /** crowns: 0 broadleaf, 1 stone pine, 2 conifer, 3 shrub (see map/treeShapes) */
  leaves: InstanceSet[];
  posts: InstanceSet;
  rails: InstanceSet;
  /** street lamps (model in meters, arm along +X) */
  lamps: InstanceSet;
};

const GREENS = ['#619447', '#7da653', '#53875a', '#8eaf64', '#689f76', '#4e7d42', '#6f9a4a', '#5b8a3c'];
const PINES = ['#4d6b3a', '#5a7a40', '#466636', '#617f45'];
const FIRS = ['#2f5c34', '#3d6b3a', '#355e3b', '#2b5232'];
const SHRUBS = ['#6b9a4f', '#7da653', '#5f8f4a', '#86ab5c'];
// a few flowering broadleaves: jacaranda, pink blossom, golden crown
const BLOSSOMS: [number, string][] = [[0.05, '#9b7fd1'], [0.085, '#e59bb8'], [0.11, '#d4b84c']];
const FENCE_POST_H = 1.28;
const POST_STEP = 2.15;

function linear(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  const f = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return [f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)];
}
const pick = (list: string[], t: number) => linear(list[Math.min(list.length - 1, Math.floor(t * list.length))]);

class Instances {
  matrices: number[] = [];
  ground: number[] = [];
  colors: number[] = [];
  /** rotation about Y, scale, translation; sx/sz in mercator meters already */
  push(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, ground: number, rgb?: [number, number, number]) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.matrices.push(c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1);
    this.ground.push(ground);
    if (rgb) this.colors.push(rgb[0], rgb[1], rgb[2]);
  }
  done(withColors = false): InstanceSet {
    return {
      count: this.ground.length,
      matrices: new Float32Array(this.matrices),
      ground: new Float32Array(this.ground),
      colors: withColors ? new Float32Array(this.colors) : undefined,
    };
  }
}

function drain<T>(gen: Generator<null, T>): T {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

export function buildVegetation(
  corner: [number, number],
  span: number,
  metersScale: number,
  features: Record<string, MapFeature[]>,
  groundAt: (x: number, z: number) => number,
): VegetationData {
  const toMerc = 1 / metersScale;
  const center: [number, number] = [lngFromMercator(corner[0] + span / 2), latFromMercator(corner[1] - span / 2)];
  const landuse = features.landuse ?? [];
  const input: VegetationInput = {
    green: [...(features.landcover ?? []), ...landuse, ...(features.park ?? [])],
    obstacles: [
      ...(features.water ?? []),
      ...landuse.filter((f) => /^(pitch|playground|track|stadium|parking)$/.test(String(f.properties?.class ?? ''))),
      ...(features.building ?? []),
    ],
    roads: features.transportation ?? [],
    focus: center,
    origin: center,
    // cover the whole tile, keep every plant
    plantCap: Infinity,
    reachScale: (span * metersScale * Math.SQRT1_2 + 40) / 430,
    fenceReach: span * metersScale * Math.SQRT1_2 + 40,
  };
  // park and green-area planting stays free; street planting is done by planStreets
  const plants = drain(planVegetation(input)).filter((p) => !p.key.startsWith('r:'));
  const trunks = new Instances();
  const leaves = [new Instances(), new Instances(), new Instances(), new Instances()];
  const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < span && z < span;

  for (const plant of plants) {
    const x = mercatorX(plant.position[0]) - corner[0];
    const z = corner[1] - mercatorY(plant.position[1]);
    if (!inside(x, z)) continue; // the neighbour tile owns it
    const ground = groundAt(x, z);
    const s = 0.8 + plant.seed * 0.45;
    const yaw = plant.seed * Math.PI * 2;
    const t2 = (plant.seed * 97.31) % 1; // second independent-looking roll
    const lean = (t2 - 0.5) * 0.18;     // crowns are not all perfectly centred
    if (plant.bush) {
      leaves[3].push(x, 0, z, yaw, 1.7 * s * toMerc, 1.35 * s, 1.5 * s * toMerc, ground, pick(SHRUBS, t2));
      continue;
    }
    if (plant.variant === 1) {
      // stone pine: tall bare trunk, wide flat crown
      const trunk = (5.2 + t2 * 2.6) * s;
      trunks.push(x, trunk / 2, z, yaw, 1.15 * s * toMerc, trunk, 1.15 * s * toMerc, ground);
      leaves[1].push(x + lean * toMerc, trunk - 0.6 * s, z, yaw, 3.6 * s * toMerc, 2.1 * s, 3.4 * s * toMerc, ground, pick(PINES, t2));
    } else if (plant.variant === 2) {
      // conifer: short trunk, tall tiers
      const crown = (plant.seed > 0.7 ? 7.4 : 5.8) * s;
      trunks.push(x, 0.8 * s, z, yaw, 1.1 * s * toMerc, 1.6 * s, 1.1 * s * toMerc, ground);
      leaves[2].push(x, 0.9 * s, z, yaw, 2.1 * s * toMerc, crown, 2.1 * s * toMerc, ground, pick(FIRS, t2));
    } else {
      // broadleaf: visible trunk, clustered round crown; some in blossom
      const tall = plant.seed > 0.7;
      const trunk = (tall ? 3.1 : 2.4) * s;
      trunks.push(x, trunk / 2, z, yaw, s * toMerc, trunk, s * toMerc, ground);
      const blossom = BLOSSOMS.find(([chance]) => t2 < chance);
      const color = blossom ? linear(blossom[1]) : pick(GREENS, (plant.seed * 13.7) % 1);
      leaves[0].push(x + lean * toMerc, trunk * 0.72, z - lean * toMerc, yaw, 2.5 * s * toMerc, (tall ? 4.6 : 3.8) * s, 2.4 * s * toMerc, ground, color);
    }
  }

  // Planted streets: one species, size and colour per street, even spacing.
  const streets = planStreets(corner, span, metersScale, features);
  const lamps = new Instances();
  for (const p of streets.plants) {
    const ground = groundAt(p.x, p.z);
    const s = p.s;
    const tone = Math.min(0.999, (s - 0.9) / 0.25);
    switch (p.species) {
      case 'plane':
        trunks.push(p.x, 1.5 * s, p.z, p.yaw, 1.1 * s * toMerc, 3 * s, 1.1 * s * toMerc, ground);
        leaves[0].push(p.x, 2.4 * s, p.z, p.yaw, 2.6 * s * toMerc, 4.2 * s, 2.5 * s * toMerc, ground, pick(GREENS, tone));
        break;
      case 'jacaranda':
        trunks.push(p.x, 1.3 * s, p.z, p.yaw, s * toMerc, 2.6 * s, s * toMerc, ground);
        leaves[0].push(p.x, 2 * s, p.z, p.yaw, 2.6 * s * toMerc, 3.6 * s, 2.6 * s * toMerc, ground, linear('#9b7fd1'));
        break;
      case 'pine':
        trunks.push(p.x, 3 * s, p.z, p.yaw, 1.15 * s * toMerc, 6 * s, 1.15 * s * toMerc, ground);
        leaves[1].push(p.x, 5.5 * s, p.z, p.yaw, 3.4 * s * toMerc, 2 * s, 3.3 * s * toMerc, ground, pick(PINES, tone));
        break;
      case 'cypress':
        trunks.push(p.x, 0.4 * s, p.z, p.yaw, 0.9 * s * toMerc, 0.8 * s, 0.9 * s * toMerc, ground);
        leaves[2].push(p.x, 0.5 * s, p.z, p.yaw, 0.95 * s * toMerc, 8 * s, 0.95 * s * toMerc, ground, pick(FIRS, tone));
        break;
      case 'hedge':
        // one clipped section ~4 m long, overlapping the next: reads as a continuous hedge
        leaves[3].push(p.x, 0, p.z, p.yaw, 2.1 * toMerc, 1.15, 0.85 * toMerc, ground, linear('#5f8f4a'));
        break;
    }
  }
  for (const lamp of streets.lamps) lamps.push(lamp.x, 0, lamp.z, lamp.yaw, toMerc, 1, toMerc, groundAt(lamp.x, lamp.z));

  // Park fences: edges are in meters around the tile centre (x east, z south).
  const posts = new Instances();
  const rails = new Instances();
  for (const edge of drain(planParkFences(input))) {
    const ax = span / 2 + edge.ax * toMerc, az = span / 2 + edge.az * toMerc;
    const bx = span / 2 + edge.bx * toMerc, bz = span / 2 + edge.bz * toMerc;
    if (!inside((ax + bx) / 2, (az + bz) / 2)) continue;
    const lengthM = Math.hypot(edge.bx - edge.ax, edge.bz - edge.az);
    if (lengthM < 0.5) continue;
    const yaw = Math.atan2(edge.bx - edge.ax, edge.bz - edge.az) - Math.PI / 2;
    const count = Math.max(1, Math.ceil(lengthM / POST_STEP));
    let px = ax, pz = az, pg = groundAt(ax, az);
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const g = groundAt(x, z);
      posts.push(x, FENCE_POST_H * 0.5, z, yaw, toMerc, FENCE_POST_H, toMerc, g);
      if (i > 0) {
        const railM = lengthM / count;
        for (const lift of [0.38, 0.82]) rails.push((px + x) / 2, lift, (pz + z) / 2, yaw, railM * toMerc, 1, toMerc, (pg + g) / 2);
      }
      px = x; pz = z; pg = g;
    }
  }
  return { trunks: trunks.done(), leaves: leaves.map((l) => l.done(true)), posts: posts.done(), rails: rails.done(), lamps: lamps.done() };
}

export function vegetationTransferables(v: VegetationData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const set of [v.trunks, ...v.leaves, v.posts, v.rails, v.lamps]) {
    out.push(set.matrices.buffer as ArrayBuffer, set.ground.buffer as ArrayBuffer);
    if (set.colors) out.push(set.colors.buffer as ArrayBuffer);
  }
  return out;
}
