import * as THREE from 'three';
import type { ChunkData, TileData } from './buildTile.ts';
import { TileClient } from './TileClient.ts';
import { tilesAround } from './tilePlan.ts';
import { LocalFrame, latFromMercator, lngFromMercator, mercatorX, mercatorY, tileSpan, type LngLat, type TileId } from '../mercator.ts';

export type WindowMode = 'texture' | 'instanced' | 'hybrid' | 'none';

export type TileManagerOptions = {
  zoom: number;
  /** load tiles that come within this many meters of the focus */
  loadRadius: number;
  /** unload tiles farther than this (hysteresis against thrashing) */
  unloadRadius: number;
  /** hide chunks beyond this distance from the camera */
  drawDistance: number;
  /** instanced windows are drawn only this close in hybrid mode */
  windowDistance: number;
  maxInFlight: number;
  /** chunk meshes uploaded per frame, spreads GPU upload cost */
  uploadsPerFrame: number;
  chunksPerTile: number;
  cacheTiles: number;
};

export const defaultTileOptions: TileManagerOptions = {
  zoom: 14,
  loadRadius: 1500,
  unloadRadius: 2300,
  drawDistance: 1700,
  windowDistance: 450,
  maxInFlight: 4,
  uploadsPerFrame: 3,
  chunksPerTile: 4,
  cacheTiles: 4,
};

export type BuildingMaterials = {
  textured: THREE.Material;
  plain: THREE.Material;
  windows: THREE.Material;
  windowBase: THREE.InstancedBufferGeometry;
};

type LiveChunk = {
  data: ChunkData;
  mesh: THREE.Mesh;
  windows: THREE.Mesh | null;
};

type LiveTile = {
  key: string;
  tile: TileId;
  data: TileData;
  group: THREE.Group;
  chunks: LiveChunk[];
  waiting: ChunkData[];
};

type Flight = { key: string; tile: TileId; cancel: () => void; started: number };

export type TileManagerStats = {
  tilesLoaded: number;
  tilesInFlight: number;
  tilesQueued: number;
  chunksLive: number;
  chunksVisible: number;
  buildings: number;
  /** triangles resident on the GPU (not per frame) */
  residentTriangles: number;
  windowsResident: number;
  residentMB: number;
  avgFetchMs: number;
  avgBuildMs: number;
  failures: number;
  threaded: boolean;
};

const tmp = new THREE.Vector3();
const corner = { x: 0, z: 0 };

export class TileManager {
  private tiles = new Map<string, LiveTile>();
  private flights = new Map<string, Flight>();
  private cache = new Map<string, TileData>();
  private failures = new Map<string, { count: number; retryAt: number }>();
  private queuedCount = 0;
  private fetchTimes: number[] = [];
  private buildTimes: number[] = [];
  private failureCount = 0;
  private windowMode: WindowMode = 'texture';
  private visibleChunks = 0;
  private client = new TileClient();
  private disposed = false;
  /** bumps whenever the set of loaded buildings changes */
  revision = 0;

  constructor(
    private scene: THREE.Scene,
    private frame: LocalFrame,
    private materials: BuildingMaterials,
    readonly options: TileManagerOptions = defaultTileOptions,
  ) {}

  setWindowMode(mode: WindowMode) {
    this.windowMode = mode;
  }

  /** Plan, stream and upload. Call once per frame. */
  update(focus: LngLat, camera: THREE.Vector3) {
    if (this.disposed) return;
    const now = performance.now();
    const o = this.options;
    const wanted = tilesAround(focus, o.loadRadius, o.zoom);
    const keep = new Set(tilesAround(focus, o.unloadRadius, o.zoom).map((t) => t.key));

    // unload far tiles, cancel far requests
    for (const [key, live] of this.tiles) if (!keep.has(key)) this.unload(key, live);
    for (const [key, flight] of this.flights) {
      if (!keep.has(key)) {
        flight.cancel();
        this.flights.delete(key);
      }
    }

    // request nearest missing tiles first
    let queued = 0;
    for (const plan of wanted) {
      if (this.tiles.has(plan.key) || this.flights.has(plan.key)) continue;
      const cached = this.cache.get(plan.key);
      if (cached) {
        this.cache.delete(plan.key);
        this.install(plan.key, cached);
        continue;
      }
      const failed = this.failures.get(plan.key);
      if (failed && (failed.count >= 4 || now < failed.retryAt)) continue;
      if (this.flights.size >= o.maxInFlight) { queued++; continue; }
      this.start(plan.key, plan.tile);
    }
    this.queuedCount = queued;

    // spread GPU uploads over frames, nearest tiles first
    let budget = o.uploadsPerFrame;
    for (const plan of wanted) {
      const live = this.tiles.get(plan.key);
      if (!live || !live.waiting.length) continue;
      while (budget > 0 && live.waiting.length) {
        this.upload(live, live.waiting.shift()!);
        budget--;
      }
      if (budget <= 0) break;
    }

    this.cull(camera);
  }

