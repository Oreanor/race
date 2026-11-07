import * as THREE from 'three';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { ChunkData } from '../tiles/buildTile.ts';
import { ROOF_STRIDE } from '../tiles/buildTile.ts';
import type { GeoFeature, MeshData, WorldTileData } from '../tiles/worldTile.ts';
import { bridgeDeck, gridGround, gridWaterLevel, pickDriveHeight } from '../tiles/worldTile.ts';
import { tileTemplate } from '../tiles/tileSource.ts';
import { tilesAround, tilesCovering, distanceToTile, type PlannedTile } from '../tiles/tilePlan.ts';
import { latFromMercator, lngFromMercator, mercatorX, mercatorY, tileAt, tileCorner, tileSpan, WORLD_SIZE, type LngLat, type TileId } from '../mercator.ts';
import { farBuildingMaterial, groundMaterial, overlayMaterial, roadMaterial, waterMaterial, type BaseUniforms } from './materials.ts';
import { VegetationRenderer } from './vegetation.ts';
import { simpleLit } from './simpleLit.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bakeLampLight, FELL_STRIDE, GLASS_STRIDE, LAMP_ARM, LAMP_MAP, lampRegion, SOLID_STRIDE } from '../tiles/vegetationTile.ts';
import { roofClearanceAt, type RoofProfile } from '@/game/buildings/RoofGenerator';
import { METERS_PER_DEGREE } from '@/game/meters';
import type { SkinId } from '../buildings/skins.ts';

/** Window rhythm for fire markers — must track what the façade shader draws per skin. */
function fireWindowRhythm(skin: SkinId): { floor: number; spacing: number; yMid: number } {
  // yMid: fraction up the floor cell where glass sits (futuristic ribbons are the upper band)
  if (skin === 'futuristic') return { floor: 3.4, spacing: 1.4, yMid: 0.68 };
  if (skin === 'modern') return { floor: 3.2, spacing: 2.4, yMid: 0.55 };
  if (skin === 'victorian') return { floor: 3.2, spacing: 2.2, yMid: 0.55 };
  // original + mixed: baked city grid (buildTile FLOOR / bay)
  return { floor: 3.2, spacing: 2.7, yMid: 0.55 };
}


/** top of the pavement above the terrain (road ribbons sit 0.09–0.15 m up) */
const ROAD_TOP = 0.12;

/** A nearby building for vehicle collisions: footprint + roof skin (crest already exaggerated). */
export type BuildingCollider = {
  rings: [number, number][][];
  crest: number;
  roof: RoofProfile;
};

export type WorldTilesOptions = {
  zoom: number;
  /** tiles within this distance of the focus are loaded (and drawn) */
  loadRadius: number;
  /** and kept until they are farther than this */
  unloadRadius: number;
  /** gameplay features come from tiles within this distance */
  featureRadius: number;

  maxInFlight: number;
  uploadsPerFrame: number;
  grid: number;
  demTemplate: string | null;
  region: string;
};

export const defaultWorldOptions: WorldTilesOptions = {
  zoom: 14,
  // Tiles load beyond full fog (2000 m), so nothing ever appears in clear view.
  // ~800 m of margin past the fog: at full boost that is >10 s to fetch and build
  loadRadius: 2800,
  unloadRadius: 3600,
  // POIs (stations, hubs) are known before they come out of the fog
  featureRadius: 2400,
  maxInFlight: 6,
  // base GPU uploads/frame; bursts higher when a backlog would hitch the first lap
  uploadsPerFrame: 3,
  // ~20 m terrain cells: fine enough for real (unflattened) relief
  grid: 96,
  demTemplate: null,
  region: '',
};

/**
 * Every tile levels its water from its own banks, so a river crossing tiles steps
 * at the seams. The surface is eased toward a shared level at each edge.
 */
type WaterSeams = {
  geometry: THREE.BufferGeometry;
  /** aGround as built */
  base: Float32Array;
  /** this tile's water level at its north, east, south and west edge (null: no water there) */
  edge: (number | null)[];
};

/** how far into a tile the water eases toward the level shared with its neighbour (m) */
const SEAM_EASE = 150;

type Live = {
  key: string;
  tile: TileId;
  data: WorldTileData;
  group: THREE.Group;
  waiting: (() => void)[];
  /** buildings / flora — deferred while the M-map is open so London doesn't hitch */
  deferred: (() => void)[];
  /** wall meshes — hidden on M-map (Manhattan fill-rate) */
  buildings: THREE.Mesh[];
  roads: THREE.Mesh | null;
  disposables: { dispose(): void }[];
  /** lazily decoded non-gameplay layers (poi, housenumber, place…) */
  extra: Map<string, GeoFeature[]>;
  /** vegetation meshes by kind (trunk, leaf0…, lamp), for knocking things over */
  props: Map<string, THREE.InstancedMesh[]>;
  /** flora* meshes only — cached so LOD doesn't rebuild the list every frame */
  floraMeshes: THREE.InstancedMesh[] | null;
  /** trees and lamps bucketed by PROP_CELL, built on first use (shots and bumps look only nearby) */
  propCells: Map<number, number[]> | null;
  /** buildings bucketed by FOOTPRINT_CELL (a building in every cell its box covers), built on first use */
  footprintCells: Map<number, number[]> | null;
  /** per building: the query that last visited it (so one spanning several cells is visited once) */
  footprintSeen: Uint32Array | null;
  /** the tile's baked street light (vegetationTile lampLight), read by ground, roads and walls */
  lampMap: THREE.DataTexture;
  /** futuristic skin only: spires on some tall flat-roofed buildings, built on first use */
  spires: THREE.InstancedMesh | null;
  /** the water surface, matched to the neighbours' at the tile edges (seamWater) */
  water?: WaterSeams;
  /** 0..1 ease-in: drawn as fog until fully present (set per mesh just before draw) */
  fade: number;
};

/** A tree, lamp, shelter or statue knocked over; stands up again once out of sight. */
type Fallen = {
  live: Live;
  /** index into the tile's fell list */
  index: number;
  /** 0 tree, 1 lamp, 2 shelter, 3 figure, 4 rider */
  kind: number;
  started: number;
  /** tips toward this direction (tile-local, unit, horizontal) */
  dirX: number;
  dirZ: number;
  /** how far it slides aside while tipping (meters); bollards/shelters scale with impact speed */
  slideM: number;
  /** tip duration (s); shelters finish faster when hit hard */
  fallS: number;
  /** raise while tipping so a flat face sits on the ground instead of burying */
  restLift: number;
  /** the instance matrices it moves, with their standing copies */
  parts: { matrices: Float32Array; offset: number; standing: Float32Array; meshes: THREE.InstancedMesh[] }[];
  settled: boolean;
  /** since when it has been out of the view (0 = in view) */
  unseenSince: number;
  /** a street lamp: put its light back when it stands up again */
  relight?: () => void;
  /** shelter: restore the solid footprint when it stands again */
  restoreSolid?: () => void;
};

/** Bus-shelter glass shattered by a shot; the pane comes back once out of sight. */
type Shattered = {
  live: Live;
  /** shelterGlass instance index */
  index: number;
  parts: { matrices: Float32Array; offset: number; standing: Float32Array; meshes: THREE.InstancedMesh[] }[];
  unseenSince: number;
};

const FALL_TIME = 0.75; // s
/** new tiles ease in from fog colour so they don't pop onto empty ground */
const TILE_FADE_IN = 0.7; // s
/** bucket size (m) of the tree / lamp index */
const PROP_CELL = 16;
/** bucket size (m) of the building index */
const FOOTPRINT_CELL = 64;
const cellKey = (i: number, j: number) => i * 73856093 ^ j * 19349663;
const FALL_ANGLE = Math.PI / 2 - 0.06; // lies almost flat, a bit propped on the crown
/** how long a knocked prop must stay off-screen before it may stand up again */
const UNSEEN_RESTORE = 75; // s — stay down until you've driven well away
/** and it must be at least this far from the focus (m) — looking back shouldn't revive it yet */
const RESTORE_AWAY_M = 220;

/**
 * Ray vs the shelter's two glass panes in local meters (open side +Z). Returns
 * the nearest hit t ∈ [0,1], or null. Matches shelterGlassGeometry().
 */
function glassPaneHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number | null {
  let best: number | null = null;
  // back pane + end pane (thin boxes)
  for (const box of [
    { cx: 0, cy: 1.25, cz: -0.6, hx: 1.56, hy: 1.05, hz: 0.05 },
    { cx: -1.6, cy: 1.25, cz: -0.03, hx: 0.05, hy: 1.05, hz: 0.55 },
  ] as const) {
    const t = rayAabb(ax - box.cx, ay - box.cy, az - box.cz, bx - box.cx, by - box.cy, bz - box.cz, box.hx, box.hy, box.hz);
    if (t != null && (best == null || t < best)) best = t;
  }
  return best;
}

/** Segment A→B vs axis-aligned box centred at 0 with half-extents hx/hy/hz. */
function rayAabb(ax: number, ay: number, az: number, bx: number, by: number, bz: number, hx: number, hy: number, hz: number): number | null {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let t0 = 0, t1 = 1;
  for (const [p, d, h] of [[ax, dx, hx], [ay, dy, hy], [az, dz, hz]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (p < -h || p > h) return null;
      continue;
    }
    const inv = 1 / d;
    let u0 = (-h - p) * inv, u1 = (h - p) * inv;
    if (u0 > u1) { const s = u0; u0 = u1; u1 = s; }
    t0 = Math.max(t0, u0);
    t1 = Math.min(t1, u1);
    if (t0 > t1) return null;
  }
  return t0;
}

type Pending = { id: number; key: string; tile: TileId };

export type WorldTileStats = { loaded: number; inFlight: number; buildings: number; residentMB: number; avgFetchMs: number; avgBuildMs: number };

/**
 * Streams z14 world tiles around a focus point. Owns the GPU meshes of the base
 * world (terrain, roads, far buildings) and answers gameplay queries (features,
 * ground height) from the same data, so rendering and gameplay never disagree.
 */
