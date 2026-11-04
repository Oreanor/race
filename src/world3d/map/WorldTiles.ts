import * as THREE from 'three';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { ChunkData } from '../tiles/buildTile';
import type { GeoFeature, MeshData, WorldTileData } from '../tiles/worldTile';
import { DEM_SIZE, sampleDem } from '../tiles/dem';
import { tileTemplate } from '../tiles/TileClient';
import { tilesAround, distanceToTile } from '../tiles/tilePlan';
import { latFromMercator, lngFromMercator, mercatorX, mercatorY, tileAt, tileCorner, tileSpan, WORLD_SIZE, type LngLat, type TileId } from '../mercator';
import { farBuildingMaterial, groundMaterial, roadMaterial, type BaseUniforms } from './materials';
import { VegetationRenderer } from './vegetation';

export type WorldTilesOptions = {
  zoom: number;
  /** tiles within this distance of the focus are loaded (and drawn) */
  loadRadius: number;
  /** and kept until they are farther than this */
  unloadRadius: number;
  /** gameplay features come from tiles within this distance */
  featureRadius: number;
  /** road ribbons are drawn for tiles this close; farther tiles show roads from the raster */
  roadRadius: number;
  maxInFlight: number;
  uploadsPerFrame: number;
  raster: number;
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
  // ribbons ↔ raster roads switch where fog has begun and both look the same
  roadRadius: 1200,
  maxInFlight: 4,
  uploadsPerFrame: 2,
  raster: 1024,
  grid: 48,
  demTemplate: null,
  region: '',
};

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
};

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
    this.roadMat.side = side;
    this.farMat.side = side;
    this.vegetation.setSide(side);
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
    // Road LOD by tile: ribbons near the focus, raster roads beyond.
    const mx = mercatorX(focus[0]), my = mercatorY(focus[1]);
    const cos = Math.cos(focus[1] * Math.PI / 180);
    for (const live of this.tiles.values()) {
      if (live.roads) live.roads.visible = distanceToTile(mx, my, live.tile, cos) <= o.roadRadius;
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
      raster: this.options.raster,
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

  private receive(_worker: number, message: { id: number; ok: boolean; data?: WorldTileData; raster?: ImageBitmap; fetchMs?: number; buildMs?: number; error?: string; aborted?: boolean }) {
    const job = this.jobs.get(message.id);
    if (!job) { message.raster?.close(); return; }
    this.jobs.delete(message.id);
    this.load[job.worker] = Math.max(0, this.load[job.worker] - 1);
    const pending = this.pending.get(job.key);
    if (!pending || pending.id !== message.id) { message.raster?.close(); return; }
    this.pending.delete(job.key);
    if (this.disposed) { message.raster?.close(); return; }
    if (!message.ok || !message.data || !message.raster) {
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
    this.install(job.key, message.data, message.raster);
  }

  private install(key: string, data: WorldTileData, raster: ImageBitmap) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.name = `world ${key}`;
    const live: Live = { key, tile: data.tile, data, group, waiting: [], roads: null, disposables: [], extra: new Map() };
    this.place(live);
    this.root.add(group);
    this.tiles.set(key, live);

    // Ground and roads first (cheap, and they define the street layout), buildings after.
    live.waiting.push(() => {
      const texture = new THREE.Texture(raster);
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.anisotropy = 8;
      texture.needsUpdate = true;
      const material = groundMaterial(this.uniforms, texture);
      material.side = this.farMat.side;
      const mesh = this.mesh(data.terrain, material, true);
      mesh.renderOrder = -2;
      group.add(mesh);
      live.disposables.push(texture, material, mesh.geometry, { dispose: () => raster.close() });
      if (data.roads.index.length) {
        const roads = this.mesh(data.roads, this.roadMat, false);
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
      for (const mesh of meshes) group.add(mesh);
      group.updateMatrixWorld(true);
      live.disposables.push({ dispose: () => this.vegetation.release(meshes) });
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
    const mesh = new THREE.Mesh(geometry, this.farMat);
    mesh.matrixAutoUpdate = false;
    live.group.add(mesh);
    mesh.updateMatrixWorld(true);
    live.disposables.push(geometry);
  }

  private unload(key: string, live: Live) {
    this.root.remove(live.group);
    for (const fn of live.waiting.splice(0)) void fn; // never uploaded
    for (const d of live.disposables) d.dispose();
    this.tiles.delete(key);
    this.revision++;
  }

  /** Hide whole tiles that are entirely inside opaque fog (invisible anyway). */
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

  /** Raw DEM height in meters, or null where no tile is loaded yet. */
  groundAt(lng: number, lat: number): number | null {
    const live = this.liveAt(lng, lat);
    if (!live) return null;
    if (!live.data.dem) return 0;
    const span = tileSpan(live.tile.z);
    const [cx, cy] = live.data.corner;
    const px = (mercatorX(lng) - cx) / span * DEM_SIZE;
    const py = (cy - mercatorY(lat)) / span * DEM_SIZE;
    return sampleDem(live.data.dem, px, py);
  }

  hasDemAt(lng: number, lat: number) {
    return this.liveAt(lng, lat) != null;
  }

  /** GeoJSON features of a source layer, MapLibre querySourceFeatures style. */
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

  private eachFootprint(center: LngLat, radius: number, visit: (rings: () => [number, number][][], height: number, ground: number) => void) {
    const mx = mercatorX(center[0]), my = mercatorY(center[1]);
    for (const live of this.tiles.values()) {
      const data = live.data.buildings;
      const f = data.footprints;
      const [cx, cy] = data.corner;
      const lx = mx - cx, lz = cy - my;
      const r = radius / data.metersScale;
      const span = tileSpan(data.tile.z);
      if (lx < -r || lz < -r || lx > span + r || lz > span + r) continue;
      const count = f.buildingStart.length - 1;
      for (let b = 0; b < count; b++) {
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
        const gx = (f.bounds[i] + f.bounds[i + 2]) / 2, gz = (f.bounds[i + 1] + f.bounds[i + 3]) / 2;
        const ground = live.data.dem ? sampleDem(live.data.dem, gx / span * DEM_SIZE, gz / span * DEM_SIZE) : 0;
        visit(rings, f.heights[b], ground);
      }
    }
  }

  /**
   * First building hit on the segment from → to (lng/lat + altitude in meters,
   * altitudes already exaggerated like queryTerrainElevation). Used for gunfire.
   */
  raycastBuildings(from: LngLat, fromAlt: number, to: LngLat, toAlt: number, exaggeration: number) {
    const cos = Math.cos(from[1] * Math.PI / 180);
    const dx = (to[0] - from[0]) * 111319.49 * cos, dy = (to[1] - from[1]) * 111319.49;
    const length = Math.hypot(dx, dy);
    if (length < 0.5) return null;
    const mid: LngLat = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const candidates: { rings: [number, number][][]; top: number }[] = [];
    this.eachFootprint(mid, length / 2 + 30, (rings, height, ground) => candidates.push({ rings: rings(), top: ground * exaggeration + height }));
    if (!candidates.length) return null;
    const inside = (p: LngLat, ring: [number, number][]) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
      }
      return hit;
    };
    const steps = Math.ceil(length / 0.75);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const p: LngLat = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const altitude = fromAlt + (toAlt - fromAlt) * t;
      for (const c of candidates) {
        if (altitude > c.top) continue;
        if (inside(p, c.rings[0]) && !c.rings.slice(1).some((hole) => inside(p, hole))) return { point: p, altitude };
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
        + live.data.terrain.positions.byteLength * 2 + live.data.roads.positions.byteLength * 2
        + this.options.raster * this.options.raster * 4 * 1.33;
    }
    const avg = (l: number[]) => l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
    return { loaded: this.tiles.size, inFlight: this.pending.size, buildings, residentMB: bytes / 1048576, avgFetchMs: avg(this.fetchTimes), avgBuildMs: avg(this.buildTimes) };
  }

  dispose() {
    this.disposed = true;
    for (const [key, live] of [...this.tiles]) this.unload(key, live);
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.roadMat.dispose();
    this.farMat.dispose();
    this.vegetation.dispose();
  }
}

export { tileCorner };
