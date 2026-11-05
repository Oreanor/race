// Vegetation of one tile, planned once and completely in the tile worker.
// Positions come from the park / green-area planting (game/Vegetation) and the
// street planting (streetscape); species from the place's climate preset
// (tiles/flora): parks and woods mix the preset's trees and understory, streets
// get its urban species, one per street. No plant cap and no re-planting:
// a tile's trees exist from the moment it arrives and never change after.

import { planParkFences, planVegetation, type VegetationInput } from '../../game/Vegetation.ts';
import type { MapFeature } from '../../game/WaterCollisionController.ts';
import { latFromMercator, lngFromMercator, mercatorX, mercatorY } from '../mercator.ts';
import { planStreets } from './streetscape.ts';
import type { Furniture } from './furniture.ts';
import { FLORA_MODELS, MODEL_HEIGHT, PRESETS, VARIANTS, pickMix, selectPreset, type FloraModel } from './flora.ts';

export type InstanceSet = {
  count: number;
  /** column-major mat4 per instance, tile-local (mercator meters horizontally, meters up) */
  matrices: Float32Array;
  /** raw DEM height under each instance; the shader adds it × terrain exaggeration */
  ground: Float32Array;
  /** linear RGB per instance (foliage) */
  colors?: Float32Array;
  /** flora only: linear bark RGB per instance */
  bark?: Float32Array;
  /** flora only: habit, autumn linear RGB per instance */
  traits?: Float32Array;
};

export type VegetationData = {
  /** trees and shrubs, one set per base shape in FLORA_MODELS order */
  flora: InstanceSet[];
  /** climate preset the tile was planted with */
  preset: string;
  posts: InstanceSet;
  rails: InstanceSet;
  /** street lamps (model in meters, arm along +X) */
  lamps: InstanceSet;
  /** statues on pedestals: the stone (square or long) and the bronze (a figure or a rider) */
  plinths: InstanceSet;
  plinthsLong: InstanceSet;
  figures: InstanceSet;
  riders: InstanceSet;
  /** fountains: the stone basin and column, the water */
  fountains: InstanceSet;
  fountainWater: InstanceSet;
  /** bus shelters: the frame, roof and bench; the glass */
  shelters: InstanceSet;
  shelterGlass: InstanceSet;
  /** football goals */
  goals: InstanceSet;
  /**
   * What a car cannot drive through (pedestals, basins, shelters), SOLID_STRIDE
   * floats each: x, z (tile-local mercator), ground, half width, half length (m), yaw, height (m)
   */
  solids: Float32Array;
  /**
   * Things gunfire or a car can knock over, FELL_STRIDE floats each: kind
   * (0 tree, 1 lamp), x, z (tile-local mercator), ground, top (m above ground),
   * instance, flora shape index (-1 for lamps), unused.
   */
  fell: Float32Array;
  /**
   * Street light on the ground, LAMP_MAP² texels over the tile (0..255): every lamp's
   * pool baked once, so at night all lamps shine at once and none switches on in view.
   */
  lampLight: Uint8Array;
};

/** texels per tile edge of the baked street light (≈3 m each) */
export const LAMP_MAP = 768;
/** floats per solid (see VegetationData.solids) */
export const SOLID_STRIDE = 7;

/** where the bronze stands on a monument's pedestal (m above the ground) */
export const MONUMENT_PLINTH_TOP = 2.7;
export const MONUMENT_PLINTH_LONG_TOP = 2.4;

/** radius of a lamp's pool of light on the street (m) */
const LAMP_POOL = 11;
/** the head hangs this far out over the road from the pole (m) */
export const LAMP_ARM = 1.42;

/**
 * Bake street light into `out` (LAMP_MAP² texels over a tile of `span` mercator m):
 * a soft pool under every head (tile-local mercator x, z pairs). Only the texels in
 * `region` [i0, j0, i1, j1] are written — the whole map in the worker, a patch
 * around one lamp when it is knocked down or stands up again.
 */
