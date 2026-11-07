import * as THREE from 'three';
import { MapCamera, latFrom01, lngFrom01, mercatorPerMeter, mercatorX01, mercatorY01 } from './camera.ts';
import { WorldTiles, defaultWorldOptions } from './WorldTiles.ts';
import { baseUniforms, facadeMask, type BaseUniforms } from './materials.ts';
import type { GeoFeature } from '../tiles/worldTile.ts';
import { seasonWeights, snowCover, worldTime, type SimpleLitUniforms } from './simpleLit.ts';
import { computeLighting, timeFor, TIME_MODES, type Lighting, type TimeMode } from './lighting.ts';
import { placeClock, placeMoment, placeZone } from '../placeTime.ts';
import { seasonAt, snowCoverAt, SEASON_MODES, SEASONS, type Season, type SeasonMode } from '../seasons.ts';
import { SkyBodies } from './sky.ts';
import { LensFlare } from './LensFlare.ts';
import { skyDirection } from '../astro.ts';
import { PAINTED_SKINS, SKIN_DATA, type Skin, type SkinId } from '../buildings/skins.ts';
import { METERS_PER_DEGREE } from '@/game/meters';


/** bullet hole decals; the oldest one goes when a new one comes */
const MAX_HOLES = 1024;
/** broken window panes remembered while they stay within the drawn area */
const MAX_PANES = 4096;

// A small stand-in for maplibregl.Map, backed by our own Three.js world.
// It implements only what City Rider calls, with the same semantics, so the
// game engine and the existing custom Three.js layers run unchanged on top.
// Everything MapLibre-specific (style restyling, hidden layers, worker copy,
// DEM level switching) simply does not exist here.

type LngLatLike = [number, number] | { lng: number; lat: number };
type Listener = (event: Record<string, unknown>) => void;
/** What a layer's render() gets: the camera's mercator → clip matrix. */
export type RenderArgs = { defaultProjectionData: { mainMatrix: ArrayLike<number> } };
/** A layer drawn in our world (vehicles, stations …). */
export type MapLayer = CustomLayer;
type CustomLayer = {
  id: string;
  type: string;
  /** scene layers: drawn inside our one scene instead of with their own renderer */
  scene?: THREE.Scene;
  placement?: THREE.Matrix4;
  fuse?: (world?: SimpleLitUniforms) => void;
  onAdd?: (map: ThreeMap, gl: WebGL2RenderingContext) => void;
  onRemove?: (map: ThreeMap, gl: WebGL2RenderingContext) => void;
  prerender?: (gl: WebGL2RenderingContext, args: RenderArgs) => void;
  render?: (gl: WebGL2RenderingContext, args: RenderArgs) => void;
};

export type ThreeMapOptions = {
  container: HTMLElement;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  maxPitch?: number;
  /** terrarium DEM url template */
  dem?: string | null;
  /** country of the start city: biases building styles */
  region?: string;
};

const SKY = '#dfe6e6';
const REBASE_METERS = 1500;

function toLngLat(p: LngLatLike): [number, number] {
  return Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat];
}


export class ThreeMarker {
  private element: HTMLElement;
  private lngLat: [number, number] = [0, 0];
  private map: ThreeMap | null = null;
  /** @internal the ground under it, once a tile there has told us */
  altitude: number | null = null;
  /** @internal set: it stands at this height (m, as drawn), not on the ground */
  fixed: number | null = null;
  constructor(options: { element?: HTMLElement; anchor?: string } = {}) {
    this.element = options.element ?? document.createElement('div');
    this.element.style.position = 'absolute';
    this.element.style.left = '0';
    this.element.style.top = '0';
    this.element.style.willChange = 'transform';
    // anchor: bottom (the only one the game uses)
    this.element.dataset.anchor = options.anchor ?? 'center';
  }
  setLngLat(p: LngLatLike) { this.lngLat = toLngLat(p); this.altitude = null; this.map?.placeMarker(this); return this; }
  /** Stand at this height (m, as drawn: on a roof, say) instead of on the ground; null: the ground again. */
  setAltitude(altitude: number | null) { this.fixed = altitude; this.map?.placeMarker(this); return this; }
  getLngLat() { return { lng: this.lngLat[0], lat: this.lngLat[1] }; }
  addTo(map: ThreeMap) { this.map = map; map.addMarker(this); return this; }
  remove() { this.map?.removeMarker(this); this.map = null; return this; }
  getElement() { return this.element; }
  /** @internal */ position() { return this.lngLat; }
}

/** how long a change of time of day takes (ms) */
const TIME_ROLL_MS = 1000;

export class ThreeMap {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new MapCamera();
  readonly world: WorldTiles;
  readonly uniforms: BaseUniforms;
  /** what the mouse may do to the camera: pan + zoom, and right-drag rotate */
  private interactive = { pan: false, rotate: false };
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private markerLayer: HTMLDivElement;
  private flare: LensFlare;
  private markers = new Set<ThreeMarker>();
  private scene = new THREE.Scene();
  private sceneCamera = new THREE.Camera();
  private sceneToMercator = new THREE.Matrix4();
  private mercatorToScene = new THREE.Matrix4();
  private fused: CustomLayer[] = [];
  private listeners = new Map<string, Set<Listener>>();
  private layers: CustomLayer[] = [];
  /** relief on: heights × 1; off: a flat world */
  private relief = true;
  private frame = 0;
  private origin = { x01: 0, y01: 0, lat: 0 };
  private resizeObserver: ResizeObserver;
  private cleanups: (() => void)[] = [];
  private maxPitch: number;
  private side: THREE.Side = THREE.FrontSide;
  private removed = false;
  private mask: THREE.Texture;
  /** real time, or a typical morning / day / evening / night of today here (key T) */
  private timeMode: TimeMode = 'real';
  /** Shift+T: the place's real season or a chosen one (local to this player) */
  private seasonMode: SeasonMode = 'real';
  private seasonClock = 0;
  private modeDate: Date | null = null;
  /**
   * A change of time of day rolls the clock forward to it over a few seconds, so the
   * sun travels and the sky, light, fog, windows and lamps follow it (ms timestamps).
   */
  private timeRoll: { from: number; to: number; start: number } | null = null;
  /** fixed wall-clock time from ?time=HH:MM (testing) */
  /** ?time=HH:MM: that time on the clocks of the place on screen */
  private fixedClock: [number, number] | null = null;
  private sky = new SkyBodies();
  private lighting: Lighting | null = null;
  private lightClock = 0;
  /** bullet holes on walls, roofs and ground; world positions, oldest replaced first */
  private holes: { at: [number, number]; altitude: number; normal: [number, number, number] }[] = [];
  /**
   * Bullet hits on walls, kept apart from the hole decals: the pane a hit broke
   * stays broken until it leaves the drawn area (past the fog), not when its hole
   * gives way to newer ones.
   */
  private panes: { at: [number, number]; altitude: number; seed: number }[] = [];
  private panesDirty = false;
  private panesAt = 0;
  /** burning / soot façade windows (scene markers via uFires; lit=false → soot only) */
  private fires: { at: [number, number]; altitude: number; lit: boolean }[] = [];
  private firesDirty = false;
  private firesOrigin = '';
  private holeMesh: THREE.InstancedMesh;
  private holesDirty = false;
  private holesOrigin = '';
  /** scratch vectors for headlight pose (avoid per-frame alloc in the render loop) */
  private readonly headFlat = new THREE.Vector3();
  private readonly headFwd = new THREE.Vector3();
  private readonly headUp = new THREE.Vector3();
  /** player car (lng/lat, altitude m) for the see-through buildings in front of it */
  private focusCar: { at: [number, number]; altitude: number; heading: number; pitch: number } | null = null;
  /** first-frame shader compile so the opening lap does not hitch on program link */
  private programsWarmed = false;
  /** while the map is hidden: fill a full tile ring and drain GPU uploads faster */
  private streamBurst = true;
  /** intro fly-in / M blend: tiny upload budget so the lerp stays at 60 */
  private streamCalm = false;
  /** reused each frame — avoid Matrix4 alloc in the render path */
  private clipScratch = new THREE.Matrix4();
  /** M-map open / blending: keep screen-rectangle streaming so pitch lerp doesn't dump tiles */
  private screenStream = false;
  /** last good top-down ground rect — reused while pitch lerp makes unproject miss */
  private lastScreenBounds: { west: number; south: number; east: number; north: number } | null = null;
  /** current architecture skin — fire window centres follow its façade rhythm */
  private skinId: SkinId = 'original';
  loaded = false;