export class WorldTiles {
  readonly root = new THREE.Group();
  private tiles = new Map<string, Live>();
  private fallen = new Map<string, Fallen>();
  private shattered = new Map<string, Shattered>();
  private spiresOn = false;
  private side: THREE.Side = THREE.FrontSide;
  private spireGeometry: THREE.BufferGeometry | null = null;
  private spireMaterial: THREE.Material | null = null;
  private frustum = new THREE.Frustum();
  /** reused by updateFallen — no per-prop Matrix4 allocs */
  private fallPivot = new THREE.Matrix4();
  private fallTurn = new THREE.Matrix4();
  private fallBack = new THREE.Matrix4();
  private fallMat = new THREE.Matrix4();
  private fallScaleIn = new THREE.Matrix4();
  private fallScaleOut = new THREE.Matrix4();
  private fallShift = new THREE.Matrix4();
  private fallAxis = new THREE.Vector3();
  private fallPoint = new THREE.Vector3();
  private fallSphere = new THREE.Sphere();
  private pending = new Map<string, Pending>();
  private workers: Worker[] = [];
  private load: number[] = [];
  private jobs = new Map<number, { key: string; worker: number }>();
  private nextId = 1;
  private failures = new Map<string, { count: number; at: number }>();
  private fetchTimes: number[] = [];
  private buildTimes: number[] = [];
  private template: string | null = null;
  private disposed = false;
  private roadMat: THREE.ShaderMaterial;
  private farMat: THREE.ShaderMaterial;
  private groundMat: THREE.ShaderMaterial;
  private overlayMats: THREE.ShaderMaterial[];
  private waterMat: THREE.ShaderMaterial;
  private vegetation: VegetationRenderer;
  /** scene placement: mercator 0..1 origin and scene meters per WGS84 mercator meter */
  private origin01 = new THREE.Vector2();
  private sceneScale = 1;
  private metersPer01 = 1;
  private lastFadeMs = 0;
  /** after leaving M-map: hold the last screen tile set so toggle doesn't thrash GPU */
  private softKeep = new Set<string>();
  private softKeepUntil = 0;
  private softKeepAt: LngLat | null = null;
  /** M-map / calm: only ground+roads upload; buildings wait until chase */
  private mapLite = false;
  /** hide trees/lamps while looking straight down (London fill-rate) */
  private propsHidden = false;
  onTile: (key: string) => void = () => {};
  revision = 0;