export function bakeLampLight(heads: ArrayLike<number>, span: number, metersScale: number, out: Uint8Array, region: [number, number, number, number] = [0, 0, LAMP_MAP - 1, LAMP_MAP - 1]) {
  const [ri0, rj0, ri1, rj1] = region;
  const w = ri1 - ri0 + 1;
  const light = new Float32Array(w * (rj1 - rj0 + 1));
  const texel = span / LAMP_MAP;
  const reach = LAMP_POOL / metersScale;
  for (let h = 0; h + 1 < heads.length; h += 2) {
    const hx = heads[h], hz = heads[h + 1];
    const i0 = Math.max(ri0, Math.floor((hx - reach) / texel)), i1 = Math.min(ri1, Math.floor((hx + reach) / texel));
    const j0 = Math.max(rj0, Math.floor((hz - reach) / texel)), j1 = Math.min(rj1, Math.floor((hz + reach) / texel));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot((i + 0.5) * texel - hx, (j + 0.5) * texel - hz) / reach;
      if (d < 1) light[(j - rj0) * w + (i - ri0)] += (1 - d * d) * (1 - d * d);
    }
  }
  for (let j = rj0; j <= rj1; j++) for (let i = ri0; i <= ri1; i++) out[j * LAMP_MAP + i] = Math.min(255, Math.round(light[(j - rj0) * w + (i - ri0)] * 230));
}

/** Texels a lamp's pool may touch around the head at (hx, hz): [i0, j0, i1, j1]. */
export function lampRegion(hx: number, hz: number, span: number, metersScale: number): [number, number, number, number] {
  const texel = span / LAMP_MAP, reach = LAMP_POOL / metersScale;
  const clamp = (v: number) => Math.max(0, Math.min(LAMP_MAP - 1, v));
  return [clamp(Math.floor((hx - reach) / texel)), clamp(Math.floor((hz - reach) / texel)), clamp(Math.floor((hx + reach) / texel)), clamp(Math.floor((hz + reach) / texel))];
}

export const FELL_STRIDE = 8;

const FENCE_POST_H = 1.28;
const POST_STEP = 2.15;
/** species come in patches this big (m), not salt and pepper */
const PATCH = 70;

function linear(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  const f = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return [f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)];
}

