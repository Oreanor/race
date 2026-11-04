// Vegetation of one tile, planned once and completely in the tile worker.
// Same planting rules and tree shapes as rendering/VegetationLayer, but no plant
// cap, no distance bands and no re-planting while driving: a tile's trees exist
// from the moment the tile arrives (beyond the fog) and never change after.

import { planParkFences, planVegetation, type VegetationInput } from '../../game/Vegetation.ts';
import type { MapFeature } from '../../game/WaterCollisionController.ts';
import { latFromMercator, lngFromMercator, mercatorX, mercatorY } from '../mercator.ts';

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
  /** 0: round (icosahedron), 1: soft (sphere), 2: conifer (cone) */
  leaves: InstanceSet[];
  posts: InstanceSet;
  rails: InstanceSet;
};

const GREENS = ['#619447', '#7da653', '#53875a', '#8eaf64', '#689f76', '#3d6b3a', '#4e7d42', '#2f5c34'];
const FENCE_POST_H = 1.28;
const POST_STEP = 2.15;

function linear(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  const f = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return [f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)];
}
const GREEN_LINEAR = GREENS.map(linear);

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
  const plants = drain(planVegetation(input));
  const trunks = new Instances();
  const leaves = [new Instances(), new Instances(), new Instances()];
  const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < span && z < span;

  for (const plant of plants) {
    const x = mercatorX(plant.position[0]) - corner[0];
    const z = corner[1] - mercatorY(plant.position[1]);
    if (!inside(x, z)) continue; // the neighbour tile owns it
    const ground = groundAt(x, z);
    const s = 0.8 + plant.seed * 0.45;
    const tall = plant.seed > 0.7;
    const height = plant.bush ? 1.5 * s : (tall ? 7.2 : 5.6) * s;
    const radius = plant.bush ? 1.6 * s : (plant.variant === 1 ? 2.7 : 2.2) * s;
    const yaw = plant.seed * Math.PI * 2;
    if (!plant.bush) trunks.push(x, height * 0.3, z, yaw, s * toMerc, height * 0.6, s * toMerc, ground);
    const lobes = plant.bush ? 1 : plant.variant === 1 ? 2 : plant.variant === 2 ? 3 : 1;
    const species = plant.bush ? 0 : plant.variant;
    const base = GREEN_LINEAR[Math.floor(plant.seed * GREENS.length)];
    for (let lobe = 0; lobe < lobes; lobe++) {
      const angle = plant.seed * 6.28 + lobe * 2.5;
      const spread = lobe === 0 ? 0 : radius * 0.38;
      const shade = lobe === 0 ? 1.06 : 0.96;
      leaves[species].push(
        x + Math.cos(angle) * spread * toMerc,
        height * (plant.bush ? 0.75 : 0.7) + (lobe === 0 ? radius * 0.25 : 0),
        z + Math.sin(angle) * spread * toMerc,
        yaw,
        radius * (lobe === 0 ? 1 : 0.82) * toMerc,
        plant.variant === 2 && !plant.bush ? height * 0.34 : radius * (tall && !plant.bush ? 1.4 : 0.92),
        radius * (lobe === 0 ? 0.95 : 0.82) * toMerc,
        ground,
        [base[0] * shade, base[1] * shade, base[2] * shade],
      );
    }
  }

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
  return { trunks: trunks.done(), leaves: leaves.map((l) => l.done(true)), posts: posts.done(), rails: rails.done() };
}

export function vegetationTransferables(v: VegetationData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const set of [v.trunks, ...v.leaves, v.posts, v.rails]) {
    out.push(set.matrices.buffer as ArrayBuffer, set.ground.buffer as ArrayBuffer);
    if (set.colors) out.push(set.colors.buffer as ArrayBuffer);
  }
  return out;
}