  /** Floating origin moved: re-place every tile group. */
  rebase() {
    for (const live of this.tiles.values()) this.place(live);
  }

  private place(live: LiveTile) {
    this.frame.fromMercator(live.data.corner[0], live.data.corner[1], corner);
    live.group.position.set(corner.x, 0, corner.z);
    live.group.scale.set(this.frame.scale, 1, this.frame.scale);
    // matrixAutoUpdate is off for static tiles: rebuild the local matrix by hand
    live.group.updateMatrix();
    live.group.updateMatrixWorld(true);
  }

  private start(key: string, tile: TileId) {
    const request = this.client.request(tile, { chunks: this.options.chunksPerTile, windows: true });
    const flight: Flight = { key, tile, cancel: request.cancel, started: performance.now() };
    this.flights.set(key, flight);
    request.promise.then((result) => {
      if (this.disposed || this.flights.get(key) !== flight) return;
      this.flights.delete(key);
      this.failures.delete(key);
      this.fetchTimes.push(result.fetchMs);
      this.buildTimes.push(result.data.stats.decodeMs);
      if (this.fetchTimes.length > 30) this.fetchTimes.shift();
      if (this.buildTimes.length > 30) this.buildTimes.shift();
      this.install(key, result.data);
    }).catch((error: Error) => {
      if (this.flights.get(key) !== flight) return;
      this.flights.delete(key);
      if (error.message === 'aborted' || this.disposed) return;
      this.failureCount++;
      const prior = this.failures.get(key)?.count ?? 0;
      this.failures.set(key, { count: prior + 1, retryAt: performance.now() + 1500 * 2 ** prior });
      console.warn(`[three-world] tile ${key} failed`, error.message);
    });
  }

  private install(key: string, data: TileData) {
    const group = new THREE.Group();
    group.name = `tile ${key}`;
    group.matrixAutoUpdate = false;
    const live: LiveTile = { key, tile: data.tile, data, group, chunks: [], waiting: [...data.chunks] };
    // nearest chunks of the tile go first is not needed: tiles arrive far ahead
    this.place(live);
    this.scene.add(group);
    this.tiles.set(key, live);
    this.revision++;
  }