  constructor(options: ThreeMapOptions) {
    this.container = options.container;
    this.maxPitch = options.maxPitch ?? 85;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'maplibregl-canvas three-map-canvas';
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    // a light grade over the whole picture (world, sky, cars): richer colour, a touch more
    // contrast. Done by the compositor, so it costs next to nothing
    this.canvas.style.filter = 'saturate(1.12) contrast(1.06)';
    this.container.appendChild(this.canvas);
    // a soft vignette: the corners a touch darker, the eye goes to the middle (free: CSS)
    const vignette = document.createElement('div');
    vignette.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;background:radial-gradient(ellipse at 50% 55%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.26) 100%)';
    this.container.appendChild(vignette);
    this.markerLayer = document.createElement('div');
    this.markerLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2';
    this.container.appendChild(this.markerLayer);
    this.flare = new LensFlare(this.container, this.markerLayer);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    this.renderer.setClearColor(new THREE.Color(SKY));
    this.scene.matrixAutoUpdate = false;
    this.sceneCamera.matrixAutoUpdate = false;
    this.sceneCamera.matrixWorldAutoUpdate = false;

    this.uniforms = baseUniforms(SKY);
    this.mask = facadeMask();
    this.world = new WorldTiles(this.uniforms, this.mask, { ...defaultWorldOptions, demTemplate: options.dem ?? null, region: options.region ?? '' });
    this.world.onTile = (key) => {
      // `tile` ("z/x/y") lets listeners skip tiles far from what they care about
      this.emit('tile', { tile: key });
      this.triggerRepaint();
    };
    this.scene.add(this.world.root);
    this.scene.add(this.sky.group);
    this.holeMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.075, 12),
      new THREE.MeshBasicMaterial({ color: '#151210', transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16, side: THREE.DoubleSide }),
      MAX_HOLES,
    );
    this.holeMesh.count = 0;
    this.holeMesh.frustumCulled = false;
    this.holeMesh.renderOrder = 5;
    this.scene.add(this.holeMesh);
    const wanted = new URLSearchParams(window.location.search).get('time');
    if (wanted && /^\d{1,2}:\d{2}$/.test(wanted)) {
      const [h, m] = wanted.split(':').map(Number);
      this.fixedClock = [h, m];
    }

    const s = this.camera.state;
    s.center = [...options.center];
    s.zoom = options.zoom;
    s.pitch = options.pitch;
    s.bearing = options.bearing;
    this.rebase(true);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.bindInput();
    (window as unknown as { __threeMap?: ThreeMap }).__threeMap = this; // debugging / perf scripts
    // MapLibre fires `load` asynchronously once the style is ready; mirror that.
    setTimeout(() => {
      if (this.removed) return;
      this.loaded = true;
      this.emit('styledata', {});
      this.emit('load', {});
      this.triggerRepaint();
    }, 0);
  }

  // ---- events --------------------------------------------------------------
  on(type: string, fn: Listener) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    return this;
  }
  off(type: string, fn: Listener) { this.listeners.get(type)?.delete(fn); return this; }
  private emit(type: string, event: Record<string, unknown>) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, ...event });
  }

  // ---- layers ---------------------------------------------------------------
  addLayer(layer: CustomLayer) {
    if (layer.type !== 'custom') return this; // basemap styling layers have no meaning here
    if (layer.scene && layer.placement && layer.fuse) {
      // One scene, one renderer: the layer keeps its logic, we draw its objects.
      layer.fuse(this.uniforms);
      layer.scene.matrixAutoUpdate = false;
      this.scene.add(layer.scene);
      this.fused.push(layer);
    }
    this.layers.push(layer);
    layer.onAdd?.(this, this.renderer.getContext() as WebGL2RenderingContext);
    this.triggerRepaint();
    return this;
  }
  getLayer(id: string) { return this.layers.find((l) => l.id === id); }
  removeLayer(id: string) {
    const layer = this.getLayer(id);
    if (!layer) return this;
    this.layers = this.layers.filter((l) => l !== layer);
    if (this.fused.includes(layer)) {
      this.fused = this.fused.filter((l) => l !== layer);
      if (layer.scene) this.scene.remove(layer.scene);
    }
    layer.onRemove?.(this, this.renderer.getContext() as WebGL2RenderingContext);
    return this;
  }

  // ---- ground -------------------------------------------------------------
  /** Relief on (real heights) or off (a flat world at 0). */
  setRelief(on: boolean) {
    this.relief = on;
    this.uniforms.uExag.value = on ? 1 : 0;
    this.triggerRepaint();
  }
  /** How tall heights are drawn: 1 with relief, 0 flat. */
  get exaggeration() { return this.relief ? 1 : 0; }
  /**
   * The drive surface under a point (m, as drawn): 0 on a flat world, null where no
   * tile is in yet. Under a bridge the deck or the way below is picked by
   * atAltitude (the player's car when left out; null: no hint, the ground).
   */
  groundAt(p: LngLatLike, atAltitude?: number | null): number | null {
    if (!this.relief) return 0;
    const [lng, lat] = toLngLat(p);
    return this.world.groundAt(lng, lat, atAltitude === undefined ? this.focusCar?.altitude : atAltitude ?? undefined);
  }
  /** Riding a bridge deck (for water exemptions), not the road under it. */
  isDeckAt(p: LngLatLike, altitude: number) {
    const [lng, lat] = toLngLat(p);
    return this.world.isDeckAt(lng, lat, altitude);
  }
  getCenterElevation() { return this.camera.state.elevation; }
  /** What the wheels are on at a point: paved, grass (and earth) or sand. */
  surfaceAt(p: LngLatLike) {
    const [lng, lat] = toLngLat(p);
    return this.world.surfaceAt(lng, lat);
  }

  /** The house a shop is in (or the nearest within `radius` m): middle, top, footprint radius (m). */
  houseAt(p: LngLatLike, radius = 80) {
    const house = this.world.houseAt(toLngLat(p), radius);
    return house
      ? { middle: house.middle, top: house.top * this.exaggeration, radius: house.radius }
      : null;
  }

  /**
   * Fire call on an existing house by a street pin: street-facing accessible
   * window centres (exaggerated altitudes) ready to ignite.
   */
  fireFacadesNear(street: LngLatLike, radius = 55, maxPanes = Infinity) {
    return this.world.fireFacadesNear(toLngLat(street), this.exaggeration, radius, this.skinId, maxPanes);
  }

  /** Burning / soot window markers for the façade shader (cleared with empty list). */
  setFirePanes(panes: { at: [number, number]; altitude: number; lit?: boolean }[]) {
    this.fires = panes.map((p) => ({
      at: [...p.at] as [number, number],
      altitude: p.altitude,
      lit: p.lit !== false,
    }));
    this.firesDirty = true;
    this.firesOrigin = '';
  }

  /** The ground under the view centre has arrived. */
  hasGround() {
    const [lng, lat] = this.camera.state.center;
    return this.world.hasDemAt(lng, lat);
  }
  /** What the mouse may do to the camera (the map view, the intro): pan + wheel zoom, right-drag rotate. */
  setInteractive(on: { pan: boolean; rotate: boolean }) { this.interactive = { ...on }; }
  /** Stream ring used for isotropic boot warm (past fog so looking around stays hot). */
  get loadRadius() { return this.world.options.loadRadius; }

  /** Everything inside the fog is in: the world can be shown without anything popping in later. */
  areTilesLoaded(radius = this.uniforms.uFogFar.value) {
    return this.world.loadedAround(this.camera.state.center, radius);
  }

  /** Boot: isotropic ring + faster uploads while the canvas is still hidden / settled. */
  beginStreamBurst() { this.streamBurst = true; this.streamCalm = false; }
  /** Leave burst streaming once the chase cam has settled. */
  endStreamBurst() { this.streamBurst = false; }
  /** Camera blends (intro fly-in, M open/close): starve uploads so the lerp doesn't hitch. */
  setStreamCalm(on: boolean) {
    this.streamCalm = on;
    if (on) this.streamBurst = false;
  }
  /** Drive M-map / overview blend: screen streaming even while pitch is mid-lerp. */
  setScreenStream(on: boolean) {
    this.screenStream = on;
  }
  /** Tiles + GPU uploads done around a point (not only the current camera). */
  areTilesLoadedAround(at: [number, number], radius = this.loadRadius) {
    return this.world.loadedAround(at, radius);
  }

  /** Ground lng/lat rectangle under the screen corners (top-down map streaming). */
  private screenGroundBounds(): { west: number; south: number; east: number; north: number } | null {
    const s = this.camera.state;
    // steep pitch: rays miss the ground or shoot to the horizon — junk bounds thrash the stream
    if (s.pitch > 18) return this.lastScreenBounds;
    const elev = s.elevation;
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity, hits = 0;
    for (const [x, y] of [[0, 0], [s.width, 0], [s.width, s.height], [0, s.height]] as [number, number][]) {
      const ll = this.camera.unproject(x, y, elev);
      if (!ll) continue;
      hits++;
      west = Math.min(west, ll[0]);
      east = Math.max(east, ll[0]);
      south = Math.min(south, ll[1]);
      north = Math.max(north, ll[1]);
    }
    if (hits < 3 || !(east > west) || !(north > south)) return this.lastScreenBounds;
    // cap insane spans from near-horizon hits
    const cosLat = Math.cos(((south + north) / 2) * Math.PI / 180);
    const spanE = (east - west) * METERS_PER_DEGREE * cosLat;
    const spanN = (north - south) * METERS_PER_DEGREE;
    if (spanE > 12000 || spanN > 12000) return this.lastScreenBounds;
    this.lastScreenBounds = { west, south, east, north };
    return this.lastScreenBounds;
  }

  /** GeoJSON features of a tile layer near the view (all loaded layers, incl. poi…). */
  features(layer: string): GeoFeature[] {
    return this.world.features(layer, this.camera.state.center);
  }

  /** Layer names present in loaded tiles: everything we can visualise later. */
  sourceLayers() { return this.world.layerNames(); }

  // ---- camera -------------------------------------------------------------
  jumpTo(options: { center?: LngLatLike; zoom?: number; pitch?: number; bearing?: number; elevation?: number }) {
    const s = this.camera.state;
    if (options.center) s.center = toLngLat(options.center);
    if (options.zoom != null) s.zoom = options.zoom;
    if (options.pitch != null) s.pitch = Math.min(this.maxPitch, Math.max(0, options.pitch));
    if (options.bearing != null) s.bearing = ((options.bearing + 540) % 360) - 180;
    if (options.elevation != null) s.elevation = options.elevation;
    this.emit('move', {});
    this.triggerRepaint();
    return this;
  }
  getCenter() { const [lng, lat] = this.camera.state.center; return { lng, lat }; }
  getZoom() { return this.camera.state.zoom; }
  getPitch() { return this.camera.state.pitch; }
  getBearing() { return this.camera.state.bearing; }
  getCanvas() { return this.canvas; }
  getCanvasContainer() { return this.container; }
  getContainer() { return this.container; }

  /** Screen point of a place on the ground; where no tile is in yet, at the view centre's height (not sea level). */
  project(p: LngLatLike) {
    this.camera.update();
    const [lng, lat] = toLngLat(p);
    const altitude = this.groundAt([lng, lat]) ?? this.camera.state.elevation;
    return this.camera.project(lng, lat, altitude);
  }
  unproject(point: { x: number; y: number } | [number, number]) {
    this.camera.update();
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    let hit = this.camera.unproject(x, y) ?? this.camera.state.center;
    // the plane at the centre's height misses on hills: walk the hit onto the terrain
    for (let i = 0; i < 8; i++) {
      const ground = this.groundAt(hit);
      if (ground == null) break;
      const next = this.camera.unproject(x, y, ground);
      if (!next) break;
      const moved = Math.hypot(next[0] - hit[0], next[1] - hit[1]);
      // damped, so steep views settle instead of bouncing between two slopes
      hit = [hit[0] + (next[0] - hit[0]) * 0.7, hit[1] + (next[1] - hit[1]) * 0.7];
      if (moved < 1e-7) break; // ≈ 1 cm
    }
    return { lng: hit[0], lat: hit[1] };
  }

  /**
   * What the cursor sees in 3D: first façade on the real camera ray through the
   * pixel, else the ground. Guns used to aim at the ground plane only — walls
   * always took hits at bumper height.
   */
  pickScreen(x: number, y: number): { point: [number, number]; altitude: number; wall: boolean } {
    this.camera.update();
    const cam = this.camera;
    const nx = (x / cam.state.width) * 2 - 1;
    const ny = 1 - (y / cam.state.height) * 2;
    const a = new THREE.Vector4(nx, ny, -1, 1).applyMatrix4(cam.invViewProj);
    const b = new THREE.Vector4(nx, ny, 1, 1).applyMatrix4(cam.invViewProj);
    a.divideScalar(a.w);
    b.divideScalar(b.w);
    const from: [number, number] = [lngFrom01(a.x / cam.worldSize), latFrom01(a.y / cam.worldSize)];
    const fromAlt = a.z;
    const cos = Math.cos(from[1] * Math.PI / 180);
    const toLng = lngFrom01(b.x / cam.worldSize);
    const toLat = latFrom01(b.y / cam.worldSize);
    let de = (toLng - from[0]) * METERS_PER_DEGREE * cos;
    let dn = (toLat - from[1]) * METERS_PER_DEGREE;
    let du = b.z - a.z;
    const span = Math.hypot(de, dn, du) || 1;
    const reach = 220;
    const s = reach / span;
    const to: [number, number] = [
      from[0] + (de * s) / (METERS_PER_DEGREE * Math.max(0.05, cos)),
      from[1] + (dn * s) / METERS_PER_DEGREE,
    ];
    const toAlt = fromAlt + du * s;
    const wall = this.raycastBuildings(from, fromAlt, to, toAlt, false);
    if (wall) return { point: wall.point, altitude: wall.altitude, wall: true };
    // Walk the camera ray onto the DEM — plane unproject misses / returns null on
    // steep near-car aims (gun needs to pitch below horizontal to hit the kerb).
    let prevAlt = fromAlt;
    let prevG = this.groundAt(from);
    for (let i = 1; i <= 24; i++) {
      const t = i / 24;
      const p: [number, number] = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const rayAlt = fromAlt + (toAlt - fromAlt) * t;
      const g = this.groundAt(p);
      if (g == null) { prevAlt = rayAlt; prevG = g; continue; }
      const above = prevG == null || prevAlt >= prevG - 0.4;
      const below = rayAlt <= g + 0.15;
      if (above && below) {
        // interpolate the crossing for a stable aim height
        const a0 = prevAlt - (prevG ?? g), a1 = rayAlt - g;
        const u = Math.abs(a0 - a1) < 1e-6 ? 1 : Math.max(0, Math.min(1, a0 / (a0 - a1)));
        const hit: [number, number] = [
          (from[0] + (to[0] - from[0]) * ((i - 1) / 24)) * (1 - u) + p[0] * u,
          (from[1] + (to[1] - from[1]) * ((i - 1) / 24)) * (1 - u) + p[1] * u,
        ];
        const alt = this.groundAt(hit) ?? g;
        return { point: hit, altitude: alt, wall: false };
      }
      prevAlt = rayAlt;
      prevG = g;
    }
    const g = this.unproject([x, y]);
    const altitude = this.groundAt([g.lng, g.lat]) ?? cam.state.elevation;
    return { point: [g.lng, g.lat], altitude, wall: false };
  }

  /** Next time of day: real → morning → day → evening → night → real. */
  cycleTime() {
    return this.setTimeMode(TIME_MODES[(TIME_MODES.indexOf(this.timeMode) + 1) % TIME_MODES.length]);
  }

  /** Lock the sky to a mode (`real` follows the clock). */
  setTimeMode(mode: TimeMode) {
    const [lng, lat] = this.camera.state.center;
    const from = this.shownTime(lat, lng).getTime();
    this.timeMode = mode;
    this.modeDate = mode === 'real' ? null : timeFor(mode, new Date(), lat, lng);
    // the short way round the clock: back from midday to morning, on from evening to night
    let to = (this.modeDate ?? new Date()).getTime();
    while (to - from > 43200000) to -= 86400000;
    while (from - to > 43200000) to += 86400000;
    this.timeRoll = Math.abs(to - from) > 60000 ? { from, to, start: performance.now() } : null;
    this.lightClock = 0;
    this.emit('timemode', { mode: this.timeMode, clock: placeClock(this.shownTime(lat, lng), lat, lng) });
    this.triggerRepaint();
    return this.timeMode;
  }

  /** Where the player car is; buildings between it and the camera become see-through. Null turns it off. */
  setFocusCar(at: [number, number] | null, altitude = 0, heading = 0, pitch = 0) {
    this.focusCar = at ? { at: [...at], altitude, heading, pitch } : null;
  }

  /** First building hit along a shot (like CityBuildings.shoot); `mark` leaves a bullet hole. */
  raycastBuildings(from: [number, number], fromAlt: number, to: [number, number], toAlt: number, mark = false): { point: [number, number]; altitude: number; glass?: boolean } | null {
    const exaggeration = this.exaggeration;
    const hit = this.world.raycastBuildings(from, fromAlt, to, toAlt, exaggeration);
    // a tree or street lamp in front of the wall takes the bullet and goes down
    const prop = this.world.raycastProps(from, fromAlt, to, toAlt, exaggeration);
    // bus-shelter glass panes shatter instead of taking a wall hole
    const glass = this.world.raycastGlass(from, fromAlt, to, toAlt, exaggeration);
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const denom = dx * dx + dy * dy || 1;
    const wallT = hit ? ((hit.point[0] - from[0]) * dx + (hit.point[1] - from[1]) * dy) / denom : Infinity;
    const propT = prop?.t ?? Infinity;
    const glassT = glass?.t ?? Infinity;
    if (glassT < wallT && glassT < propT) {
      if (mark) {
        this.world.shatterGlass(glass!);
        this.triggerRepaint();
      }
      return { point: glass!.point, altitude: glass!.altitude, glass: true };
    }
    if (prop && propT < wallT) {
      if (mark) {
        if (this.world.topple(prop, performance.now()) >= 50) this.emit('topple', { point: prop.point });
        this.triggerRepaint();
      }
      return { point: prop.point, altitude: prop.altitude };
    }
    if (hit && mark) this.addHole(hit.point, hit.altitude, hit.normal);
    return hit ? { point: hit.point, altitude: hit.altitude } : null;
  }

  /**
   * A car moving from → to at `altitude` knocks over the first tree, lamp,
   * statue, bollard/bin, or (above ~100 km/h) bus shelter in its way.
   * `speed` is m/s. Returns km/h to shave off and whether a solid was cleared.
   */
  knockDown(from: [number, number], to: [number, number], altitude: number, halfWidth = 0.9, speed = 0) {
    const cos = Math.cos(from[1] * Math.PI / 180);
    const de = (to[0] - from[0]) * METERS_PER_DEGREE * cos;
    const dn = (to[1] - from[1]) * METERS_PER_DEGREE;
    const dist = Math.hypot(de, dn);
    const steps = Math.max(1, Math.ceil(dist / 1.25));
    let slowKmh = 0;
    let clearedSolid = false;
    const shelterMin = 100 / 3.6; // bus stops only fly aside above 100 km/h
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const a: [number, number] = [from[0] + (to[0] - from[0]) * t0, from[1] + (to[1] - from[1]) * t0];
      const b: [number, number] = [from[0] + (to[0] - from[0]) * t1, from[1] + (to[1] - from[1]) * t1];
      const prop = this.world.raycastProps(a, altitude + 0.6, b, altitude + 0.6, this.exaggeration, halfWidth);
      if (!prop) continue;
      const kind = prop.live.data.vegetation.fell[prop.index];
      // below 100: shelter stays a hard wall (buildingsNear); don't tip it
      if (kind === 2 && speed < shelterMin) continue;
      slowKmh = this.world.topple(prop, performance.now(), speed);
      if (slowKmh >= 50) this.emit('topple', { point: prop.point });
      if (kind === 2 || kind === 7) clearedSolid = true;
      break; // one prop per move step — next physics tick can fell another
    }
    if (slowKmh > 0 || clearedSolid) this.triggerRepaint();
    return { slowKmh, clearedSolid };
  }

  /** Repaint every building in an architecture skin (or the city's own look); instant, nothing reloads. */
  setSkin(id: SkinId) {
    const u = this.uniforms;
    this.skinId = id;
    // neon lamps + spires only for a fully futuristic city (mixed keeps classic streets)
    this.world.setSpires(id === 'futuristic');
    if (id === 'original') { u.uSkin.value = 0; this.triggerRepaint(); return; }
    const lin = (hex: string) => new THREE.Color().setStyle(hex, THREE.SRGBColorSpace); // three keeps colours linear
    const weighted = (list: [string, number][], into: THREE.Vector4[], offset: number) => {
      const total = list.reduce((sum, [, w]) => sum + w, 0);
      let acc = 0;
      for (let i = 0; i < 5; i++) {
        const [hex, w] = list[Math.min(i, list.length - 1)];
        if (i < list.length) acc += w / total;
        const c = lin(hex);
        into[offset + i].set(c.r, c.g, c.b, i < list.length - 1 ? acc : 1);
      }
    };
    const fillBank = (skin: Skin, bank: number) => {
      weighted(skin.wall, u.uSkinWall.value, bank * 5);
      weighted(skin.roof, u.uSkinRoof.value, bank * 5);
      [skin.secondary, skin.glass, skin.frame, skin.trim, skin.accent, skin.glow].forEach((list, k) => {
        for (let i = 0; i < 4; i++) {
          const c = lin(list[i % list.length]);
          u.uSkinColors.value[bank * 24 + k * 4 + i].set(c.r, c.g, c.b);
        }
      });
      u.uSkinOpt.value[bank].set(skin.lit, skin.accentChance, skin.featureChance, skin.wallRange);
      u.uSkinRoofRange.value.setComponent(bank, skin.roofRange);
    };
    if (id === 'mixed') {
      for (const painted of PAINTED_SKINS) fillBank(SKIN_DATA[painted], SKIN_DATA[painted].index - 1);
      u.uSkin.value = 4;
    } else {
      const skin = SKIN_DATA[id];
      fillBank(skin, skin.index - 1);
      u.uSkin.value = skin.index;
    }
    this.triggerRepaint();
  }

  /** A bullet mark on the ground; the drive height is already the top of the pavement. */
  markGround(point: [number, number], altitude: number) {
    this.addHole(point, altitude + 0.06, [0, 1, 0]);
  }

  private addHole(at: [number, number], altitude: number, normal: [number, number, number]) {
    this.holes.push({ at: [...at], altitude, normal });
    if (this.holes.length > MAX_HOLES) this.holes.shift(); // the oldest hole goes
    if (Math.abs(normal[1]) < 0.5) this.addBrokenPane(at, altitude);
    this.holesDirty = true;
    this.triggerRepaint();
  }

  /**
   * One shader slot per window: spray on the same pane used to burn the MAX_SHOTS
   * budget so farther glass stayed lit with no cracks while hole decals still showed.
   */
  private addBrokenPane(at: [number, number], altitude: number) {
    const cos = Math.cos(at[1] * Math.PI / 180);
    const MERGE_M = 1.2;
    const MERGE_UP = 1.0;
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i];
      const de = (pane.at[0] - at[0]) * METERS_PER_DEGREE * cos;
      const dn = (pane.at[1] - at[1]) * METERS_PER_DEGREE;
      if (Math.hypot(de, dn) < MERGE_M && Math.abs(pane.altitude - altitude) < MERGE_UP) {
        // refresh: keep it near the end so prune keeps recently shot glass
        this.panes.splice(i, 1);
        this.panes.push(pane);
        this.panesDirty = true;
        return;
      }
    }
    this.panes.push({
      at: [...at],
      altitude,
      seed: Math.abs(Math.sin(at[0] * 12.9898 + at[1] * 78.233) * 43758.5453) % 1,
    });
    if (this.panes.length > MAX_PANES) this.panes.shift();
    this.panesDirty = true;
  }

  private placeHoles(perMeter: number) {
    const key = `${this.origin.x01},${this.origin.y01}`;
    if (!this.holesDirty && key === this.holesOrigin) return;
    this.holesDirty = false;
    this.holesOrigin = key;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), n = new THREE.Vector3();
    const z = new THREE.Vector3(0, 0, 1), one = new THREE.Vector3(1, 1, 1);
    this.holes.forEach((h, i) => {
      // normal is (east, up, north); scene axes are (east, up, south)
      n.set(h.normal[0], h.normal[1], -h.normal[2]).normalize();
      p.set((mercatorX01(h.at[0]) - this.origin.x01) / perMeter, h.altitude, (mercatorY01(h.at[1]) - this.origin.y01) / perMeter).addScaledVector(n, 0.02);
      q.setFromUnitVectors(z, n);
      m.compose(p, q, one.setScalar(0.8 + ((i * 7919) % 5) * 0.1));
      this.holeMesh.setMatrixAt(i, m);
    });
    this.holeMesh.count = this.holes.length;
    this.holeMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Street lamps at night. Their light is baked per tile (every lamp at once, see
   * tiles/vegetationTile lampLight), so here is only how lit (night) and the colour:
   * warm heads, or the futuristic glass posts' blue.
   */
  private placeLamps() {
    const u = this.uniforms;
    const night = this.lighting?.night ?? 0;
    const futuristic = u.uSkin.value > 1.5 && u.uSkin.value < 2.5;
    u.uLampOn.value = Math.min(1, Math.max(0, (night - 0.05) * 1.5));
    u.uLampOmni.value = futuristic ? 1 : 0;
    u.uLampColor.value.setRGB(...(futuristic ? [0.35, 0.8, 1.15] : [1, 0.8, 0.52]) as [number, number, number]);
  }

  /** Broken panes: forget those past the drawn area, hand the nearest ones to the facade shader. */
  private placePanes(perMeter: number) {
    const shots = this.uniforms.uShots.value;
    if (!this.panes.length) {
      if (this.uniforms.uShotCount.value !== 0) this.uniforms.uShotCount.value = 0;
      this.panesDirty = false;
      return;
    }
    // origin rebase / new hits / occasional prune — not every camera micro-move
    const now = performance.now();
    const key = `${this.origin.x01},${this.origin.y01}`;
    if (!this.panesDirty && now - this.panesAt < 180 && key === this.holesOrigin) return;
    this.panesDirty = false;
    this.panesAt = now;
    const eye = this.uniforms.uCameraPos.value;
    // Prefer panes by the car: long bursts used to fill the shader budget with
    // farther hits so glass next to you looked whole again (night lights "on fire").
    const prefer = this.focusCar ? this.uniforms.uCar.value : eye;
    const reach = this.uniforms.uFogFar.value;
    const near: { d: number; x: number; y: number; z: number; seed: number }[] = [];
    this.panes = this.panes.filter((pane) => {
      const x = (mercatorX01(pane.at[0]) - this.origin.x01) / perMeter, z = (mercatorY01(pane.at[1]) - this.origin.y01) / perMeter;
      if (Math.hypot(x - eye.x, z - eye.z) > reach) return false; // out of the drawn area: whole again next time
      near.push({ d: Math.hypot(x - prefer.x, z - prefer.z), x, y: pane.altitude, z, seed: pane.seed });
      return true;
    });
    if (near.length > shots.length) near.sort((a, b) => a.d - b.d);
    const count = Math.min(shots.length, near.length);
    for (let i = 0; i < count; i++) shots[i].set(near[i].x, near[i].y, near[i].z, near[i].seed);
    this.uniforms.uShotCount.value = count;
  }

  /** Burning / soot windows: nearest ones to the camera → façade shader (w: 1 lit, 0 soot only). */
  private placeFires(perMeter: number) {
    const fires = this.uniforms.uFires.value;
    if (!this.fires.length) {
      if (this.uniforms.uFireCount.value !== 0) this.uniforms.uFireCount.value = 0;
      this.firesDirty = false;
      return;
    }
    const key = `${this.origin.x01},${this.origin.y01}`;
    if (!this.firesDirty && key === this.firesOrigin) return;
    this.firesDirty = false;
    this.firesOrigin = key;
    const eye = this.uniforms.uCameraPos.value;
    const near: { d: number; x: number; y: number; z: number; lit: number }[] = [];
    for (const pane of this.fires) {
      const x = (mercatorX01(pane.at[0]) - this.origin.x01) / perMeter, z = (mercatorY01(pane.at[1]) - this.origin.y01) / perMeter;
      near.push({ d: Math.hypot(x - eye.x, z - eye.z), x, y: pane.altitude, z, lit: pane.lit ? 1 : 0 });
    }
    if (near.length > fires.length) near.sort((a, b) => a.d - b.d);
    const count = Math.min(fires.length, near.length);
    for (let i = 0; i < count; i++) fires[i].set(near[i].x, near[i].y, near[i].z, near[i].lit);
    this.uniforms.uFireCount.value = count;
  }

  setPixelRatio(ratio: number) {
    this.renderer.setPixelRatio(ratio);
    this.resize();
  }

  // ---- markers ------------------------------------------------------------
  /** @internal */ addMarker(marker: ThreeMarker) { this.markers.add(marker); this.markerLayer.appendChild(marker.getElement()); this.placeMarker(marker); }
  /** @internal */ removeMarker(marker: ThreeMarker) { this.markers.delete(marker); marker.getElement().remove(); }
  /** @internal */ placeMarker(marker: ThreeMarker) {
    const el = marker.getElement();
    const [lng, lat] = marker.position();
    // stands on the ground under it: known once its tile is in (kept after the tile goes);
    // until then hidden, a label at a guessed height slides across the screen as the camera moves
    const ground = marker.fixed ?? this.groundAt([lng, lat]);
    if (ground != null) marker.altitude = ground;
    if (marker.altitude == null) { el.style.visibility = 'hidden'; return; }
    this.camera.update();
    const p = this.camera.project(lng, lat, marker.altitude);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { el.style.visibility = 'hidden'; return; }
    el.style.visibility = '';
    const shift = el.dataset.anchor === 'bottom' ? 'translate(-50%,-100%)' : 'translate(-50%,-50%)';
    el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) ${shift}`;
  }

  // ---- rendering ----------------------------------------------------------
  triggerRepaint() {
    if (this.frame || this.removed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Synchronous render, like Map.redraw(); used by the benchmark. */
  redraw() {
    this.render();
    return this;
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.state.width = width;
    this.camera.state.height = height;
    this.emit('resize', {});
    this.triggerRepaint();
  }

  /** Keep scene coordinates small: re-centre the floating origin near the camera. */
  private rebase(force = false) {
    const [lng, lat] = this.camera.state.center;
    const x01 = mercatorX01(lng), y01 = mercatorY01(lat);
    const mpm = mercatorPerMeter(this.origin.lat || lat);
    const far = Math.hypot(x01 - this.origin.x01, y01 - this.origin.y01) / mpm > REBASE_METERS;
    if (!force && !far) return;
    this.origin = { x01, y01, lat };
    const perMeter = mercatorPerMeter(lat);
    this.world.setOrigin(x01, y01, 1 / perMeter);
    // scene (x east, y up, z south; meters) → mercator 0..1 (z = altitude in mercator units)
    this.sceneToMercator.set(
      perMeter, 0, 0, x01,
      0, 0, perMeter, y01,
      0, perMeter, 0, 0,
      0, 0, 0, 1,
    );
    this.mercatorToScene.copy(this.sceneToMercator).invert();
  }

  private render() {
    if (this.removed) return;
    this.rebase();
    const cam = this.camera;
    cam.update();
    // stream ahead of travel so the first lap hitches behind the car, not under it.
    // boot burst: isotropic ring + faster uploads until the map is revealed.
    const streamHeading = this.focusCar?.heading
      ?? (-cam.state.bearing * Math.PI / 180);
    // top-down map: stream the whole screen rectangle so corners don't go black
    // (circular load/unload drops tiles while they are still on screen)
    const above = Math.max(0, cam.cameraAltitude() - cam.state.elevation);
    const mapView = this.screenStream || (cam.state.pitch < 25 && above > 900);
    const screen = mapView ? this.screenGroundBounds() : null;
    // never blank walls/trees for the M-map — keep the city drawn
    this.world.setMapLite(false);
    this.world.setPropsHidden(false);
    this.world.update(
      cam.state.center,
      streamHeading,
      this.streamBurst && !this.streamCalm,
      screen ?? undefined,
      this.streamCalm,
    );
    worldTime.value = performance.now() / 1000;
    this.uniforms.uClock.value = worldTime.value;
    this.updateSeason();
    // tiles past the opaque fog are pure fog colour (= sky): skip them entirely.
    // Cap altitude fog growth — Manhattan skylines from height used to pull fog to 3–4 km
    // and fill the GPU with tower overdraw.
    const fogLift = Math.min(450, above * 0.35);
    let fogNear = 900 + fogLift;
    let fogFar = 1600 + fogLift * 1.15;
    // M-map / top-down: ground sits ~`above` metres from the camera. Chase fog
    // (≤2.1 km) then paints the whole city as solid sky — pink at dusk. Push the
    // haze past the ground so the map underfoot stays readable.
    if (mapView) {
      fogNear = above + 600;
      fogFar = above + 2200;
    }
    this.uniforms.uFogNear.value = fogNear;
    this.uniforms.uFogFar.value = fogFar;
    if (screen) this.world.cullOutside(screen.west, screen.south, screen.east, screen.north);
    else this.world.cullBeyond(cam.state.center, fogFar + 80);

    const clip = this.clipScratch.copy(cam.mainMatrix).multiply(this.sceneToMercator);
    // The chain mirrors once (mercator y points south). Pick the face side once.
    const side = clip.determinant() > 0 ? THREE.BackSide : THREE.FrontSide;
    if (side !== this.side) { this.side = side; this.world.setMaterialSide(side); }
    this.sceneCamera.projectionMatrix.copy(clip);
    this.sceneCamera.projectionMatrixInverse.copy(clip).invert();
    this.world.updateFallen(performance.now(), clip, this.focusCar?.at ?? cam.state.center);

    const perMeter = mercatorPerMeter(this.origin.lat);
    const eye = cam.cameraMercator;
    this.uniforms.uCameraPos.value.set((eye.x - this.origin.x01) / perMeter, eye.z / perMeter, (eye.y - this.origin.y01) / perMeter);
    // M-map / high cam: flora LOD is invisible under the pitch — skip the tile walk
    if (!mapView && above < 900) this.world.updateFloraDetail(this.uniforms.uCameraPos.value, above);
    this.placeLamps();
    this.updateLighting(eye, perMeter);
    this.updateFlare(eye, perMeter);
    this.placeHoles(perMeter);
    this.placePanes(perMeter);
    this.placeFires(perMeter);
    this.uniforms.uXray.value = this.focusCar ? 1 : 0;
    this.uniforms.uHeadOn.value = this.focusCar ? Math.min(1, (this.lighting?.night ?? 0) * 1.4) : 0;
    for (const layer of this.fused) (layer as { setHeadlights?: (on: number) => void }).setHeadlights?.(this.uniforms.uHeadOn.value);
    if (this.focusCar) {
      const c = this.focusCar.at;
      this.uniforms.uCar.value.set((mercatorX01(c[0]) - this.origin.x01) / perMeter, this.focusCar.altitude, (mercatorY01(c[1]) - this.origin.y01) / perMeter);
      // headlights: from the car's nose, aimed a little down the road
      const h = this.focusCar.heading;
      // the nose tilts with the car (ramps, hills, jumps), the beams with it
      const p = this.focusCar.pitch;
      const cp = Math.cos(p), sp = Math.sin(p);
      this.headFlat.set(Math.sin(h), 0, -Math.cos(h));
      this.headFwd.copy(this.headFlat).multiplyScalar(cp).y += sp;
      this.headUp.copy(this.headFlat).multiplyScalar(-sp).y += cp;
      this.uniforms.uHeadPos.value.copy(this.uniforms.uCar.value).addScaledVector(this.headFwd, 2.0).addScaledVector(this.headUp, 0.72);
      this.uniforms.uHeadDir.value.copy(this.headFwd).addScaledVector(this.headUp, -0.1).normalize();
      this.uniforms.uHeadSide.value.set(Math.cos(h), 0, Math.sin(h)).multiplyScalar(0.62);
    }

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const args = { defaultProjectionData: { mainMatrix: cam.mainMatrix.elements, fallbackMatrix: cam.mainMatrix.elements, tileMercatorCoords: [0, 0, 1, 1] }, shaderData: { variantName: 'mercator' } };
    for (const layer of this.layers) layer.prerender?.(gl, args);
    // scene layers update their state and placement first, then everything draws in one pass
    for (const layer of this.fused) {
      layer.render?.(gl, args);
      layer.scene!.matrix.multiplyMatrices(this.mercatorToScene, layer.placement!);
      layer.scene!.matrixWorldNeedsUpdate = true;
    }
    this.renderer.autoClear = true;
    if (!this.programsWarmed) {
      this.programsWarmed = true;
      try { this.renderer.compile(this.scene, this.sceneCamera); } catch { /* ignore */ }
    }
    this.renderer.render(this.scene, this.sceneCamera);
    for (const layer of this.layers) {
      if (!this.fused.includes(layer)) layer.render?.(gl, args);
    }
    this.renderer.resetState();
    for (const marker of this.markers) this.placeMarker(marker);
    this.emit('render', {});
  }

  /** Next season: real → spring → summer → autumn → winter → real. */
  cycleSeason() {
    this.seasonMode = SEASON_MODES[(SEASON_MODES.indexOf(this.seasonMode) + 1) % SEASON_MODES.length];
    this.emit('seasonmode', { mode: this.seasonMode, season: this.season() });
    this.triggerRepaint();
    return this.seasonMode;
  }
  /** The season shown: chosen, or the real one at the place on screen. */
  season(): Season {
    if (this.seasonMode !== 'real') return this.seasonMode;
    const [lng, lat] = this.camera.state.center;
    return seasonAt(this.shownTime(lat, lng), lat);
  }
  /** Blend the trees toward the season over about a second. */
  private updateSeason() {
    const now = performance.now();
    const dt = this.seasonClock ? Math.min(0.1, (now - this.seasonClock) / 1000) : 1;
    this.seasonClock = now;
    const target = SEASONS.indexOf(this.season());
    const w = seasonWeights.value;
    const step = dt / 1.1;
    let moving = false;
    for (let i = 0; i < 4; i++) {
      const goal = i === target ? 1 : 0;
      const value = w.getComponent(i);
      const next = goal > value ? Math.min(goal, value + step) : Math.max(goal, value - step);
      if (next !== value) moving = true;
      w.setComponent(i, next);
    }
    // lying snow follows the view latitude (~42° N/S), same soft blend
    const [, lat] = this.camera.state.center;
    const snowGoal = snowCoverAt(lat);
    const snowNext = snowGoal > snowCover.value
      ? Math.min(snowGoal, snowCover.value + step)
      : Math.max(snowGoal, snowCover.value - step);
    if (snowNext !== snowCover.value) moving = true;
    snowCover.value = snowNext;
    if (moving) this.triggerRepaint();
  }
  /** the time zone of the last ~10 km cell asked about */
  private clockZone: { cell: string; timeZone: string } | null = null;

  /** The moment the sky shows where the car is (or the view centre), and that place's time zone. */
  localTime(): { at: Date; timeZone: string } {
    const [lng, lat] = this.focusCar?.at ?? this.camera.state.center;
    const cell = `${Math.round(lng * 10)}:${Math.round(lat * 10)}`;
    if (this.clockZone?.cell !== cell) this.clockZone = { cell, timeZone: placeZone(lat, lng) };
    return { at: this.shownTime(lat, lng), timeZone: this.clockZone.timeZone };
  }

  /** The moment the world is lit for: the place's real time unless T or ?time= says otherwise. */
  private shownTime(lat: number, lng: number) {
    if (this.timeRoll) {
      const k = (performance.now() - this.timeRoll.start) / TIME_ROLL_MS;
      if (k < 1) {
        const e = k * k * (3 - 2 * k);
        return new Date(this.timeRoll.from + (this.timeRoll.to - this.timeRoll.from) * e);
      }
      this.timeRoll = null;
    }
    if (this.modeDate) return this.modeDate;
    if (this.fixedClock) return placeMoment(new Date(), lat, lng, ...this.fixedClock);
    return new Date();
  }
  /** The sun's lens flare: where the sun is on screen, how strong, and whether a house hides it. */
  private updateFlare(eye: THREE.Vector3, perMeter: number) {
    const l = this.lighting;
    const h = l ? l.sunPos.altitude * 180 / Math.PI : -90;
    // from just over the horizon; strongest low (sunrise, sunset), gentler at midday
    const strength = h < -1 ? 0 : Math.min(1, (h + 1) / 2) * (0.5 + 0.5 * Math.max(0, 1 - h / 25));
    const s = this.camera.state;
    if (!l || strength <= 0.01) { this.flare.update(null, s.width, s.height, 0, l?.sun ?? new THREE.Color(), () => true); return; }
    const lng = eye.x * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * eye.y))) * 180 / Math.PI;
    const alt = eye.z / perMeter;
    const [east, up, south] = skyDirection(l.sunPos);
    const toward = (meters: number): [number, number, number] => [
      lng + east * meters / (METERS_PER_DEGREE * Math.cos(lat * Math.PI / 180)),
      lat - south * meters / METERS_PER_DEGREE,
      alt + up * meters,
    ];
    const far = toward(5000);
    const point = this.camera.project(far[0], far[1], far[2]);
    const sun = Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    this.flare.update(sun, s.width, s.height, strength, l.sun, () => {
      const near = toward(600);
      return this.raycastBuildings([lng, lat], alt, [near[0], near[1]], near[2]) != null;
    });
  }

  /** Sun or moon light for this place and moment; recomputed twice a second. */
  private updateLighting(eye: THREE.Vector3, perMeter: number) {
    const now = performance.now();
    // while the clock rolls to a new time of day: every frame, and keep drawing
    if (this.timeRoll) this.triggerRepaint();
    if (!this.lighting || this.timeRoll || now - this.lightClock > 500) {
      this.lightClock = now;
      const [lng, lat] = this.camera.state.center;
      const date = this.shownTime(lat, lng);
      this.lighting = computeLighting(date, lat, lng);
      const l = this.lighting;
      const u = this.uniforms;
      u.uSun.value.copy(l.dir);
      u.uSunColor.value.copy(l.sun);
      u.uAmbient.value.copy(l.ambient);
      u.uNight.value = l.night;
      // cloud shadows by day: none at night, full once the sun is 12° up
      u.uClouds.value = Math.min(1, Math.max(0, l.sunPos.altitude * 180 / Math.PI / 12));
      u.uFogColor.value.copy(l.sky);
      this.renderer.setClearColor(new THREE.Color().setRGB(l.sky.r, l.sky.g, l.sky.b, THREE.SRGBColorSpace));
      // colour grade by the time of day, done by the compositor (costs nothing): warmer and
      // punchier at sunset, cooler and brighter at dawn, a little greyer at night
      const grade = `saturate(${(1.12 + 0.12 * l.warm - 0.18 * l.night).toFixed(3)}) contrast(${(1.06 + 0.05 * l.warm + 0.03 * l.night).toFixed(3)}) sepia(${(0.12 * l.warm).toFixed(3)}) hue-rotate(${(-6 * l.cool).toFixed(1)}deg) brightness(${(1 + 0.03 * l.cool).toFixed(3)})`;
      if (this.canvas.style.filter !== grade) this.canvas.style.filter = grade;
    }
    const eyeScene = new THREE.Vector3((eye.x - this.origin.x01) / perMeter, eye.z / perMeter, (eye.y - this.origin.y01) / perMeter);
    this.sky.update(eyeScene, this.lighting);
    this.lightLayers(this.lighting);
  }

  /** The car layer's own lights follow the sun: direction, colour and strength. */
  private lightLayers(l: Lighting) {
    const rotation = new THREE.Matrix4();
    for (const layer of this.fused) {
      const scene = layer.scene!;
      rotation.extractRotation(scene.matrix).invert();
      scene.traverse((object) => {
        const light = object as THREE.Light;
        if (!light.isLight) return;
        light.userData.base ??= { intensity: light.intensity, color: light.color.clone() };
        const base = light.userData.base as { intensity: number; color: THREE.Color };
        if ((light as THREE.HemisphereLight).isHemisphereLight) {
          light.intensity = base.intensity * (0.38 + 0.62 * l.level); // the car stays readable at night
          light.color.copy(base.color).multiply(new THREE.Color(l.ambient.r / 0.72, l.ambient.g / 0.73, l.ambient.b / 0.75));
          return;
        }
        if ((light as THREE.DirectionalLight).isDirectionalLight) {
          const dl = light as THREE.DirectionalLight;
          const strength = (l.sun.r + l.sun.g + l.sun.b) / 3 / 0.61;
          dl.intensity = base.intensity * Math.max(0.22, strength);
          dl.color.setRGB(l.sun.r / 0.64, l.sun.g / 0.62, l.sun.b / 0.57).multiplyScalar(1 / Math.max(1, Math.max(l.sun.r / 0.64, l.sun.g / 0.62, l.sun.b / 0.57)));
          if (!dl.target.parent) scene.add(dl.target);
          dl.target.position.set(0, 0, 0);
          // the key light comes from the sun; the rim keeps its offset around it
          const local = l.dir.clone().applyMatrix4(rotation).normalize();
          if (!dl.userData.rim) dl.userData.rim = dl.position.lengthSq() > 0 && dl.position.x < 0;
          if (dl.userData.rim) local.set(-local.x, local.y, -local.z);
          dl.position.copy(local.multiplyScalar(40));
        }
      });
    }
  }

  // ---- input (intro screen navigation; disabled while driving) --------------
  private bindInput() {
    const listen = (target: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, options);
      this.cleanups.push(() => target.removeEventListener(type, fn, options));
    };
    let drag: { button: number; x: number; y: number; moved: boolean } | null = null;
    listen(this.canvas, 'pointerdown', ((e: PointerEvent) => {
      drag = { button: e.button, x: e.clientX, y: e.clientY, moved: false };
    }) as EventListener);
    listen(window, 'pointermove', ((e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      const s = this.camera.state;
      if (drag.button === 0 && this.interactive.pan) {
        const rect = this.canvas.getBoundingClientRect();
        const a = this.unproject([drag.x - rect.left, drag.y - rect.top]);
        const b = this.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        this.jumpTo({ center: [s.center[0] - (b.lng - a.lng), s.center[1] - (b.lat - a.lat)] });
      } else if (drag.button === 2 && this.interactive.rotate) {
        this.jumpTo({ bearing: s.bearing + dx * 0.4, pitch: s.pitch - dy * 0.3 });
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
    }) as EventListener);
    listen(window, 'pointerup', ((e: PointerEvent) => {
      const d = drag;
      drag = null;
      if (!d || d.moved || d.button !== 0 || e.target !== this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this.emit('click', { point, lngLat: this.unproject(point), originalEvent: e });
    }) as EventListener);
    listen(this.canvas, 'wheel', ((e: WheelEvent) => {
      if (!this.interactive.pan) return;
      e.preventDefault();
      // pixels; Firefox may send lines. A touchpad pinch arrives as a wheel with ctrlKey and small steps.
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      const zoom = Math.min(22, Math.max(12, this.camera.state.zoom - delta * (e.ctrlKey ? 0.012 : 0.0022)));
      // zoom toward the point under the cursor, like any map
      const rect = this.canvas.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const before = this.unproject(at);
      this.jumpTo({ zoom });
      const after = this.unproject(at);
      const [lng, lat] = this.camera.state.center;
      this.jumpTo({ center: [lng + before.lng - after.lng, lat + before.lat - after.lat] });
    }) as EventListener, { passive: false });
    listen(this.canvas, 'contextmenu', (e) => e.preventDefault());
    listen(window, 'keydown', ((e: KeyboardEvent) => {
      if (e.code !== 'KeyT' || e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.shiftKey) this.cycleSeason();
      else this.cycleTime();
    }) as EventListener);
  }

  remove() {
    this.removed = true;
    this.flare.dispose();
    cancelAnimationFrame(this.frame);
    for (const fn of this.cleanups) fn();
    this.resizeObserver.disconnect();
    for (const layer of [...this.layers]) this.removeLayer(layer.id);
    for (const marker of [...this.markers]) marker.remove();
    this.world.dispose();
    this.sky.dispose();
    this.mask.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.markerLayer.remove();
  }
}