function hash(a: number, b: number, salt: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ salt, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x27d4eb2d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

class Instances {
  matrices: number[] = [];
  ground: number[] = [];
  colors: number[] = [];
  bark: number[] = [];
  traits: number[] = [];
  get count() { return this.ground.length; }
  /** rotation about Y, scale, translation; sx/sz in mercator meters already */
  push(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, ground: number, rgb?: [number, number, number]) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.matrices.push(c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1);
    this.ground.push(ground);
    if (rgb) this.colors.push(rgb[0], rgb[1], rgb[2]);
  }
  /**
   * A whole tree: yaw, a small lean, scale in meters (w across, h up), placed
   * at (x, z) tile-local. toMerc turns the horizontal meters into mercator.
   */
  tree(x: number, z: number, yaw: number, leanX: number, leanZ: number, w: number, h: number, toMerc: number, ground: number) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(leanX), sx = Math.sin(leanX), cz = Math.cos(leanZ), sz = Math.sin(leanZ);
    // R = Ry · Rx · Rz, row-major
    const r = [
      [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
      [cx * sz, cx * cz, -sx],
      [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx],
    ];
    const rowScale = [toMerc, 1, toMerc], colScale = [w, h, w];
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) this.matrices.push(rowScale[row] * r[row][col] * colScale[col]);
      this.matrices.push(0);
    }
    this.matrices.push(x, 0, z, 1);
    this.ground.push(ground);
  }
  done(withColors = false): InstanceSet {
    return {
      count: this.ground.length,
      matrices: new Float32Array(this.matrices),
      ground: new Float32Array(this.ground),
      colors: withColors ? new Float32Array(this.colors) : undefined,
      bark: this.bark.length ? new Float32Array(this.bark) : undefined,
      traits: this.traits.length ? new Float32Array(this.traits) : undefined,
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
  furniture: Furniture = { monuments: [], fountains: [], shelters: [], goals: [], lines: [] },
): VegetationData {
  const toMerc = 1 / metersScale;
  const center: [number, number] = [lngFromMercator(corner[0] + span / 2), latFromMercator(corner[1] - span / 2)];
  const presetId = selectPreset(center[1], center[0]);
  const preset = PRESETS[presetId];
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
  const flora = FLORA_MODELS.map(() => new Instances());
  const fell: number[] = [];
  const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < span && z < span;

  /** Plant one specimen of a species. `w`/`h` stretch it (hedges), `s` is its size. */
  const plant = (id: string, x: number, z: number, yaw: number, s: number, seed: number, w = 1, h = 1) => {
    const variant = VARIANTS[id];
    if (!variant) return;
    const m = FLORA_MODELS.indexOf(variant.model);
    const set = flora[m];
    const ground = groundAt(x, z);
    const r1 = hash(Math.round(x * 97), Math.round(z * 97), 5), r2 = hash(Math.round(x * 89), Math.round(z * 89), 9);
    const lean = (5 * Math.PI / 180) * (variant.model.startsWith('tree') ? 1 : 0.4);
    set.tree(x, z, yaw, (r1 - 0.5) * 2 * lean, (r2 - 0.5) * 2 * lean, variant.w * s * w, variant.h * s * h, toMerc, ground);
    // each specimen its own shade of the species' colour
    const light = 1 + (seed - 0.5) * 0.24, warm = (r1 - 0.5) * 0.08;
    const leaf = linear(variant.leaf);
    set.colors.push(leaf[0] * light * (1 + warm), leaf[1] * light, leaf[2] * light * (1 - warm));
    const bark = linear(variant.bark);
    set.bark.push(...bark);
    const autumn = linear(variant.autumn);
    set.traits.push(variant.habit, autumn[0], autumn[1], autumn[2]);
    if (variant.model.startsWith('tree')) fell.push(0, x, z, ground, MODEL_HEIGHT[variant.model as FloraModel] * variant.h * s * h, set.count - 1, m, 0);
  };

  // parks, woods, green areas: the preset's mix, species in patches
  const plants = drain(planVegetation(input)).filter((p) => !p.key.startsWith('r:'));
  const patch = PATCH * toMerc;
  for (const p of plants) {
    const x = mercatorX(p.position[0]) - corner[0];
    const z = corner[1] - mercatorY(p.position[1]);
    if (!inside(x, z)) continue; // the neighbour tile owns it
    const gx = Math.floor((corner[0] + x) / patch), gz = Math.floor((corner[1] - z) / patch);
    const roll = (hash(gx, gz, p.bush ? 17 : 13) * 0.75 + p.seed * 0.25) % 1;
    const id = p.bush ? pickMix(preset.under, roll) : pickMix(preset.trees, roll) ?? pickMix(preset.under, roll);
    if (!id) continue;
    const boost = VARIANTS[id].model === 'grass_tuft' ? 1.4 : 1; // tufts would vanish at a bush's spot
    plant(id, x, z, p.seed * Math.PI * 2, (0.75 + p.seed * 0.55) * boost, p.seed);
  }

  // Planted streets: one species per street from the preset's urban list.
  const streets = planStreets(corner, span, metersScale, features);
  const slot = { plane: 0, jacaranda: 1, pine: 2, cypress: 3 } as const;
  for (const p of streets.plants) {
    if (p.species === 'hedge') {
      // one clipped section ~4 m long, overlapping the next: reads as a continuous hedge
      if (preset.hedge) plant(preset.hedge, p.x, p.z, p.yaw, 1, 0.5, 2.1, 0.75);
      continue;
    }
    if (!preset.street.length) continue;
    const id = preset.street[slot[p.species] % preset.street.length];
    plant(id, p.x, p.z, p.yaw, p.s, (p.s - 0.9) / 0.25);
  }
  const lamps = new Instances();
  for (const lamp of streets.lamps) {
    const ground = groundAt(lamp.x, lamp.z);
    lamps.push(lamp.x, 0, lamp.z, lamp.yaw, toMerc, 1, toMerc, ground);
    fell.push(1, lamp.x, lamp.z, ground, 7.1, lamps.count - 1, -1, 0);
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
  // ---- baked street light: a soft pool under every lamp head ------------------
  // the head over the road: along the lamp's +X (yaw as planted)
  const heads: number[] = [];
  for (const lamp of streets.lamps) heads.push(lamp.x + Math.cos(lamp.yaw) * LAMP_ARM * toMerc, lamp.z - Math.sin(lamp.yaw) * LAMP_ARM * toMerc);
  const lampLight = new Uint8Array(LAMP_MAP * LAMP_MAP);
  bakeLampLight(heads, span, metersScale, lampLight);
  // ---- street furniture: statues, fountains, bus shelters, goals -------------------
  const plinths = new Instances(), plinthsLong = new Instances(), figures = new Instances(), riders = new Instances();
  const fountains = new Instances(), fountainWater = new Instances();
  const shelters = new Instances(), shelterGlass = new Instances(), goals = new Instances();
  const solids: number[] = [];
  const at = (set: Instances, spot: { x: number; z: number; yaw: number }, y: number, ground: number, scale = 1) =>
    set.push(spot.x, y, spot.z, spot.yaw, toMerc * scale, scale, toMerc * scale, ground);
  for (const spot of furniture.monuments) {
    const ground = groundAt(spot.x, spot.z);
    // about one in three on horseback
    if (spot.seed % 3 === 0) {
      at(plinthsLong, spot, 0, ground); at(riders, spot, MONUMENT_PLINTH_LONG_TOP, ground);
      solids.push(spot.x, spot.z, ground, 1.25, 2.1, spot.yaw, MONUMENT_PLINTH_LONG_TOP);
    } else {
      at(plinths, spot, 0, ground); at(figures, spot, MONUMENT_PLINTH_TOP, ground);
      solids.push(spot.x, spot.z, ground, 1.1, 1.1, spot.yaw, MONUMENT_PLINTH_TOP);
    }
  }
  for (const spot of furniture.fountains) {
    const ground = groundAt(spot.x, spot.z);
    at(fountains, spot, 0, ground); at(fountainWater, spot, 0, ground);
    solids.push(spot.x, spot.z, ground, 3, 3, spot.yaw, 0.7);
  }
  for (const spot of furniture.shelters) {
    const ground = groundAt(spot.x, spot.z);
    at(shelters, spot, 0, ground); at(shelterGlass, spot, 0, ground);
    solids.push(spot.x, spot.z, ground, 1.7, 0.75, spot.yaw, 2.6);
  }
  for (const goal of furniture.goals) at(goals, goal, 0, groundAt(goal.x, goal.z), goal.scale);
  return {
    flora: flora.map((f) => f.done(true)), preset: presetId, posts: posts.done(), rails: rails.done(), lamps: lamps.done(),
    plinths: plinths.done(), plinthsLong: plinthsLong.done(), figures: figures.done(), riders: riders.done(),
    fountains: fountains.done(), fountainWater: fountainWater.done(), shelters: shelters.done(), shelterGlass: shelterGlass.done(), goals: goals.done(),
    solids: new Float32Array(solids),
    fell: new Float32Array(fell), lampLight,
  };
}

export function vegetationTransferables(v: VegetationData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const set of [...v.flora, v.posts, v.rails, v.lamps, v.plinths, v.plinthsLong, v.figures, v.riders, v.fountains, v.fountainWater, v.shelters, v.shelterGlass, v.goals]) {
    out.push(set.matrices.buffer as ArrayBuffer, set.ground.buffer as ArrayBuffer);
    for (const extra of [set.colors, set.bark, set.traits]) if (extra) out.push(extra.buffer as ArrayBuffer);
  }
  out.push(v.fell.buffer as ArrayBuffer, v.lampLight.buffer as ArrayBuffer, v.solids.buffer as ArrayBuffer);
  return out;
}