  private upload(live: LiveTile, chunk: ChunkData) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3, true));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(chunk.colors, 3, true));
    geometry.setAttribute('aFacade', new THREE.BufferAttribute(chunk.facade, 3));
    geometry.setIndex(new THREE.BufferAttribute(chunk.index, 1));
    const sphereRadius = Math.hypot(chunk.radius * Math.SQRT2, chunk.maxHeight / 2);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(chunk.cx, chunk.maxHeight / 2, chunk.cz), sphereRadius);
    const mesh = new THREE.Mesh(geometry, this.materials.textured);
    mesh.matrixAutoUpdate = false;
    live.group.add(mesh);
    mesh.updateMatrixWorld(true);

    let windows: THREE.Mesh | null = null;
    if (chunk.windows.count > 0) {
      const base = this.materials.windowBase;
      const wg = new THREE.InstancedBufferGeometry();
      wg.setIndex(base.getIndex());
      wg.setAttribute('position', base.getAttribute('position'));
      wg.setAttribute('aGlass', base.getAttribute('aGlass'));
      wg.setAttribute('iOffset', new THREE.InstancedBufferAttribute(chunk.windows.offsets, 4));
      wg.setAttribute('iAxis', new THREE.InstancedBufferAttribute(chunk.windows.axes, 4));
      wg.instanceCount = chunk.windows.count;
      wg.boundingSphere = geometry.boundingSphere.clone();
      windows = new THREE.Mesh(wg, this.materials.windows);
      windows.matrixAutoUpdate = false;
      windows.visible = false;
      live.group.add(windows);
      windows.updateMatrixWorld(true);
    }
    live.chunks.push({ data: chunk, mesh, windows });
  }

  private unload(key: string, live: LiveTile) {
    this.scene.remove(live.group);
    for (const chunk of live.chunks) {
      chunk.mesh.geometry.dispose();
      if (chunk.windows) {
        // keep the shared unit window buffers alive: drop them before dispose
        const g = chunk.windows.geometry as THREE.InstancedBufferGeometry;
        g.deleteAttribute('position');
        g.deleteAttribute('aGlass');
        g.setIndex(null);
        g.dispose();
      }
    }
    this.tiles.delete(key);
    this.revision++;
    // GPU memory is freed, CPU arrays stay in a small LRU for quick return trips
    this.cache.set(key, live.data);
    while (this.cache.size > this.options.cacheTiles) this.cache.delete(this.cache.keys().next().value!);
  }

  private cull(camera: THREE.Vector3) {
    const o = this.options;
    const scale = this.frame.scale;
    let visible = 0;
    for (const live of this.tiles.values()) {
      const gp = live.group.position;
      for (const chunk of live.chunks) {
        const d = chunk.data;
        tmp.set(gp.x + d.cx * scale, d.maxHeight * 0.3, gp.z + d.cz * scale);
        const reach = d.radius * scale * Math.SQRT2;
        const distance = Math.max(0, tmp.distanceTo(camera) - reach);
        const shown = distance < o.drawDistance;
        chunk.mesh.visible = shown;
        if (shown) visible++;
        const mode = this.windowMode;
        const near = distance < o.windowDistance;
        const instanced = shown && (mode === 'instanced' || (mode === 'hybrid' && near));
        chunk.mesh.material = mode === 'texture' || (mode === 'hybrid' && !near) ? this.materials.textured : this.materials.plain;
        if (chunk.windows) chunk.windows.visible = instanced;
      }
    }
    this.visibleChunks = visible;
  }

  /** Building footprints (lng/lat rings) near a point, for gameplay systems. */
  footprintsNear(center: LngLat, radius: number): [number, number][][][] {
    const mx = mercatorX(center[0]);
    const my = mercatorY(center[1]);
    const out: [number, number][][][] = [];
    for (const live of this.tiles.values()) {
      const data = live.data;
      const f = data.footprints;
      const lx = mx - data.corner[0];
      const lz = data.corner[1] - my;
      const r = radius / data.metersScale;
      const span = tileSpan(data.tile.z);
      if (lx < -r || lz < -r || lx > span + r || lz > span + r) continue;
      const count = f.buildingStart.length - 1;
      for (let b = 0; b < count; b++) {
        const i = b * 4;
        if (f.bounds[i] > lx + r || f.bounds[i + 2] < lx - r || f.bounds[i + 1] > lz + r || f.bounds[i + 3] < lz - r) continue;
        const rings: [number, number][][] = [];
        for (let ring = f.buildingStart[b]; ring < f.buildingStart[b + 1]; ring++) {
          const points: [number, number][] = [];
          for (let p = f.ringStart[ring]; p < f.ringStart[ring + 1]; p++) {
            points.push([lngFromMercator(data.corner[0] + f.coords[p * 2]), latFromMercator(data.corner[1] - f.coords[p * 2 + 1])]);
          }
          rings.push(points);
        }
        out.push(rings);
      }
    }
    return out;
  }

  /** True once the tile under `point` has been uploaded completely. */
  readyAt(point: LngLat) {
    for (const live of this.tiles.values()) {
      const span = tileSpan(live.tile.z);
      const lx = mercatorX(point[0]) - live.data.corner[0];
      const lz = live.data.corner[1] - mercatorY(point[1]);
      if (lx >= 0 && lz >= 0 && lx <= span && lz <= span) return live.waiting.length === 0;
    }
    return false;
  }

  stats(): TileManagerStats {
    let chunks = 0, buildings = 0, triangles = 0, windows = 0, bytes = 0;
    for (const live of this.tiles.values()) {
      chunks += live.chunks.length;
      buildings += live.data.stats.buildings;
      for (const c of live.chunks) {
        triangles += c.data.index.length / 3;
        windows += c.data.windows.count;
        bytes += c.data.positions.byteLength + c.data.normals.byteLength + c.data.colors.byteLength + c.data.facade.byteLength
          + c.data.index.byteLength + c.data.windows.offsets.byteLength + c.data.windows.axes.byteLength;
      }
    }
    const avg = (list: number[]) => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
    return {
      tilesLoaded: this.tiles.size,
      tilesInFlight: this.flights.size,
      tilesQueued: this.queuedCount,
      chunksLive: chunks,
      chunksVisible: this.visibleChunks,
      buildings,
      residentTriangles: triangles,
      windowsResident: windows,
      residentMB: bytes / 1048576,
      avgFetchMs: avg(this.fetchTimes),
      avgBuildMs: avg(this.buildTimes),
      failures: this.failureCount,
      threaded: this.client.threaded,
    };
  }

  /** No tile is loading and none is waiting for upload. */
  settled() {
    if (this.flights.size || this.queuedCount) return false;
    for (const live of this.tiles.values()) if (live.waiting.length) return false;
    return this.tiles.size > 0;
  }

  dispose() {
    this.disposed = true;
    for (const flight of this.flights.values()) flight.cancel();
    this.flights.clear();
    for (const [key, live] of [...this.tiles]) this.unload(key, live);
    this.cache.clear();
    this.client.dispose();
  }
}
