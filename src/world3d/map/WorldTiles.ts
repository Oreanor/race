import * as THREE from 'three';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { ChunkData } from '../tiles/buildTile';
import { ROOF_STRIDE } from '../tiles/buildTile';
import type { GeoFeature, MeshData, WorldTileData } from '../tiles/worldTile';
import { bridgeDeck, gridGround, gridWaterLevel, pickDriveHeight } from '../tiles/worldTile';
import { tileTemplate } from '../tiles/tileSource';
import { tilesAround, distanceToTile } from '../tiles/tilePlan';
import { latFromMercator, lngFromMercator, mercatorX, mercatorY, tileAt, tileCorner, tileSpan, WORLD_SIZE, type LngLat, type TileId } from '../mercator';
import { farBuildingMaterial, groundMaterial, overlayMaterial, roadMaterial, waterMaterial, type BaseUniforms } from './materials';
import { VegetationRenderer } from './vegetation';
import { simpleLit } from './simpleLit';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bakeLampLight, FELL_STRIDE, LAMP_ARM, LAMP_MAP, lampRegion, SOLID_STRIDE } from '../tiles/vegetationTile';
import { roofClearanceAt, type RoofProfile } from '@/game/buildings/RoofGenerator';

/** top of the pavement above the terrain (road ribbons sit 0.09–0.15 m up) */
export const ROAD_TOP = 0.12;

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
  maxInFlight: 4,
  uploadsPerFrame: 2,
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
  roads: THREE.Mesh | null;
  disposables: { dispose(): void }[];
  /** lazily decoded non-gameplay layers (poi, housenumber, place…) */
  extra: Map<string, GeoFeature[]>;
  /** vegetation meshes by kind (trunk, leaf0…, lamp), for knocking things over */
  props: Map<string, THREE.InstancedMesh[]>;
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
};

/** A tree or lamp knocked over by gunfire; it stands up again once out of sight. */
type Fallen = {
  live: Live;
  /** index into the tile's fell list */
  index: number;
  started: number;
  /** tips toward this direction (tile-local, unit, horizontal) */
  dirX: number;
  dirZ: number;
  /** the instance matrices it moves, with their standing copies */
  parts: { matrices: Float32Array; offset: number; standing: Float32Array; meshes: THREE.InstancedMesh[] }[];
  settled: boolean;
  /** since when it has been out of the view (0 = in view) */
  unseenSince: number;
  /** a street lamp: put its light back when it stands up again */
  relight?: () => void;
};