  constructor(private uniforms: BaseUniforms, mask: THREE.Texture, readonly options: WorldTilesOptions = defaultWorldOptions) {
    this.root.matrixAutoUpdate = false;
    this.roadMat = roadMaterial(uniforms);
    this.farMat = farBuildingMaterial(uniforms, mask);
    this.groundMat = groundMaterial(uniforms);
    this.overlayMats = [0, 1, 2].map((layer) => overlayMaterial(uniforms, layer));
    this.waterMat = waterMaterial(uniforms);
    this.vegetation = new VegetationRenderer(uniforms);
    tileTemplate().then((t) => { this.template = t; });
    const size = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('../tiles/world.worker.ts', import.meta.url), { type: 'module' });
      const index = i;
      worker.onmessage = (event) => this.receive(index, event.data);
      worker.onerror = (event) => console.error('[world] tile worker error', event.message);
      this.workers.push(worker);
      this.load.push(0);
    }
  }

  setMaterialSide(side: THREE.Side) {
    for (const m of [this.roadMat, this.farMat, this.groundMat, this.waterMat, ...this.overlayMats]) m.side = side;
    this.vegetation.setSide(side);
    this.side = side;
    if (this.spireMaterial) this.spireMaterial.side = side;
    for (const live of this.tiles.values()) live.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m && m.uniforms?.uMap) m.side = side;
    });
  }

  /**
   * Floating origin. Scene x = east, z = south, in MapLibre meters at the
   * origin latitude, so custom layers and this world share one metric.
   */
  setOrigin(x01: number, y01: number, metersPer01: number) {
    this.origin01.set(x01, y01);
    this.metersPer01 = metersPer01;
    this.sceneScale = metersPer01 / WORLD_SIZE;
    for (const live of this.tiles.values()) this.place(live);
  }

  private place(live: Live) {
    const [cx, cy] = live.data.corner;
    const x01 = (cx + WORLD_SIZE / 2) / WORLD_SIZE;
    const y01 = (WORLD_SIZE / 2 - cy) / WORLD_SIZE;
    live.group.position.set((x01 - this.origin01.x) * this.metersPer01, 0, (y01 - this.origin01.y) * this.metersPer01);
    live.group.scale.set(this.sceneScale, 1, this.sceneScale);
    live.group.updateMatrix();
    live.group.updateMatrixWorld(true);
  }

  /**
   * Stream tiles around the view. Pass `heading` (rad, 0 = north) so driving
   * prefers the road ahead. Pass `burst` during boot so the start ring fills
   * isotropically and GPU uploads drain faster before the player moves.
   * Pass `screen` (lng/lat west/south/east/north) for the top-down map so the
   * whole viewport rectangle is loaded — a circular radius empties the corners.
   * Pass `calm` during camera blends (intro fly-in / M open) so uploads stay tiny.
   */
  update(
    focus: LngLat,
    heading = 0,
    burst = false,
    screen?: { west: number; south: number; east: number; north: number },
    calm = false,
  ) {
    if (this.disposed || !this.template) return;
    const o = this.options;
    // pull the load centre a few hundred metres forward so hitching stays behind the car
    // (boot: stay on the spawn so the whole first-lap ring is warm, not just ahead)
    const cosLat = Math.cos(focus[1] * Math.PI / 180);
    const aheadM = burst || screen ? 0 : 520;
    const stream: LngLat = [
      focus[0] + Math.sin(heading) * aheadM / (METERS_PER_DEGREE * cosLat),
      focus[1] + Math.cos(heading) * aheadM / METERS_PER_DEGREE,
    ];
    let wanted: PlannedTile[];
    const keep = new Set<string>();
    if (screen) {
      // same pad for load + keep — old loadPad≪keepPad left edge tiles "kept" but never requested.
      // calm blend: tighter pad so we don't request a city block mid-lerp
      const pad = calm ? 500 : 800;
      const dLng = pad / (METERS_PER_DEGREE * cosLat);
      const dLat = pad / METERS_PER_DEGREE;
      wanted = tilesCovering(
        screen.west - dLng, screen.south - dLat,
        screen.east + dLng, screen.north + dLat,
        o.zoom, focus,
      );
      for (const t of wanted) keep.add(t.key);
    } else {
      wanted = tilesAround(stream, o.loadRadius, o.zoom);
      // prefer tiles in front of travel when several are equally near
      if (!burst) {
        const he = Math.sin(heading), hn = Math.cos(heading);
        const mx = mercatorX(stream[0]), my = mercatorY(stream[1]);
        const mScale = Math.cos(stream[1] * Math.PI / 180);
        wanted.sort((a, b) => {
          const score = (p: PlannedTile) => {
            const [cx, cy] = tileCorner(p.tile);
            const span = tileSpan(p.tile.z);
            const te = ((cx + span / 2) - mx) * mScale;
            const tn = (my - (cy - span / 2)) * mScale; // mercator y south → north
            const ahead = te * he + tn * hn;
            return p.distance - Math.max(0, ahead) * 0.5;
          };
          return score(a) - score(b);
        });
      }
      for (const t of tilesAround(focus, o.unloadRadius, o.zoom)) keep.add(t.key);
    }
    for (const p of wanted) keep.add(p.key);
    const nowKeep = performance.now();
    if (screen) {
      // sticky rectangle: reopen M in the same area must not refetch the sides
      this.softKeep = new Set(keep);
      this.softKeepUntil = nowKeep + 90000;
      this.softKeepAt = [...focus];
    } else if (this.softKeep.size && this.softKeepAt) {
      const dx = (focus[0] - this.softKeepAt[0]) * METERS_PER_DEGREE * cosLat;
      const dy = (focus[1] - this.softKeepAt[1]) * METERS_PER_DEGREE;
      // hold until the car leaves the last map area, not just a few seconds
      if (nowKeep < this.softKeepUntil || Math.hypot(dx, dy) < 2800) {
        for (const k of this.softKeep) keep.add(k);
      } else {
        this.softKeep.clear();
        this.softKeepAt = null;
      }
    }
    // spread unloads across frames — dumping a full M-map rectangle in one tick tanks FPS.
    // while soft-keeping the map rectangle, drip slowly (never dump the softKeep set itself)
    const holdingMap = !screen && this.softKeep.size > 0;
    // fly-in: don't dispose meshes mid-lerp (unload hitch = the other half of хрясть)
    const dropCap = calm ? 0 : holdingMap ? 1 : screen ? 2 : 6;
    let dropped = 0;
    for (const [key, live] of this.tiles) {
      if (keep.has(key)) continue;
      if (dropped >= dropCap) break;
      this.unload(key, live);
      dropped++;
    }
    if (!calm) {
      for (const [key, job] of this.pending) {
        if (keep.has(key) || this.softKeep.has(key)) continue;
        this.cancel(job.id);
        this.pending.delete(key);
      }
    }
    const now = performance.now();
    // camera blends must stay smooth — never storm the GPU mid-lerp (was 5–7 FPS on M open)
    const mapBurst = !!screen && !calm;
    // intro fly-in: zero new fetches / uploads — even one tower chunk was the 17 fps hitch
    const flightCap = calm ? 0
      : this.mapLite ? 2
        : (burst || mapBurst) ? Math.max(o.maxInFlight, mapBurst ? 4 : 8)
          : o.maxInFlight;
    for (const plan of wanted) {
      if (this.tiles.has(plan.key) || this.pending.has(plan.key)) continue;
      const failed = this.failures.get(plan.key);
      if (failed && (failed.count >= 4 || now < failed.at)) continue;
      if (this.pending.size >= flightCap) break;
      this.request(plan.key, plan.tile);
    }
    let backlog = 0;
    for (const live of this.tiles.values()) backlog += live.waiting.length;
    let budget = o.uploadsPerFrame;
    if (calm) {
      budget = 0;
    } else if (burst) {
      // boot only (map still hidden / settled) — keep visible play under ~8
      budget = backlog > 24 ? 12 : backlog > 12 ? 9 : backlog > 5 ? 7 : 5;
    } else if (mapBurst) {
      // M-map / top-down: drain a little, but never storm the GPU (was 5–7 FPS)
      budget = 2;
    } else {
      // chase: don't ramp with backlog — that was the mid-drive FPS dip while tiles stream in
      budget = 2;
    }
    if (this.mapLite) budget = Math.min(budget, 2);
    // wanted first; soft-kept only when not calm (otherwise M leftovers hitch the intro fly-in)
    for (const plan of wanted) {
      const live = this.tiles.get(plan.key);
      while (live && live.waiting.length && budget > 0) { live.waiting.shift()!(); budget--; }
      if (budget <= 0) break;
    }
    if (budget > 0 && !calm && !this.mapLite) {
      for (const live of this.tiles.values()) {
        while (live.waiting.length && budget > 0) { live.waiting.shift()!(); budget--; }
        if (budget <= 0) break;
      }
    }
    // ease newly installed tiles in (unload still drops immediately — memory, not cosmetics)
    const nowFade = performance.now();
    const dt = this.lastFadeMs ? Math.min(0.05, (nowFade - this.lastFadeMs) / 1000) : 0;
    this.lastFadeMs = nowFade;
    if (dt > 0) {
      const step = dt / TILE_FADE_IN;
      for (const live of this.tiles.values()) if (live.fade < 1) live.fade = Math.min(1, live.fade + step);
    }
  }

  private url(template: string, tile: TileId) {
    return template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
  }

  private request(key: string, tile: TileId) {
    const id = this.nextId++;
    let worker = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.load[i] < this.load[worker]) worker = i;
    this.load[worker]++;
    this.jobs.set(id, { key, worker });
    this.pending.set(key, { id, key, tile });
    this.workers[worker].postMessage({
      type: 'world', id, tile,
      vectorUrl: this.url(this.template!, tile),
      demUrl: this.options.demTemplate ? this.url(this.options.demTemplate, tile) : null,
      demNeighbours: this.options.demTemplate ? [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]].map(([dx, dy]) => {
        const size = 2 ** tile.z, y = tile.y + dy;
        if (y < 0 || y >= size) return null;
        return this.url(this.options.demTemplate!, { ...tile, x: ((tile.x + dx) % size + size) % size, y });
      }) : null,
      options: { chunks: 4, inset: 0, grid: this.options.grid, region: this.options.region },
    });
  }

  private cancel(id: number) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.workers[job.worker]?.postMessage({ type: 'cancel', id });
    this.jobs.delete(id);
    this.load[job.worker] = Math.max(0, this.load[job.worker] - 1);
  }

  private receive(_worker: number, message: { id: number; ok: boolean; data?: WorldTileData; fetchMs?: number; buildMs?: number; error?: string; aborted?: boolean }) {
    const job = this.jobs.get(message.id);
    if (!job) return;
    this.jobs.delete(message.id);
    this.load[job.worker] = Math.max(0, this.load[job.worker] - 1);
    const pending = this.pending.get(job.key);
    if (!pending || pending.id !== message.id) return;
    this.pending.delete(job.key);
    if (this.disposed) return;
    if (!message.ok || !message.data) {
      if (message.aborted) return;
      const prior = this.failures.get(job.key)?.count ?? 0;
      this.failures.set(job.key, { count: prior + 1, at: performance.now() + 1500 * 2 ** prior });
      console.warn(`[world] tile ${job.key} failed`, message.error);
      return;
    }
    this.failures.delete(job.key);
    this.fetchTimes.push(message.fetchMs ?? 0);
    this.buildTimes.push(message.buildMs ?? 0);
    if (this.fetchTimes.length > 30) { this.fetchTimes.shift(); this.buildTimes.shift(); }
    this.install(job.key, message.data);
  }

  private install(key: string, data: WorldTileData) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.name = `world ${key}`;
    const lampMap = new THREE.DataTexture(data.vegetation.lampLight, LAMP_MAP, LAMP_MAP, THREE.RedFormat, THREE.UnsignedByteType);
    // no mipmaps: generating them on the main thread hitchs every new tile on the first lap
    lampMap.minFilter = THREE.LinearFilter;
    lampMap.magFilter = THREE.LinearFilter;
    lampMap.generateMipmaps = false;
    lampMap.needsUpdate = true;
    const live: Live = {
      key, tile: data.tile, data, group, waiting: [], deferred: [], buildings: [], roads: null,
      disposables: [lampMap], extra: new Map(), props: new Map(), floraMeshes: null, propCells: null,
      footprintCells: null, footprintSeen: null, lampMap, spires: null, fade: 0,
    };
    this.place(live);
    this.root.add(group);
    this.tiles.set(key, live);

    // Ground first, then water/roads/seams — one waiting slot used to hitch a whole frame.
    live.waiting.push(() => {
      const g = data.ground;
      const terrain = this.lampLit(this.mesh(g.terrain, this.groundMat, false), live);
      terrain.renderOrder = -4;
      group.add(terrain);
      live.disposables.push(terrain.geometry);
      g.layers.forEach((layer, i) => {
        if (!layer.index.length) return;
        const mesh = this.lampLit(this.mesh(layer, this.overlayMats[i], false), live);
        mesh.renderOrder = -3.9 + i * 0.1; // after the terrain, before water and roads
        group.add(mesh);
        live.disposables.push(mesh.geometry);
      });
      group.updateMatrixWorld(true);
    });
    live.waiting.push(() => {
      const g = data.ground;
      if (g.water.index.length) {
        const water = this.lampLit(this.mesh(g.water, this.waterMat, false), live);
        if (g.water.shore) water.geometry.setAttribute('aShore', new THREE.BufferAttribute(g.water.shore, 1));
        water.renderOrder = -3;
        group.add(water);
        live.disposables.push(water.geometry);
        live.water = this.waterEdges(live, water.geometry);
        this.seamWater(live);
        for (const n of this.neighbours(live)) if (n) this.seamWater(n);
      }
      if (data.streams.index.length) {
        // streams look like the rest of the water: away from a bank, no foam
        const streams = this.lampLit(this.mesh(data.streams, this.waterMat, false), live);
        streams.geometry.setAttribute('aShore', new THREE.BufferAttribute(new Float32Array(data.streams.positions.length / 3).fill(3), 1));
        streams.renderOrder = -3;
        group.add(streams);
        live.disposables.push(streams.geometry);
      }
      if (data.roads.index.length) {
        const roads = this.lampLit(this.mesh(data.roads, this.roadMat, false), live);
        roads.renderOrder = -1;
        group.add(roads);
        live.roads = roads;
        live.disposables.push(roads.geometry);
      }
      group.updateMatrixWorld(true);
    });
    // Manhattan/London: while M-map is open, don't upload towers/trees — ground+roads are enough top-down
    const detail: (() => void)[] = [];
    for (const chunk of data.buildings.chunks) detail.push(() => this.addChunk(live, chunk));
    detail.push(() => {
      const meshes = [...this.vegetation.build(data.vegetation), ...this.vegetation.buildAccents(data.buildings.accents)];
      const flora: THREE.InstancedMesh[] = [];
      for (const mesh of meshes) {
        this.lampLit(mesh, live);
        mesh.visible = true;
        group.add(mesh);
        const list = live.props.get(mesh.name);
        if (list) list.push(mesh); else live.props.set(mesh.name, [mesh]);
        if (mesh.name.startsWith('flora')) flora.push(mesh);
      }
      live.floraMeshes = flora;
      group.updateMatrixWorld(true);
      live.disposables.push({ dispose: () => this.vegetation.release(meshes) });
      if (this.spiresOn) this.buildSpires(live);
    });
    if (this.mapLite) live.deferred.push(...detail);
    else live.waiting.push(...detail);
    // Gameplay may read this tile now: features and DEM are final.
    this.revision++;
    this.onTile(key);
  }

  private mesh(data: MeshData, material: THREE.Material, uvs: boolean) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('aGround', new THREE.BufferAttribute(data.ground, 1));
    if (data.colors) geometry.setAttribute('aColor', new THREE.BufferAttribute(data.colors, 3, true));
    if (uvs && data.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    geometry.computeBoundingSphere();
    // ground lifts with exaggeration in the vertex shader — pad for DEM, not whole-tile fog
    if (geometry.boundingSphere) geometry.boundingSphere.radius += 180;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /**
   * The materials are shared by every tile; each tile has its own street-light map
   * and fade. Hand them to the material right before it draws.
   */
  private lampLit<T extends THREE.Mesh>(mesh: T, live: Live): T {
    mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
      const uniforms = (material as THREE.ShaderMaterial).uniforms;
      if (!uniforms) return;
      if (uniforms.uTileFade) uniforms.uTileFade.value = live.fade;
      if (uniforms.uLampMap && uniforms.uLampMap.value !== live.lampMap) {
        uniforms.uLampMap.value = live.lampMap;
        (material as THREE.ShaderMaterial).uniformsNeedUpdate = true;
      }
    };
    return mesh;
  }

  private addChunk(live: Live, chunk: ChunkData) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3, true));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(chunk.colors, 3, true));
    geometry.setAttribute('aFacade', new THREE.BufferAttribute(chunk.facade, 3));
    geometry.setAttribute('aGround', new THREE.BufferAttribute(chunk.ground, 1));
    geometry.setAttribute('aWin', new THREE.BufferAttribute(chunk.win, 4));
    geometry.setAttribute('aWinSize', new THREE.BufferAttribute(chunk.winSize, 2));
    geometry.setIndex(new THREE.BufferAttribute(chunk.index, 1));
    // aGround*uExag lifts walls in the vertex shader (not in positions); pad for DEM.
    // Keep pad modest so off-screen Manhattan blocks actually cull.
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(chunk.cx, chunk.maxHeight / 2, chunk.cz),
      Math.hypot(chunk.radius * Math.SQRT2, chunk.maxHeight) + 120,
    );
    const mesh = this.lampLit(new THREE.Mesh(geometry, this.farMat), live);
    mesh.matrixAutoUpdate = false;
    mesh.visible = true;
    live.group.add(mesh);
    mesh.updateMatrixWorld(true);
    live.buildings.push(mesh);
    live.disposables.push(geometry);
  }

  /**
   * Was used to blank walls on the M-map for fill-rate; we no longer hide them.
   * Still drains any leftover deferred uploads if something had queued them.
   */
  setMapLite(on: boolean) {
    if (this.mapLite === on) return;
    this.mapLite = on;
    for (const live of this.tiles.values()) {
      for (const mesh of live.buildings) mesh.visible = true;
      if (live.spires) live.spires.visible = true;
      if (live.deferred.length) {
        live.waiting.push(...live.deferred);
        live.deferred.length = 0;
      }
    }
  }

  /** Trees/lamps stay drawn on the map too. */
  setPropsHidden(on: boolean) {
    if (this.propsHidden === on) return;
    this.propsHidden = on;
    for (const live of this.tiles.values()) {
      for (const list of live.props.values()) for (const mesh of list) mesh.visible = true;
    }
  }

  private unload(key: string, live: Live) {
    for (const [id, f] of this.fallen) if (f.live === live) this.fallen.delete(id);
    for (const [id, g] of this.shattered) if (g.live === live) this.shattered.delete(id);
    this.root.remove(live.group);
    for (const fn of live.waiting.splice(0)) void fn; // never uploaded
    live.deferred.length = 0;
    live.buildings.length = 0;
    for (const d of live.disposables) d.dispose();
    this.tiles.delete(key);
    this.revision++;
    // the neighbours' water goes back to its own level along this edge
    for (const n of this.neighbours(live)) if (n) this.seamWater(n);
  }

  /** The loaded tiles north, east, south and west of this one. */
  private neighbours(live: Live): (Live | null)[] {
    const { z, x, y } = live.tile;
    return [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dx, dy]) => this.tiles.get(`${z}/${x + dx}/${y + dy}`) ?? null);
  }

  /** The water's level along each edge of the tile: the median height of the surface touching it. */
  private waterEdges(live: Live, geometry: THREE.BufferGeometry): WaterSeams {
    const span = tileSpan(live.tile.z);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const ground = geometry.getAttribute('aGround') as THREE.BufferAttribute;
    const base = Float32Array.from(ground.array as Float32Array);
    const near = 1.5 / live.data.metersScale; // mercator
    const heights: number[][] = [[], [], [], []];
    for (let v = 0; v < position.count; v++) {
      const x = position.getX(v), z = position.getZ(v), h = base[v] + position.getY(v);
      if (z <= near) heights[0].push(h);
      if (x >= span - near) heights[1].push(h);
      if (z >= span - near) heights[2].push(h);
      if (x <= near) heights[3].push(h);
    }
    const edge = heights.map((list) => {
      if (list.length < 3) return null;
      list.sort((a, b) => a - b);
      return list[Math.floor(list.length / 2)];
    });
    return { geometry, base, edge };
  }

  /**
   * Ease this tile's water toward the level it shares with each loaded neighbour:
   * halfway between the two at the edge, back to its own SEAM_EASE m inside. Only
   * the water at about the edge's level moves (not a pool on a hill nearby).
   */
  private seamWater(live: Live) {
    const w = live.water;
    if (!w) return;
    const span = tileSpan(live.tile.z);
    const neighbours = this.neighbours(live);
    const shifts = w.edge.map((mine, side) => {
      const theirs = neighbours[side]?.water?.edge[(side + 2) % 4];
      return mine != null && theirs != null ? { mine, by: (theirs - mine) / 2 } : null;
    });
    const position = w.geometry.getAttribute('position') as THREE.BufferAttribute;
    const ground = w.geometry.getAttribute('aGround') as THREE.BufferAttribute;
    const out = ground.array as Float32Array;
    const ease = SEAM_EASE / live.data.metersScale;
    for (let v = 0; v < position.count; v++) {
      const x = position.getX(v), z = position.getZ(v), h = w.base[v] + position.getY(v);
      const away = [z, span - x, span - z, x];
      let offset = 0;
      shifts.forEach((shift, side) => {
        if (!shift || Math.abs(h - shift.mine) > 4) return;
        const k = Math.max(0, 1 - away[side] / ease);
        offset += shift.by * k * k * (3 - 2 * k);
      });
      out[v] = w.base[v] + offset;
    }
    ground.needsUpdate = true;
  }

  /** Hide whole tiles that are entirely inside opaque fog (invisible anyway). */
  /**
   * Trees' level of detail per tile, from the camera: `eye` in scene space,
   * `above` the camera's height over the ground (m). The distance is to the
   * nearest point of the tile, so the tile under the car is always detailed.
   */
  updateFloraDetail(eye: THREE.Vector3, above: number) {
    for (const live of this.tiles.values()) {
      const meshes = live.floraMeshes;
      if (!meshes?.length || !live.group.visible) continue;
      const size = tileSpan(live.tile.z) * this.sceneScale;
      const x0 = live.group.position.x, z0 = live.group.position.z;
      const dx = Math.max(x0 - eye.x, 0, eye.x - (x0 + size)), dz = Math.max(z0 - eye.z, 0, eye.z - (z0 + size));
      this.vegetation.floraDetail(meshes, Math.hypot(dx, dz, above));
    }
  }

  cullBeyond(focus: LngLat, distance: number) {
    const mx = mercatorX(focus[0]), my = mercatorY(focus[1]);
    const cos = Math.cos(focus[1] * Math.PI / 180);
    for (const live of this.tiles.values()) live.group.visible = distanceToTile(mx, my, live.tile, cos) <= distance;
  }

  /** Hide tiles wholly outside the lng/lat rectangle (top-down map: keep the screen filled). */
  cullOutside(west: number, south: number, east: number, north: number) {
    for (const live of this.tiles.values()) {
      const [x0, y0] = tileCorner(live.tile);
      const span = tileSpan(live.tile.z);
      const tw = lngFromMercator(x0);
      const te = lngFromMercator(x0 + span);
      const tn = latFromMercator(y0);
      const ts = latFromMercator(y0 - span);
      live.group.visible = te >= west && tw <= east && tn >= south && ts <= north;
    }
  }

  // ---- queries -------------------------------------------------------------

  private liveAt(lng: number, lat: number) {
    const tile = tileAt(lng, lat, this.options.zoom);
    return this.tiles.get(`${tile.z}/${tile.x}/${tile.y}`) ?? null;
  }

  /**
   * Drive surface in meters, or null where no tile is loaded yet.
   * Pass `atAltitude` (car height) so overpasses don't yank a car on the road below.
   */
  groundAt(lng: number, lat: number, atAltitude?: number): number | null {
    const live = this.liveAt(lng, lat);
    if (!live) return null;
    if (!live.data.dem) return 0;
    const span = tileSpan(live.tile.z);
    const [cx, cy] = live.data.corner;
    const x = mercatorX(lng) - cx, z = cy - mercatorY(lat);
    const u = x / span, v = z / span;
    // driveHeights keep the dry bank; visual `heights` are dipped for the shore mesh
    const drive = live.data.ground.driveHeights ?? live.data.ground.heights;
    let ground = gridGround(drive, this.options.grid, u, v);
    // carved baths are only visual — don't drop the car into a 2 m hole (launches on the way out)
    const water = gridWaterLevel(live.data.ground.waterLevel, this.options.grid, u, v);
    if (water != null && ground < water - 0.4) ground = water - 0.12;
    // if already elevated, widen the ribbon so curve chords / deck seams don't miss
    const hint = atAltitude == null ? undefined : atAltitude - ROAD_TOP;
    const elevated = hint != null && hint > ground + 1.4;
    const deck = bridgeDeck(live.data.bridges, x, z, elevated ? 1.45 : 1.22);
    // roads lie on the terrain, lifted a little: wheels stand on the pavement, not in it
    return pickDriveHeight(ground, deck, hint) + ROAD_TOP;
  }

  /**
   * True when `altitude` sits on a bridge deck ribbon (not the river road under it).
   * Used so water collision doesn't wall off the on-ramp the moment XY crosses water.
   */
  isDeckAt(lng: number, lat: number, altitude: number): boolean {
    const live = this.liveAt(lng, lat);
    if (!live?.data.bridges.length) return false;
    const [cx, cy] = live.data.corner;
    const x = mercatorX(lng) - cx, z = cy - mercatorY(lat);
    const deck = bridgeDeck(live.data.bridges, x, z, 1.45);
    if (deck == null) return false;
    // near the deck surface — under the bridge altitude is far below
    return altitude >= deck - 2.8 && altitude <= deck + 6;
  }

  /**
   * What the ground is at a point, for wheel effects: sand (beaches), grass and
   * earth (parks, fields, woods, meadows), else paved (roads, squares, pavements).
   */
  surfaceAt(lng: number, lat: number): 'paved' | 'grass' | 'sand' {
    const live = this.liveAt(lng, lat);
    if (!live) return 'paved';
    let found: 'paved' | 'grass' | 'sand' = 'paved';
    for (const layer of ['landcover', 'park', 'landuse'] as const) {
      for (const feature of live.data.features[layer] ?? []) {
        const cls = String(feature.properties?.class ?? '');
        const kind = layer === 'park' || /^(grass|wood|forest|farmland|meadow|wetland|scrub|cemetery|recreation_ground|village_green|allotments|orchard|vineyard)$/.test(cls)
          ? 'grass' : cls === 'sand' || cls === 'beach' ? 'sand' : null;
        if (!kind || (kind === 'grass' && found !== 'paved')) continue;
        if (!this.inFeature(feature, lng, lat)) continue;
        if (kind === 'sand') return 'sand';
        found = kind;
      }
    }
    return found;
  }

  private featureBox = new WeakMap<GeoFeature, [number, number, number, number]>();

  /** Point in a (multi)polygon feature, with its bounding box cached. */
  private inFeature(feature: GeoFeature, lng: number, lat: number) {
    const g = feature.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) as [number, number][][][];
    let box = this.featureBox.get(feature);
    if (!box) {
      box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const poly of polys) for (const [x, y] of poly[0] ?? []) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
      this.featureBox.set(feature, box);
    }
    if (lng < box[0] || lng > box[2] || lat < box[1] || lat > box[3]) return false;
    return polys.some((poly) => insideLngLat([lng, lat], poly[0]) && !poly.slice(1).some((hole) => insideLngLat([lng, lat], hole)));
  }

  hasDemAt(lng: number, lat: number) {
    return this.liveAt(lng, lat) != null;
  }

  /** GeoJSON features of a tile layer around a point (the gameplay layers are decoded up front). */
  features(layer: string, focus: LngLat): GeoFeature[] {
    const out: GeoFeature[] = [];
    const mx = mercatorX(focus[0]), my = mercatorY(focus[1]);
    const scale = Math.cos(focus[1] * Math.PI / 180);
    for (const live of this.tiles.values()) {
      if (distanceToTile(mx, my, live.tile, scale) > this.options.featureRadius) continue;
      const list = live.data.features[layer] ?? this.extraLayer(live, layer);
      for (const f of list) out.push(f);
    }
    return out;
  }

  /** One loaded tile's layer (empty if the tile is gone or still uploading). */
  featuresOf(key: string, layer: string): GeoFeature[] {
    const live = this.tiles.get(key);
    if (!live) return [];
    return live.data.features[layer] ?? this.extraLayer(live, layer);
  }

  /** Keys of tiles currently resident (for gameplay ingest bookkeeping). */
  tileKeys(): string[] {
    return [...this.tiles.keys()];
  }

  hasTile(key: string) {
    return this.tiles.has(key);
  }

  /** Any other layer of the tile, decoded on first use from the kept PBF bytes. */
  private extraLayer(live: Live, name: string): GeoFeature[] {
    const cached = live.extra.get(name);
    if (cached) return cached;
    const list: GeoFeature[] = [];
    try {
      const layer = new VectorTile(new PbfReader(live.data.raw)).layers[name];
      if (layer) for (let i = 0; i < layer.length; i++) list.push(layer.feature(i).toGeoJSON(live.tile.x, live.tile.y, live.tile.z) as unknown as GeoFeature);
    } catch (error) {
      console.warn(`[world] layer ${name} unreadable`, error);
    }
    live.extra.set(name, list);
    return list;
  }

  /** Building footprints (lng/lat rings) near a point, for collisions and spawn search. */
  footprintsNear(center: LngLat, radius: number): [number, number][][][] {
    const out: [number, number][][][] = [];
    this.eachFootprint(center, radius, (rings) => { out.push(rings()); });
    return out;
  }

  /**
   * The house a shop is in: the building around the point, else the nearest one
   * within `radius` m. Middle, top height (m, not exaggerated), and footprint
   * radius (m from middle to the farthest corner) for service reach.
   */
  houseAt(point: LngLat, radius: number): { middle: LngLat; top: number; radius: number } | null {
    let best: { middle: LngLat; top: number; d: number; radius: number } | null = null;
    const cos = Math.cos(point[1] * Math.PI / 180);
    this.eachFootprint(point, radius, (rings, height, roof, crest) => {
      const outer = rings()[0];
      if (!outer?.length) return;
      let x = 0, y = 0;
      for (const [lng, lat] of outer) { x += lng; y += lat; }
      const middle: LngLat = [x / outer.length, y / outer.length];
      const inside = insideLngLat(point, outer);
      const d = inside ? 0 : Math.hypot((middle[0] - point[0]) * 111320 * cos, (middle[1] - point[1]) * 111320);
      if (d > radius || (best && d >= best.d)) return;
      let span = 0;
      for (const [lng, lat] of outer) {
        const r = Math.hypot((lng - middle[0]) * 111320 * cos, (lat - middle[1]) * 111320);
        if (r > span) span = r;
      }
      const ridge = roof.half > 0 && roof.peak < 1e6 ? roof.peak : 0;
      best = { middle, top: crest + Math.max(height, ridge), d, radius: Math.max(6, span) };
    });
    return best
      ? { middle: (best as { middle: LngLat }).middle, top: (best as { top: number }).top, radius: (best as { radius: number }).radius }
      : null;
  }

  /**
   * Street-facing, accessible window centres on the nearest house to `street`
   * (road pin). Only façades that open toward the street and are not blocked by
   * a neighbour. Rhythm follows the active architecture skin (esp. futuristic ribbons).
   */
  fireFacadesNear(
    street: LngLat,
    exaggeration: number,
    radius = 55,
    skin: SkinId = 'original',
    /** stop once we have this many panes — dense cities otherwise build thousands and hitch */
    maxPanes = Infinity,
  ): { middle: LngLat; crest: number; top: number; panes: { at: LngLat; altitude: number; oe: number; on: number }[] } | null {
    const { floor: FLOOR, spacing: SPACING, yMid } = fireWindowRhythm(skin);
    const cos = Math.cos(street[1] * Math.PI / 180);
    type Cand = { middle: LngLat; outer: [number, number][]; height: number; crest: number; d: number };
    let best: Cand | null = null;
    this.eachFootprint(street, radius, (rings, height, _roof, crest) => {
      const outer = rings()[0];
      if (!outer?.length || height < 2.4) return;
      let x = 0, y = 0;
      for (const [lng, lat] of outer) { x += lng; y += lat; }
      const middle: LngLat = [x / outer.length, y / outer.length];
      const inside = insideLngLat(street, outer);
      const d = inside ? 0 : Math.hypot((middle[0] - street[0]) * 111320 * cos, (middle[1] - street[1]) * 111320);
      if (d > radius || (best && d >= best.d)) return;
      best = { middle, outer: outer.map((p) => [...p] as [number, number]), height, crest, d };
    });
    if (!best) return null;
    const house = best as Cand;
    const toE = (lng: number, lat: number) => ({
      e: (lng - house.middle[0]) * METERS_PER_DEGREE * cos,
      n: (lat - house.middle[1]) * METERS_PER_DEGREE,
    });
    const streetDir = toE(street[0], street[1]);
    const streetLen = Math.hypot(streetDir.e, streetDir.n) || 1;
    streetDir.e /= streetLen;
    streetDir.n /= streetLen;

    // neighbour footprints for accessibility (blocked courtyards / party walls)
    const neighbours: [number, number][][] = [];
    this.eachFootprint(house.middle, 40, (rings) => {
      const outer = rings()[0];
      if (!outer?.length) return;
      // skip self (same middle-ish)
      let x = 0, y = 0;
      for (const [lng, lat] of outer) { x += lng; y += lat; }
      if (Math.hypot((x / outer.length - house.middle[0]) * 111320 * cos, (y / outer.length - house.middle[1]) * 111320) < 1.5) return;
      neighbours.push(outer);
    });

    const clear = house.height;
    const plinth = Math.min(0.42, Math.max(0.16, clear * 0.1));
    const cap = Math.min(0.5, Math.max(0.18, clear * 0.09));
    const usable = clear - plinth - cap;
    if (usable < 0.8) return null;
    let floors = Math.max(1, Math.round(usable / FLOOR));
    while (floors > 1 && usable / floors < 2.2) floors--;
    const body0 = house.crest + plinth;
    const floorH = usable / floors;
    const crestEx = house.crest * exaggeration;

    const panes: { at: LngLat; altitude: number; oe: number; on: number }[] = [];
    const ring = house.outer;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      const ae = toE(a[0], a[1]), be = toE(b[0], b[1]);
      const de = be.e - ae.e, dn = be.n - ae.n;
      const length = Math.hypot(de, dn);
      if (length < 2.5) continue;
      // outward = away from building middle
      let oe = dn / length, on = -de / length;
      const midE = (ae.e + be.e) * 0.5, midN = (ae.n + be.n) * 0.5;
      if (oe * midE + on * midN < 0) { oe = -oe; on = -on; }
      // street-facing: at least somewhat toward the road pin
      if (oe * streetDir.e + on * streetDir.n < 0.12) continue;
      // accessible: a few metres out is not inside a neighbour
      const probeLng = house.middle[0] + (midE + oe * 4) / (METERS_PER_DEGREE * cos);
      const probeLat = house.middle[1] + (midN + on * 4) / METERS_PER_DEGREE;
      if (neighbours.some((n) => insideLngLat([probeLng, probeLat], n))) continue;

      const columns = Math.max(1, Math.floor((length - 0.6) / SPACING));
      for (let fl = 0; fl < floors; fl++) {
        if (panes.length >= maxPanes) break;
        const altitude = (body0 + floorH * (fl + yMid)) * exaggeration;
        // skip very low ground-floor panes buried in plinth noise
        if (altitude < crestEx + 1.2) continue;
        for (let c = 0; c < columns; c++) {
          if (panes.length >= maxPanes) break;
          const t = (c + 0.5) / columns;
          const alongE = ae.e + de * t + oe * 0.08;
          const alongN = ae.n + dn * t + on * 0.08;
          const at: LngLat = [
            house.middle[0] + alongE / (METERS_PER_DEGREE * cos),
            house.middle[1] + alongN / METERS_PER_DEGREE,
          ];
          panes.push({ at, altitude, oe, on });
        }
      }
      if (panes.length >= maxPanes) break;
    }
    if (!panes.length) return null;
    return {
      middle: house.middle,
      crest: crestEx,
      top: (house.crest + house.height) * exaggeration,
      panes,
    };
  }

  /** Footprints with roof skins for vehicle collisions (`crest` already exaggerated). */
  buildingsNear(center: LngLat, radius: number, exaggeration: number): BuildingCollider[] {
    const out: BuildingCollider[] = [];
    this.eachFootprint(center, radius, (rings, _height, roof, crest) => {
      out.push({ rings: rings(), crest: crest * exaggeration, roof });
    });
    // street furniture: pedestals, basins, bus shelters (a car stops at them, flies over on a jump)
    const mx = mercatorX(center[0]), my = mercatorY(center[1]);
    const cos = Math.cos(center[1] * Math.PI / 180);
    for (const live of this.tiles.values()) {
      const m = live.data.vegetation.solids;
      if (!m?.length) continue;
      // skip whole tiles whose nearest corner is outside the query radius
      if (distanceToTile(mx, my, live.tile, cos) > radius + 80) continue;
      const [cx, cy] = live.data.corner;
      const k = 1 / live.data.metersScale;
      const ms = live.data.metersScale;
      const r2 = (radius / ms) * (radius / ms);
      for (let i = 0; i < m.length; i += SOLID_STRIDE) {
        // knocked-aside shelter: half-sizes zeroed so the car can drive through
        if (m[i + 3] < 1e-4 || m[i + 4] < 1e-4) continue;
        const x = cx + m[i], y = cy - m[i + 1];
        const dx = x - mx, dy = y - my;
        if (dx * dx + dy * dy > r2) continue;
        const c = Math.cos(m[i + 5]), s = Math.sin(m[i + 5]);
        const hw = m[i + 3] * k, hl = m[i + 4] * k;
        const ring: [number, number][] = [
          [lngFromMercator(x + c * -hw + s * -hl), latFromMercator(y - (-s * -hw + c * -hl))],
          [lngFromMercator(x + c * hw + s * -hl), latFromMercator(y - (-s * hw + c * -hl))],
          [lngFromMercator(x + c * hw + s * hl), latFromMercator(y - (-s * hw + c * hl))],
          [lngFromMercator(x + c * -hw + s * hl), latFromMercator(y - (-s * -hw + c * hl))],
        ];
        out.push({ rings: [ring], crest: m[i + 2] * exaggeration, roof: { eaves: m[i + 6], peak: m[i + 6], half: 0, ridgeA: null, ridgeB: null } });
      }
    }
    return out;
  }

  /**
   * Roof altitude under a point (exaggerated meters), or null if none.
   * Matches the drawn roof: flat slab or pitch falling from the ridge to the eaves.
   */
  roofAt(lng: number, lat: number, exaggeration: number): number | null {
    let best: number | null = null;
    const point: LngLat = [lng, lat];
    this.eachFootprint(point, 4, (rings, _height, roof, crest) => {
      const list = rings();
      if (!insideLngLat(point, list[0]) || list.slice(1).some((hole) => insideLngLat(point, hole))) return;
      const top = crest * exaggeration + roofClearanceAt(0, 0, roofInMeters(roof, lng, lat));
      if (best == null || top > best) best = top;
    });
    return best;
  }

  private footprintQuery = 0;

  /** Every building whose box comes within `radius` m of `center`, through the tile's bucket index. */
  private eachFootprint(
    center: LngLat,
    radius: number,
    visit: (rings: () => [number, number][][], height: number, roof: RoofProfile, crest: number) => void,
  ) {
    const mx = mercatorX(center[0]), my = mercatorY(center[1]);
    const query = ++this.footprintQuery;
    for (const live of this.tiles.values()) {
      const data = live.data.buildings;
      const f = data.footprints;
      const [cx, cy] = data.corner;
      const lx = mx - cx, lz = cy - my;
      const r = radius / data.metersScale;
      const span = tileSpan(data.tile.z);
      if (lx < -r || lz < -r || lx > span + r || lz > span + r) continue;
      const cell = FOOTPRINT_CELL / data.metersScale;
      const cells = this.footprintIndex(live, cell);
      const seen = live.footprintSeen!;
      for (let cj = Math.floor((lz - r) / cell); cj <= Math.floor((lz + r) / cell); cj++)
        for (let ci = Math.floor((lx - r) / cell); ci <= Math.floor((lx + r) / cell); ci++)
          for (const b of cells.get(cellKey(ci, cj)) ?? []) {
            if (seen[b] === query) continue;
            seen[b] = query;
            const i = b * 4;
            if (f.bounds[i] > lx + r || f.bounds[i + 2] < lx - r || f.bounds[i + 1] > lz + r || f.bounds[i + 3] < lz - r) continue;
            const rings = () => {
              const list: [number, number][][] = [];
              for (let ring = f.buildingStart[b]; ring < f.buildingStart[b + 1]; ring++) {
                const points: [number, number][] = [];
                for (let p = f.ringStart[ring]; p < f.ringStart[ring + 1]; p++) {
                  points.push([lngFromMercator(cx + f.coords[p * 2]), latFromMercator(cy - f.coords[p * 2 + 1])]);
                }
                list.push(points);
              }
              return list;
            };
            const o = b * ROOF_STRIDE;
            const roofs = f.roofs;
            const half = roofs[o + 6];
            const crest = roofs[o + 7];
            const eaves = roofs[o], peak = roofs[o + 1];
            // ridge endpoints as lng/lat (stored in RoofPoint.x/z)
            const roof: RoofProfile = half > 0
              ? {
                eaves, peak, half,
                ridgeA: { x: lngFromMercator(cx + roofs[o + 2]), z: latFromMercator(cy - roofs[o + 3]) },
                ridgeB: { x: lngFromMercator(cx + roofs[o + 4]), z: latFromMercator(cy - roofs[o + 5]) },
              }
              : { eaves, peak, half: 0, ridgeA: null, ridgeB: null };
            visit(rings, f.heights[b], roof, crest);
          }
    }
  }

  /** The tile's buildings by bucket: each building in every cell its box covers. */
  private footprintIndex(live: Live, cell: number) {
    if (live.footprintCells) return live.footprintCells;
    const f = live.data.buildings.footprints;
    const count = f.buildingStart.length - 1;
    const cells = new Map<number, number[]>();
    for (let b = 0; b < count; b++) {
      const i = b * 4;
      for (let cj = Math.floor(f.bounds[i + 1] / cell); cj <= Math.floor(f.bounds[i + 3] / cell); cj++)
        for (let ci = Math.floor(f.bounds[i] / cell); ci <= Math.floor(f.bounds[i + 2] / cell); ci++) {
          const k = cellKey(ci, cj), list = cells.get(k);
          if (list) list.push(b); else cells.set(k, [b]);
        }
    }
    live.footprintSeen = new Uint32Array(count);
    return (live.footprintCells = cells);
  }

  /** Spires and neon street lamps for the futuristic skin; hidden / swapped when off. */
  setSpires(on: boolean) {
    this.spiresOn = on;
    this.vegetation.setFuturistic(on);
    for (const live of this.tiles.values()) {
      if (on && !live.spires) this.buildSpires(live);
      if (live.spires) live.spires.visible = on;
    }
  }

  private buildSpires(live: Live) {
    const f = live.data.buildings.footprints;
    const toMerc = 1 / live.data.metersScale;
    const matrices: number[] = [], ground: number[] = [];
    const count = f.buildingStart.length - 1;
    for (let b = 0; b < count; b++) {
      const height = f.heights[b];
      const o = b * ROOF_STRIDE;
      if (height < 24 || (f.roofs[o + 6] ?? 0) > 0) continue; // tall and flat-roofed only
      const x = (f.bounds[b * 4] + f.bounds[b * 4 + 2]) / 2, z = (f.bounds[b * 4 + 1] + f.bounds[b * 4 + 3]) / 2;
      const roll = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      if (roll > 0.35) continue; // about a third of them; most towers stay plain
      const side = Math.min(f.bounds[b * 4 + 2] - f.bounds[b * 4], f.bounds[b * 4 + 3] - f.bounds[b * 4 + 1]) * live.data.metersScale;
      const r = Math.max(0.35, Math.min(1.4, side * 0.05));
      const h = Math.max(6, Math.min(38, height * (0.18 + roll * 0.4)));
      matrices.push(r * toMerc, 0, 0, 0, 0, h, 0, 0, 0, 0, r * toMerc, 0, x, height, z, 1);
      ground.push(f.roofs[o + 7] ?? 0);
    }
    if (!ground.length) return;
    if (!this.spireGeometry) {
      // a collar on the roof, a slim needle, a small ball near the tip
      const collar = new THREE.CylinderGeometry(1, 1.1, 0.05, 10).translate(0, 0.025, 0);
      const needle = new THREE.ConeGeometry(0.5, 0.95, 8).translate(0, 0.05 + 0.475, 0);
      const ball = new THREE.SphereGeometry(0.28, 8, 4).scale(1, 0.04 / 0.28 * 1, 1).translate(0, 0.62, 0);
      const parts = [collar, needle, ball].map((g) => { const n = g.toNonIndexed(); n.deleteAttribute('uv'); return n; });
      this.spireGeometry = mergeGeometries(parts, false)!;
      this.spireMaterial = simpleLit('#d9e1e6', this.uniforms, { shiny: true });
      this.spireMaterial.side = this.side;
    }
    const geometry = this.spireGeometry.clone();
    geometry.setAttribute('iGround', new THREE.InstancedBufferAttribute(new Float32Array(ground), 1));
    const mesh = new THREE.InstancedMesh(geometry, this.spireMaterial!, ground.length);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(matrices), 16);
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 400;
    mesh.visible = this.spiresOn;
    this.lampLit(mesh, live);
    live.group.add(mesh);
    live.group.updateMatrixWorld(true);
    live.spires = mesh;
    live.disposables.push(geometry);
  }

  /**
   * First tree or street lamp on the segment from → to (same frame as
   * raycastBuildings). `t` is the fraction along the segment. `reach` widens the
   * test (m), e.g. half a car's width: then the prop counts as a point.
   */
  raycastProps(from: LngLat, fromAlt: number, to: LngLat, toAlt: number, exaggeration: number, reach = 0) {
    let best: { t: number; point: LngLat; altitude: number; key: string; live: Live; index: number; dirX: number; dirZ: number } | null = null;
    const fx = mercatorX(from[0]), fy = mercatorY(from[1]), tx = mercatorX(to[0]), ty = mercatorY(to[1]);
    for (const live of this.tiles.values()) {
      const fell = live.data.vegetation.fell;
      if (!fell.length || !live.props.size) continue;
      const span = tileSpan(live.tile.z);
      const [cx, cy] = live.data.corner;
      // tile-local: x east, z south
      const ax = fx - cx, az = cy - fy, bx = tx - cx, bz = cy - ty;
      const pad = 12 / live.data.metersScale;
      if (Math.max(ax, bx) < -pad || Math.min(ax, bx) > span + pad || Math.max(az, bz) < -pad || Math.min(az, bz) > span + pad) continue;
      const dx = bx - ax, dz = bz - az, a = dx * dx + dz * dz;
      if (a < 1e-9) continue;
      const len = Math.sqrt(a);
      const cell = PROP_CELL / live.data.metersScale;
      const cells = this.propIndex(live, cell);
      const widest = (reach > 0 ? reach : 0.75) / live.data.metersScale;
      // only the buckets the segment's box touches
      const i0 = Math.floor((Math.min(ax, bx) - widest) / cell), i1 = Math.floor((Math.max(ax, bx) + widest) / cell);
      const j0 = Math.floor((Math.min(az, bz) - widest) / cell), j1 = Math.floor((Math.max(az, bz) + widest) / cell);
      for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) for (const i of cells.get(cellKey(ci, cj)) ?? []) {
        const kind = fell[i];
        // bullets: trunk/crown; car (reach>0): point + half-width. Shelters/statues/clutter are wider.
        const body = kind === 2 ? 1.4
          : kind === 3 || kind === 4 ? 0.9
            : kind === 5 ? 0.25
              : kind === 6 || kind === 7 ? 0.55
                : kind === 8 ? 1.05
                  : kind === 1 ? 0.3 : 0.75;
        const r = (reach > 0 ? Math.max(reach * (kind >= 5 ? 0.55 : 1), body * 0.5) : body) / live.data.metersScale;
        const ox = ax - fell[i + 1], oz = az - fell[i + 2];
        const b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - r * r;
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t < 0 || t > 1 || (best && t >= best.t)) continue;
        const altitude = fromAlt + (toAlt - fromAlt) * t;
        const base = fell[i + 3] * exaggeration;
        // car bumper (reach>0): DEM / driveHeights can sit a metre off the trunk base
        const top = reach > 0 ? Math.max(fell[i + 4], 3) : fell[i + 4];
        const loft = reach > 0 ? 2.5 : 0.3;
        if (altitude < base - loft || altitude > base + top) continue;
        const key = `${live.key}#${i}`;
        if (this.fallen.has(key)) continue; // already down
        const point: LngLat = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
        best = { t, point, altitude, key, live, index: i, dirX: dx / len, dirZ: dz / len };
      }
    }
    return best;
  }

  /** The tile's trees and lamps by bucket (tile-local mercator cells of `cell`). */
  private propIndex(live: Live, cell: number) {
    if (live.propCells) return live.propCells;
    const cells = new Map<number, number[]>();
    const fell = live.data.vegetation.fell;
    for (let i = 0; i < fell.length; i += FELL_STRIDE) {
      const k = cellKey(Math.floor(fell[i + 1] / cell), Math.floor(fell[i + 2] / cell));
      const list = cells.get(k);
      if (list) list.push(i); else cells.set(k, [i]);
    }
    return (live.propCells = cells);
  }

  /**
   * First intact bus-shelter glass pane on from → to. `t` is the fraction along
   * the segment (same frame as raycastProps). The metal frame stays; only glass
   * counts here.
   */
  raycastGlass(from: LngLat, fromAlt: number, to: LngLat, toAlt: number, exaggeration: number) {
    let best: { t: number; point: LngLat; altitude: number; key: string; live: Live; index: number } | null = null;
    const fx = mercatorX(from[0]), fy = mercatorY(from[1]), tx = mercatorX(to[0]), ty = mercatorY(to[1]);
    for (const live of this.tiles.values()) {
      const glass = live.data.vegetation.glass;
      if (!glass?.length || !live.props.has('shelterGlass')) continue;
      const span = tileSpan(live.tile.z);
      const [cx, cy] = live.data.corner;
      const ms = live.data.metersScale;
      const ax = fx - cx, az = cy - fy, bx = tx - cx, bz = cy - ty;
      const pad = 8 / ms;
      if (Math.max(ax, bx) < -pad || Math.min(ax, bx) > span + pad || Math.max(az, bz) < -pad || Math.min(az, bz) > span + pad) continue;
      const dx = bx - ax, dz = bz - az, dy = toAlt - fromAlt;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-12) continue;
      for (let i = 0, slot = 0; i < glass.length; i += GLASS_STRIDE, slot++) {
        const key = `${live.key}:glass#${slot}`;
        if (this.shattered.has(key)) continue;
        const gx = glass[i], gz = glass[i + 1], ground = glass[i + 2] * exaggeration, yaw = glass[i + 3];
        const c = Math.cos(yaw), s = Math.sin(yaw);
        // shelter-local meters (same yaw as the instance): glass sits near the back and one end
        const toLocal = (x: number, z: number, alt: number) => {
          const ex = (x - gx) * ms, ez = (z - gz) * ms;
          return { x: c * ex - s * ez, y: alt - ground, z: s * ex + c * ez };
        };
        const a = toLocal(ax, az, fromAlt), b = toLocal(bx, bz, toAlt);
        const hitT = glassPaneHit(a.x, a.y, a.z, b.x, b.y, b.z);
        if (hitT == null || hitT < 0 || hitT > 1 || (best && hitT >= best.t)) continue;
        const altitude = fromAlt + dy * hitT;
        const point: LngLat = [from[0] + (to[0] - from[0]) * hitT, from[1] + (to[1] - from[1]) * hitT];
        best = { t: hitT, point, altitude, key, live, index: slot };
      }
    }
    return best;
  }

  /** Hide a shelter's glass instance (shot went through the pane). */
  shatterGlass(hit: NonNullable<ReturnType<WorldTiles['raycastGlass']>>): boolean {
    if (this.shattered.has(hit.key)) return false;
    const meshes = hit.live.props.get('shelterGlass') ?? [];
    if (!meshes.length) return false;
    const matrices = meshes[0].instanceMatrix.array as Float32Array;
    const offset = hit.index * 16;
    if (offset + 16 > matrices.length) return false;
    const standing = matrices.slice(offset, offset + 16);
    // keep translation, collapse scale so the pane vanishes without shifting the frame
    const hidden = new Float32Array(16);
    hidden[12] = standing[12];
    hidden[13] = standing[13];
    hidden[14] = standing[14];
    hidden[15] = 1;
    this.write({ matrices, offset, standing, meshes }, hidden);
    this.shattered.set(hit.key, { live: hit.live, index: hit.index, parts: [{ matrices, offset, standing, meshes }], unseenSince: 0 });
    return true;
  }

  /**
   * Knock a prop over away from the shot / along the car's path.
   * `speed` is impact m/s (car); bullets omit it.
   * Returns km/h to shave: 50 tree/shelter, 10 bollard/bin/dumpster/fence, 0 else.
   */
  topple(hit: NonNullable<ReturnType<WorldTiles['raycastProps']>>, now: number, speed = 0): number {
    if (this.fallen.has(hit.key)) return 0;
    const { live, index } = hit;
    const fell = live.data.vegetation.fell;
    const kind = fell[index];
    const parts: Fallen['parts'] = [];
    const take = (kinds: string[], slot: number) => {
      const meshes = kinds.flatMap((k) => live.props.get(k) ?? []);
      if (!meshes.length || slot < 0) return;
      const matrices = meshes[0].instanceMatrix.array as Float32Array;
      parts.push({ matrices, offset: slot * 16, standing: matrices.slice(slot * 16, slot * 16 + 16), meshes });
    };
    let relight: (() => void) | undefined;
    let restoreSolid: (() => void) | undefined;
    const clearSolid = () => {
      const solid = fell[index + 7];
      const solids = live.data.vegetation.solids;
      const o = solid * SOLID_STRIDE;
      if (solid < 0 || o + 6 >= solids.length) return;
      const hw = solids[o + 3], hl = solids[o + 4], hh = solids[o + 6];
      solids[o + 3] = 0;
      solids[o + 4] = 0;
      solids[o + 6] = 0;
      restoreSolid = () => { solids[o + 3] = hw; solids[o + 4] = hl; solids[o + 6] = hh; };
    };
    if (kind === 1) {
      take(['lamp'], fell[index + 5]);
      relight = this.lampOut(live, index);
    } else if (kind === 2) {
      take(['shelter'], fell[index + 5]);
      take(['shelterGlass'], fell[index + 6]);
      clearSolid();
    } else if (kind === 3) {
      take(['figure'], fell[index + 5]); // plinth stays
    } else if (kind === 4) {
      take(['rider'], fell[index + 5]);
    } else if (kind === 5) {
      take(['bollard'], fell[index + 5]);
    } else if (kind === 6) {
      take(['bin'], fell[index + 5]);
    } else if (kind === 7) {
      take(['dumpster'], fell[index + 5]);
      clearSolid();
    } else if (kind === 8) {
      // one fence bay: both rails flop; posts stay for neighbouring sections
      take(['rail'], fell[index + 5]);
      take(['rail'], fell[index + 6]);
    } else {
      take([`flora${fell[index + 6]}`], fell[index + 5]); // the whole tree is one instance
    }
    if (!parts.length) return 0;
    // bin / dumpster: tip onto a box face; shelter: forward + a bit aside (car path)
    let dirX = hit.dirX, dirZ = hit.dirZ;
    if (kind === 6 || kind === 7) {
      const m = parts[0].standing;
      const yaw = Math.atan2(m[8], m[10]);
      const hitYaw = Math.atan2(dirX, dirZ);
      const snapped = yaw + Math.round((hitYaw - yaw) / (Math.PI / 2)) * (Math.PI / 2);
      dirX = Math.sin(snapped);
      dirZ = Math.cos(snapped);
    } else if (kind === 2) {
      // mostly along the car, ~25° aside so it clears the lane in view
      const hitYaw = Math.atan2(dirX, dirZ);
      const side = (Math.sin(hitYaw * 12.9898) >= 0 ? 1 : -1);
      const yaw = hitYaw + side * 0.42;
      dirX = Math.sin(yaw);
      dirZ = Math.cos(yaw);
    }
    // shelters/bollards: farther + faster the harder the hit
    const v = Math.max(speed, 4);
    const slideM = kind === 5 ? Math.min(55, 3 + v * 1.35)
      : kind === 2 ? Math.min(48, 5 + v * 1.15)
        : kind === 8 ? 1.6
          : kind === 6 || kind === 7 ? 1.2
            : 0;
    const fallS = kind === 2 ? Math.max(0.32, FALL_TIME - v * 0.012) : FALL_TIME;
    // shelter depth ~0.75 m past the foot — lift so the side rests on the ground
    const restLift = kind === 2 ? 0.95 : kind === 5 || kind === 6 || kind === 7 ? 0.35 : 0;
    this.fallen.set(hit.key, {
      live, index, kind, started: now, dirX, dirZ, slideM, fallS, restLift,
      parts, settled: false, unseenSince: 0, relight, restoreSolid,
    });
    if (kind === 0 || kind === 2) return 50;
    if (kind === 5 || kind === 6 || kind === 7 || kind === 8) return 10;
    return 0;
  }

  /**
   * Animate falling props; stand them up again only after they've been off-screen
   * a long while *and* the focus has driven far away — so a quick glance back
   * or a U-turn nearby doesn't pop them upright.
   */
  updateFallen(now: number, clip: THREE.Matrix4, focus?: LngLat) {
    if (!this.fallen.size && !this.shattered.size) return;
    this.frustum.setFromProjectionMatrix(clip);
    const pivot = this.fallPivot, turn = this.fallTurn, back = this.fallBack, m = this.fallMat;
    const scaleIn = this.fallScaleIn, scaleOut = this.fallScaleOut;
    const axis = this.fallAxis, p = this.fallPoint, sphere = this.fallSphere;
    const exag = this.uniforms.uExag.value;
    const focusX = focus ? mercatorX(focus[0]) : null;
    const focusY = focus ? mercatorY(focus[1]) : null;
    if (this.fallen.size) for (const [key, f] of this.fallen) {
      const fell = f.live.data.vegetation.fell, i = f.index;
      const x = fell[i + 1], z = fell[i + 2], top = fell[i + 4];
      const toMerc = 1 / f.live.data.metersScale;
      const ms = f.live.data.metersScale;
      if (f.settled) {
        // fat sphere so “just off the edge of the screen” still counts as seen
        p.set(x + f.dirX * top * 0.5 * toMerc, fell[i + 3] * exag, z + f.dirZ * top * 0.5 * toMerc).applyMatrix4(f.live.group.matrixWorld);
        sphere.set(p, Math.max(top * 1.4, 18));
        if (this.frustum.intersectsSphere(sphere)) { f.unseenSince = 0; continue; }
        if (focusX != null && focusY != null) {
          const [cx, cy] = f.live.data.corner;
          const away = Math.hypot((cx + x) - focusX, (cy - z) - focusY) * ms;
          if (away < RESTORE_AWAY_M) { f.unseenSince = 0; continue; }
        }
        if (!f.unseenSince) { f.unseenSince = now; continue; }
        if (now - f.unseenSince < UNSEEN_RESTORE * 1000) continue;
        for (const part of f.parts) this.write(part, part.standing);
        this.fallen.delete(key);
        f.relight?.();
        f.restoreSolid?.();
        continue;
      }
      // falls like a cut tree: slow start, hits the ground fast (shelters finish quicker when hit hard)
      const k = Math.min(1, (now - f.started) / 1000 / f.fallS);
      // shelter flops flat onto a side; fence tips; bollard/bin/dumpster onto a face; statues off the plinth
      const maxAngle = f.kind === 2 || f.kind === 5 || f.kind === 6 || f.kind === 7 ? FALL_ANGLE
        : f.kind === 8 ? FALL_ANGLE * 0.85
          : FALL_ANGLE;
      const angle = maxAngle * k * k;
      // shelters/bollards ease out so they keep sailing forward late in the tip
      const slideK = f.kind === 2 || f.kind === 5 ? 1 - (1 - k) * (1 - k) : k * k;
      const slide = f.slideM * slideK * toMerc;
      // lift while tipping: the resting face sits on the ground instead of burying past the foot
      const lift = f.restLift * Math.sin(angle);
      // rotate in true meters (x, z are mercator meters here), about the foot of the prop
      axis.set(f.dirZ, 0, -f.dirX); // up × direction: the top swings toward the direction
      scaleIn.makeScale(toMerc, 1, toMerc);
      scaleOut.makeScale(1 / toMerc, 1, 1 / toMerc);
      pivot.makeTranslation(x + f.dirX * slide, lift, z + f.dirZ * slide).multiply(scaleIn);
      back.copy(scaleOut).multiply(this.fallShift.makeTranslation(-x, 0, -z));
      turn.makeRotationAxis(axis, angle);
      for (const part of f.parts) {
        m.fromArray(part.standing).premultiply(back).premultiply(turn).premultiply(pivot);
        this.write(part, m.elements);
      }
      if (k >= 1) f.settled = true;
    }
    // shattered bus-stop glass: same late restore as fallen props
    if (this.shattered.size) for (const [key, g] of this.shattered) {
      const glass = g.live.data.vegetation.glass;
      const i = g.index * GLASS_STRIDE;
      if (i + 3 >= glass.length) { this.shattered.delete(key); continue; }
      const ms = g.live.data.metersScale;
      p.set(glass[i], glass[i + 2] * exag, glass[i + 1]).applyMatrix4(g.live.group.matrixWorld);
      sphere.set(p, 18);
      if (this.frustum.intersectsSphere(sphere)) { g.unseenSince = 0; continue; }
      if (focusX != null && focusY != null) {
        const [cx, cy] = g.live.data.corner;
        const away = Math.hypot((cx + glass[i]) - focusX, (cy - glass[i + 1]) - focusY) * ms;
        if (away < RESTORE_AWAY_M) { g.unseenSince = 0; continue; }
      }
      if (!g.unseenSince) { g.unseenSince = now; continue; }
      if (now - g.unseenSince < UNSEEN_RESTORE * 1000) continue;
      for (const part of g.parts) this.write(part, part.standing);
      this.shattered.delete(key);
    }
  }

  /**
   * A street lamp goes dark: its cone of light goes out and its pool is taken out of
   * the tile's baked light (re-baked from the lamps still standing around it).
   * Returns how to light it again.
   */
  private lampOut(live: Live, index: number): () => void {
    const fell = live.data.vegetation.fell, lamps = live.data.vegetation.lamps;
    const slot = fell[index + 5] * 16;
    const beam = live.props.get('lampBeam')?.[0];
    const standing = beam ? (beam.instanceMatrix.array as Float32Array).slice(slot, slot + 16) : null;
    const headOf = (i: number) => {
      const o = fell[i + 5] * 16;
      return [fell[i + 1] + lamps.matrices[o] * LAMP_ARM, fell[i + 2] + lamps.matrices[o + 2] * LAMP_ARM];
    };
    const [hx, hz] = headOf(index);
    const rebake = () => {
      const span = tileSpan(live.tile.z);
      const region = lampRegion(hx, hz, span, live.data.metersScale);
      // every standing lamp whose pool reaches into the patch
      const heads: number[] = [];
      const near = 2 * 11 / live.data.metersScale;
      for (let i = 0; i < fell.length; i += FELL_STRIDE) {
        if (fell[i] !== 1 || this.fallen.has(`${live.key}#${i}`)) continue;
        const [x, z] = headOf(i);
        if (Math.abs(x - hx) < near && Math.abs(z - hz) < near) heads.push(x, z);
      }
      bakeLampLight(heads, span, live.data.metersScale, live.data.vegetation.lampLight, region);
      live.lampMap.needsUpdate = true;
    };
    const setBeam = (values: ArrayLike<number> | null) => {
      if (!beam || !values) return;
      (beam.instanceMatrix.array as Float32Array).set(values, slot);
      beam.instanceMatrix.needsUpdate = true;
    };
    const lamp = live.props.get('lamp')?.[0];
    const setOn = (on: number) => {
      const attr = lamp?.geometry.getAttribute('iOn') as THREE.InstancedBufferAttribute | undefined;
      if (!attr) return;
      attr.setX(fell[index + 5], on);
      attr.needsUpdate = true;
    };
    setBeam(new Float32Array(16)); // a zero matrix: the cone collapses to nothing
    setOn(0); // the head goes dark
    // the lamp is already in `fallen` when this runs from topple; bake after it is registered
    queueMicrotask(rebake);
    return () => { setBeam(standing); setOn(1); rebake(); };
  }

  private write(part: Fallen['parts'][number], values: ArrayLike<number>) {
    for (let j = 0; j < 16; j++) part.matrices[part.offset + j] = values[j];
    for (const mesh of part.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * First building hit on the segment from → to (lng/lat + altitude in meters,
   * altitudes as drawn, like ThreeMap.groundAt). Used for gunfire.
   */
  raycastBuildings(from: LngLat, fromAlt: number, to: LngLat, toAlt: number, exaggeration: number) {
    const cos = Math.cos(from[1] * Math.PI / 180);
    const dx = (to[0] - from[0]) * METERS_PER_DEGREE * cos, dy = (to[1] - from[1]) * METERS_PER_DEGREE;
    const length = Math.hypot(dx, dy);
    if (length < 0.5) return null;
    const mid: LngLat = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    type Cand = { rings: [number, number][][]; crest: number; roof: RoofProfile; peak: number };
    const candidates: Cand[] = [];
    this.eachFootprint(mid, length / 2 + 30, (rings, height, roof, crest) => {
      candidates.push({ rings: rings(), crest: crest * exaggeration, roof, peak: crest * exaggeration + height });
    });
    if (!candidates.length) return null;
    const steps = Math.ceil(length / 0.75);
    const m = (q: LngLat): [number, number] => [(q[0] - from[0]) * METERS_PER_DEGREE * cos, (q[1] - from[1]) * METERS_PER_DEGREE];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const p: LngLat = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const altitude = fromAlt + (toAlt - fromAlt) * t;
      for (const c of candidates) {
        if (altitude > c.peak) continue;
        if (!insideLngLat(p, c.rings[0]) || c.rings.slice(1).some((hole) => insideLngLat(p, hole))) continue;
        const roofHere = c.crest + roofClearanceAt(0, 0, roofInMeters(c.roof, p[0], p[1]));
        if (altitude > roofHere) continue;
        const prevT = (s - 1) / steps;
        const q: LngLat = [from[0] + (to[0] - from[0]) * prevT, from[1] + (to[1] - from[1]) * prevT];
        const prevAlt = fromAlt + (toAlt - fromAlt) * prevT;
        // came in through the roof, or through a wall: find the crossed edge
        if (prevAlt > roofHere + 0.05) return { point: p, altitude: roofHere, normal: [0, 1, 0] as [number, number, number] };
        const [qx, qz] = m(q), [px, pz] = m(p);
        let best: { t: number; nx: number; nz: number } | null = null;
        for (const ring of c.rings) {
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ax, az] = m(ring[j]), [bx, bz] = m(ring[i]);
            const den = (px - qx) * (bz - az) - (pz - qz) * (bx - ax);
            if (Math.abs(den) < 1e-9) continue;
            const u = ((ax - qx) * (bz - az) - (az - qz) * (bx - ax)) / den;
            const v = ((ax - qx) * (pz - qz) - (az - qz) * (px - qx)) / den;
            if (u < 0 || u > 1 || v < 0 || v > 1 || (best && u >= best.t)) continue;
            const ex = bx - ax, ez = bz - az, len = Math.hypot(ex, ez) || 1;
            let nx = -ez / len, nz = ex / len;
            if (nx * (qx - px) + nz * (qz - pz) < 0) { nx = -nx; nz = -nz; } // face the shooter
            best = { t: u, nx, nz };
          }
        }
        const hitT = best ? prevT + (t - prevT) * best.t : t;
        const point: LngLat = [from[0] + (to[0] - from[0]) * hitT, from[1] + (to[1] - from[1]) * hitT];
        // east, up, north
        return { point, altitude: fromAlt + (toAlt - fromAlt) * hitT, normal: (best ? [best.nx, 0, best.nz] : [0, 1, 0]) as [number, number, number] };
      }
    }
    return null;
  }

  /** Every layer name seen in loaded tiles (poi, housenumber, mountain_peak, …). */
  layerNames() {
    const names = new Set<string>();
    for (const live of this.tiles.values()) for (const name of live.data.layers) names.add(name);
    return [...names].sort();
  }

  loadedAround(focus: LngLat, radius: number) {
    const wanted = tilesAround(focus, radius, this.options.zoom);
    return wanted.length > 0 && wanted.every((t) => this.tiles.has(t.key) && !this.tiles.get(t.key)!.waiting.length);
  }

  stats(): WorldTileStats {
    let buildings = 0, bytes = 0;
    for (const live of this.tiles.values()) {
      buildings += live.data.buildings.stats.buildings;
      bytes += live.data.buildings.stats.bytes + live.data.raw.byteLength
        + [live.data.ground.terrain, ...live.data.ground.layers, live.data.ground.water].reduce((n, m) => n + m.positions.byteLength * 2, 0)
        + live.data.roads.positions.byteLength * 2;
    }
    const avg = (l: number[]) => l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
    return { loaded: this.tiles.size, inFlight: this.pending.size, buildings, residentMB: bytes / 1048576, avgFetchMs: avg(this.fetchTimes), avgBuildMs: avg(this.buildTimes) };
  }

  dispose() {
    this.disposed = true;
    for (const [key, live] of [...this.tiles]) this.unload(key, live);
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const m of [this.roadMat, this.farMat, this.groundMat, this.waterMat, ...this.overlayMats]) m.dispose();
    this.vegetation.dispose();
    this.spireGeometry?.dispose();
    this.spireMaterial?.dispose();
  }
}

function insideLngLat(point: LngLat, ring: [number, number][]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** Ridge lng/lat (in RoofPoint.x/z) → true meters relative to an origin. */
function roofInMeters(roof: RoofProfile, originLng: number, originLat: number): RoofProfile {
  if (roof.half <= 0 || !roof.ridgeA || !roof.ridgeB) {
    return { eaves: roof.eaves, peak: roof.peak, half: 0, ridgeA: null, ridgeB: null };
  }
  const cos = Math.cos(originLat * Math.PI / 180);
  const toLocal = (lng: number, lat: number) => ({
    x: (lng - originLng) * METERS_PER_DEGREE * cos,
    z: (lat - originLat) * METERS_PER_DEGREE,
  });
  return {
    eaves: roof.eaves,
    peak: roof.peak,
    half: roof.half,
    ridgeA: toLocal(roof.ridgeA.x, roof.ridgeA.z),
    ridgeB: toLocal(roof.ridgeB.x, roof.ridgeB.z),
  };
}

export { tileCorner };