const FALL_TIME = 0.75; // s
/** bucket size (m) of the tree / lamp index */
const PROP_CELL = 16;
/** bucket size (m) of the building index */
const FOOTPRINT_CELL = 64;
const cellKey = (i: number, j: number) => i * 73856093 ^ j * 19349663;
const FALL_ANGLE = Math.PI / 2 - 0.06; // lies almost flat, a bit propped on the crown
const UNSEEN_RESTORE = 1.2; // s out of view before it stands again

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
  private spiresOn = false;
  private side: THREE.Side = THREE.FrontSide;
  private spireGeometry: THREE.BufferGeometry | null = null;
  private spireMaterial: THREE.Material | null = null;
  private frustum = new THREE.Frustum();
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

  update(focus: LngLat) {
    if (this.disposed || !this.template) return;
    const o = this.options;
    const wanted = tilesAround(focus, o.loadRadius, o.zoom);
    const keep = new Set(tilesAround(focus, o.unloadRadius, o.zoom).map((t) => t.key));
    for (const [key, live] of this.tiles) if (!keep.has(key)) this.unload(key, live);
    for (const [key, job] of this.pending) {
      if (keep.has(key)) continue;
      this.cancel(job.id);
      this.pending.delete(key);
    }
    const now = performance.now();
    for (const plan of wanted) {
      if (this.tiles.has(plan.key) || this.pending.has(plan.key)) continue;
      const failed = this.failures.get(plan.key);
      if (failed && (failed.count >= 4 || now < failed.at)) continue;
      if (this.pending.size >= o.maxInFlight) break;
      this.request(plan.key, plan.tile);
    }
    let budget = o.uploadsPerFrame;
    for (const plan of wanted) {
      const live = this.tiles.get(plan.key);
      while (live && live.waiting.length && budget > 0) { live.waiting.shift()!(); budget--; }
      if (budget <= 0) break;
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
    lampMap.minFilter = THREE.LinearMipmapLinearFilter;
    lampMap.magFilter = THREE.LinearFilter;
    lampMap.generateMipmaps = true;
    lampMap.needsUpdate = true;
    const live: Live = { key, tile: data.tile, data, group, waiting: [], roads: null, disposables: [lampMap], extra: new Map(), props: new Map(), propCells: null, footprintCells: null, footprintSeen: null, lampMap, spires: null };
    this.place(live);
    this.root.add(group);
    this.tiles.set(key, live);

    // Ground and roads first (cheap, and they define the street layout), buildings after.
    live.waiting.push(() => {
      // vector ground: terrain, then land use (three layers), then water and roads
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
      if (g.water.index.length) {
        const water = this.mesh(g.water, this.waterMat, false);
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
        const streams = this.mesh(data.streams, this.waterMat, false);
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
      // static meshes: matrixAutoUpdate is off, so place them explicitly
      group.updateMatrixWorld(true);
    });
    for (const chunk of data.buildings.chunks) live.waiting.push(() => this.addChunk(live, chunk));
    live.waiting.push(() => {
      const meshes = [...this.vegetation.build(data.vegetation), ...this.vegetation.buildAccents(data.buildings.accents)];
      for (const mesh of meshes) {
        group.add(mesh);
        const list = live.props.get(mesh.name);
        if (list) list.push(mesh); else live.props.set(mesh.name, [mesh]);
      }
      group.updateMatrixWorld(true);
      live.disposables.push({ dispose: () => this.vegetation.release(meshes) });
      if (this.spiresOn) this.buildSpires(live);
    });
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
    // ground lifts by up to a few hundred meters with exaggeration: keep culling generous
    if (geometry.boundingSphere) geometry.boundingSphere.radius += 400;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /**
   * The materials are shared by every tile; each tile has its own street-light map.
   * Hand this mesh's tile map to its material right before it draws.
   */
  private lampLit<T extends THREE.Mesh>(mesh: T, live: Live): T {
    mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
      const uniforms = (material as THREE.ShaderMaterial).uniforms;
      if (!uniforms?.uLampMap || uniforms.uLampMap.value === live.lampMap) return;
      uniforms.uLampMap.value = live.lampMap;
      (material as THREE.ShaderMaterial).uniformsNeedUpdate = true;
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
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(chunk.cx, chunk.maxHeight / 2, chunk.cz), Math.hypot(chunk.radius * Math.SQRT2, chunk.maxHeight) + 400);
    const mesh = this.lampLit(new THREE.Mesh(geometry, this.farMat), live);
    mesh.matrixAutoUpdate = false;
    live.group.add(mesh);
    mesh.updateMatrixWorld(true);
    live.disposables.push(geometry);
  }

  private unload(key: string, live: Live) {
    for (const [id, f] of this.fallen) if (f.live === live) this.fallen.delete(id);
    this.root.remove(live.group);
    for (const fn of live.waiting.splice(0)) void fn; // never uploaded
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
      if (!live.props.size || !live.group.visible) continue;
      const size = tileSpan(live.tile.z) * this.sceneScale;
      const x0 = live.group.position.x, z0 = live.group.position.z;
      const dx = Math.max(x0 - eye.x, 0, eye.x - (x0 + size)), dz = Math.max(z0 - eye.z, 0, eye.z - (z0 + size));
      const meshes: THREE.InstancedMesh[] = [];
      for (const [name, list] of live.props) if (name.startsWith('flora')) meshes.push(...list);
      this.vegetation.floraDetail(meshes, Math.hypot(dx, dz, above));
    }
  }

  cullBeyond(focus: LngLat, distance: number) {
    const mx = mercatorX(focus[0]), my = mercatorY(focus[1]);
    const cos = Math.cos(focus[1] * Math.PI / 180);
    for (const live of this.tiles.values()) live.group.visible = distanceToTile(mx, my, live.tile, cos) <= distance;
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
    let ground = gridGround(live.data.ground.heights, this.options.grid, u, v);
    // carved baths are only visual — don't drop the car into a 2 m hole (launches on the way out)
    const water = gridWaterLevel(live.data.ground.waterLevel, this.options.grid, u, v);
    if (water != null && ground < water - 0.4) ground = water - 0.12;
    const deck = bridgeDeck(live.data.bridges, x, z);
    // roads lie on the terrain, lifted a little: wheels stand on the pavement, not in it
    return pickDriveHeight(ground, deck, atAltitude == null ? undefined : atAltitude - ROAD_TOP) + ROAD_TOP;
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
   * within `radius` m. Its middle and the height of its top (m, not exaggerated).
   */
  houseAt(point: LngLat, radius: number): { middle: LngLat; top: number } | null {
    let best: { middle: LngLat; top: number; d: number } | null = null;
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
      const ridge = roof.half > 0 && roof.peak < 1e6 ? roof.peak : 0;
      best = { middle, top: crest + Math.max(height, ridge), d };
    });
    return best ? { middle: (best as { middle: LngLat }).middle, top: (best as { top: number }).top } : null;
  }

  /** Footprints with roof skins for vehicle collisions (`crest` already exaggerated). */
  buildingsNear(center: LngLat, radius: number, exaggeration: number): BuildingCollider[] {
    const out: BuildingCollider[] = [];
    this.eachFootprint(center, radius, (rings, _height, roof, crest) => {
      out.push({ rings: rings(), crest: crest * exaggeration, roof });
    });
    // street furniture: pedestals, basins, bus shelters (a car stops at them, flies over on a jump)
    const mx = mercatorX(center[0]), my = mercatorY(center[1]);
    for (const live of this.tiles.values()) {
      const m = live.data.vegetation.solids;
      if (!m?.length) continue;
      const [cx, cy] = live.data.corner;
      const k = 1 / live.data.metersScale;
      for (let i = 0; i < m.length; i += SOLID_STRIDE) {
        const x = cx + m[i], y = cy - m[i + 1];
        if (Math.hypot(x - mx, y - my) * live.data.metersScale > radius) continue;
        const c = Math.cos(m[i + 5]), s = Math.sin(m[i + 5]);
        const ring: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
          const ex = a * m[i + 3] * k, ez = b * m[i + 4] * k;
          // yaw as the instance matrix turns it (x east, z south)
          return [lngFromMercator(x + c * ex + s * ez), latFromMercator(y - (-s * ex + c * ez))];
        });
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
        // bullets: the trunk plus some crown; a car (reach > 0): the trunk is just a point
        const r = (reach > 0 ? reach : fell[i] === 1 ? 0.3 : 0.75) / live.data.metersScale;
        const ox = ax - fell[i + 1], oz = az - fell[i + 2];
        const b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - r * r;
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t < 0 || t > 1 || (best && t >= best.t)) continue;
        const altitude = fromAlt + (toAlt - fromAlt) * t;
        const base = fell[i + 3] * exaggeration;
        if (altitude < base - 0.3 || altitude > base + fell[i + 4]) continue;
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

  /** Knock a tree or lamp over, away from the shot. */
  /** True when a tree (not a lamp) went down. */
  topple(hit: NonNullable<ReturnType<WorldTiles['raycastProps']>>, now: number): boolean {
    if (this.fallen.has(hit.key)) return false;
    const { live, index } = hit;
    const fell = live.data.vegetation.fell;
    const parts: Fallen['parts'] = [];
    const take = (kinds: string[], slot: number) => {
      const meshes = kinds.flatMap((k) => live.props.get(k) ?? []);
      if (!meshes.length || slot < 0) return;
      const matrices = meshes[0].instanceMatrix.array as Float32Array;
      parts.push({ matrices, offset: slot * 16, standing: matrices.slice(slot * 16, slot * 16 + 16), meshes });
    };
    let relight: (() => void) | undefined;
    if (fell[index] === 1) {
      take(['lamp'], fell[index + 5]);
      relight = this.lampOut(live, index);
    }
    else take([`flora${fell[index + 6]}`], fell[index + 5]); // the whole tree is one instance
    if (!parts.length) return false;
    this.fallen.set(hit.key, { live, index, started: now, dirX: hit.dirX, dirZ: hit.dirZ, parts, settled: false, unseenSince: 0, relight });
    return fell[index] !== 1;
  }

  /** Animate falling props; stand them up again once they have been out of view a moment. `clip`: scene → clip. */
  updateFallen(now: number, clip: THREE.Matrix4) {
    if (!this.fallen.size) return;
    this.frustum.setFromProjectionMatrix(clip);
    const pivot = new THREE.Matrix4(), turn = new THREE.Matrix4(), back = new THREE.Matrix4(), m = new THREE.Matrix4();
    const axis = new THREE.Vector3(), p = new THREE.Vector3(), sphere = new THREE.Sphere();
    const exag = this.uniforms.uExag.value;
    for (const [key, f] of this.fallen) {
      const fell = f.live.data.vegetation.fell, i = f.index;
      const x = fell[i + 1], z = fell[i + 2], top = fell[i + 4];
      const toMerc = 1 / f.live.data.metersScale;
      if (f.settled) {
        // in view? a sphere around the lying prop, in scene space
        p.set(x + f.dirX * top * 0.5 * toMerc, fell[i + 3] * exag, z + f.dirZ * top * 0.5 * toMerc).applyMatrix4(f.live.group.matrixWorld);
        sphere.set(p, top);
        if (this.frustum.intersectsSphere(sphere)) { f.unseenSince = 0; continue; }
        if (!f.unseenSince) { f.unseenSince = now; continue; }
        if (now - f.unseenSince < UNSEEN_RESTORE * 1000) continue;
        for (const part of f.parts) this.write(part, part.standing);
        this.fallen.delete(key);
        f.relight?.();
        continue;
      }
      // falls like a cut tree: slow start, hits the ground fast
      const k = Math.min(1, (now - f.started) / 1000 / FALL_TIME);
      const angle = FALL_ANGLE * k * k;
      // rotate in true meters (x, z are mercator meters here), about the foot of the prop
      axis.set(f.dirZ, 0, -f.dirX); // up × direction: the top swings toward the direction
      pivot.makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeScale(toMerc, 1, toMerc));
      back.makeScale(1 / toMerc, 1, 1 / toMerc).multiply(new THREE.Matrix4().makeTranslation(-x, 0, -z));
      turn.makeRotationAxis(axis, angle);
      for (const part of f.parts) {
        m.fromArray(part.standing).premultiply(back).premultiply(turn).premultiply(pivot);
        this.write(part, m.elements);
      }
      if (k >= 1) f.settled = true;
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
    const dx = (to[0] - from[0]) * 111319.49 * cos, dy = (to[1] - from[1]) * 111319.49;
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
    const m = (q: LngLat): [number, number] => [(q[0] - from[0]) * 111319.49 * cos, (q[1] - from[1]) * 111319.49];
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
    x: (lng - originLng) * 111319.49 * cos,
    z: (lat - originLat) * 111319.49,
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
