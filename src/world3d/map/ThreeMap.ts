import * as THREE from 'three';
import { MapCamera, mercatorPerMeter, mercatorX01, mercatorY01 } from './camera';
import { WorldTiles, defaultWorldOptions } from './WorldTiles';
import { baseUniforms, facadeMask, type BaseUniforms } from './materials';
import type { GeoFeature } from '../tiles/worldTile';
import { worldTime, type SimpleLitUniforms } from './simpleLit';
import { computeLighting, timeFor, TIME_MODES, type Lighting, type TimeMode } from './lighting';
import { SkyBodies } from './sky';

// A small stand-in for maplibregl.Map, backed by our own Three.js world.
// It implements only what City Rider calls, with the same semantics, so the
// game engine and the existing custom Three.js layers run unchanged on top.
// Everything MapLibre-specific (style restyling, hidden layers, worker copy,
// DEM level switching) simply does not exist here.

type LngLatLike = [number, number] | { lng: number; lat: number };
type Listener = (event: Record<string, unknown>) => void;
type CustomLayer = {
  id: string;
  type: string;
  /** scene layers: drawn inside our one scene instead of with their own renderer */
  scene?: THREE.Scene;
  placement?: THREE.Matrix4;
  fuse?: (world?: SimpleLitUniforms) => void;
  onAdd?: (map: ThreeMap, gl: WebGL2RenderingContext) => void;
  onRemove?: (map: ThreeMap, gl: WebGL2RenderingContext) => void;
  prerender?: (gl: WebGL2RenderingContext, args: unknown) => void;
  render?: (gl: WebGL2RenderingContext, args: unknown) => void;
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
const SOURCE_ID = 'openmaptiles';
const REBASE_METERS = 1500;

function toLngLat(p: LngLatLike): [number, number] {
  return Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat];
}

class Handler {
  enabled = false;
  enable() { this.enabled = true; }
  disable() { this.enabled = false; }
  isEnabled() { return this.enabled; }
}

export class ThreeMarker {
  private element: HTMLElement;
  private lngLat: [number, number] = [0, 0];
  private map: ThreeMap | null = null;
  constructor(options: { element?: HTMLElement; anchor?: string } = {}) {
    this.element = options.element ?? document.createElement('div');
    this.element.style.position = 'absolute';
    this.element.style.left = '0';
    this.element.style.top = '0';
    this.element.style.willChange = 'transform';
    // anchor: bottom (the only one the game uses)
    this.element.dataset.anchor = options.anchor ?? 'center';
  }
  setLngLat(p: LngLatLike) { this.lngLat = toLngLat(p); this.map?.placeMarker(this); return this; }
  getLngLat() { return { lng: this.lngLat[0], lat: this.lngLat[1] }; }
  addTo(map: ThreeMap) { this.map = map; map.addMarker(this); return this; }
  remove() { this.map?.removeMarker(this); this.map = null; return this; }
  getElement() { return this.element; }
  /** @internal */ position() { return this.lngLat; }
}

export class ThreeMap {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new MapCamera();
  readonly world: WorldTiles;
  readonly uniforms: BaseUniforms;
  readonly dragPan = new Handler();
  readonly scrollZoom = new Handler();
  readonly dragRotate = new Handler();
  readonly touchPitch = new Handler();
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private markerLayer: HTMLDivElement;
  private markers = new Set<ThreeMarker>();
  private scene = new THREE.Scene();
  private sceneCamera = new THREE.Camera();
  private sceneToMercator = new THREE.Matrix4();
  private mercatorToScene = new THREE.Matrix4();
  private fused: CustomLayer[] = [];
  private listeners = new Map<string, Set<Listener>>();
  private layers: CustomLayer[] = [];
  private sources = new Map<string, unknown>();
  private terrain: { source: string; exaggeration: number } | null = null;
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
  private modeDate: Date | null = null;
  /** fixed wall-clock time from ?time=HH:MM (testing) */
  private fixedTime: Date | null = null;
  private sky = new SkyBodies();
  private lighting: Lighting | null = null;
  private lightClock = 0;
  /** bullet holes on walls, roofs and ground; world positions, oldest replaced first */
  private holes: { at: [number, number]; altitude: number; normal: [number, number, number] }[] = [];
  private holeMesh: THREE.InstancedMesh;
  private holesDirty = false;
  private holesOrigin = '';
  /** player car (lng/lat, altitude m) for the see-through buildings in front of it */
  private focusCar: { at: [number, number]; altitude: number } | null = null;
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
    this.container.appendChild(this.canvas);
    this.markerLayer = document.createElement('div');
    this.markerLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2';
    this.container.appendChild(this.markerLayer);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(new THREE.Color(SKY));
    this.scene.matrixAutoUpdate = false;
    this.sceneCamera.matrixAutoUpdate = false;
    this.sceneCamera.matrixWorldAutoUpdate = false;

    this.uniforms = baseUniforms(SKY);
    this.mask = facadeMask();
    this.world = new WorldTiles(this.uniforms, this.mask, { ...defaultWorldOptions, demTemplate: options.dem ?? null, region: options.region ?? '' });
    this.world.onTile = () => {
      this.emit('sourcedata', { sourceId: SOURCE_ID, sourceDataType: 'content', isSourceLoaded: true });
      this.emit('sourcedata', { sourceId: 'elevation', sourceDataType: 'content', isSourceLoaded: true });
      this.triggerRepaint();
    };
    this.scene.add(this.world.root);
    this.scene.add(this.sky.group);
    this.holeMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.075, 12),
      new THREE.MeshBasicMaterial({ color: '#151210', transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16, side: THREE.DoubleSide }),
      512,
    );
    this.holeMesh.count = 0;
    this.holeMesh.frustumCulled = false;
    this.holeMesh.renderOrder = 5;
    this.scene.add(this.holeMesh);
    const wanted = new URLSearchParams(window.location.search).get('time');
    if (wanted && /^\d{1,2}:\d{2}$/.test(wanted)) {
      const [h, m] = wanted.split(':').map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      this.fixedTime = d;
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

  // ---- style / sources / layers (only what the game touches) ----------------
  getStyle() { return { version: 8, layers: [] as { id: string; type: string }[], sources: { [SOURCE_ID]: { type: 'vector' } } }; }
  addSource(id: string, spec: unknown) { this.sources.set(id, spec); return this; }
  getSource(id: string) { return id === SOURCE_ID ? { type: 'vector' } : this.sources.get(id); }
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
  setLayoutProperty() { return this; }
  getLayoutProperty() { return undefined; }
  setPaintProperty() { return this; }
  getPaintProperty() { return undefined; }
  setCenterClampedToGround() { return this; }

  // ---- terrain ------------------------------------------------------------
  setTerrain(spec: { source: string; exaggeration?: number } | null) {
    this.terrain = spec ? { source: spec.source, exaggeration: spec.exaggeration ?? 1 } : null;
    this.uniforms.uExag.value = this.terrain?.exaggeration ?? 0;
    this.triggerRepaint();
    return this;
  }
  getTerrain() { return this.terrain; }
  /** Same contract as MapLibre: exaggerated meters, null without terrain or data. */
  queryTerrainElevation(p: LngLatLike): number | null {
    if (!this.terrain) return null;
    const [lng, lat] = toLngLat(p);
    const raw = this.world.groundAt(lng, lat);
    return raw == null ? null : raw * this.terrain.exaggeration;
  }
  getCenterElevation() { return this.camera.state.elevation; }
  isSourceLoaded(id: string) {
    const [lng, lat] = this.camera.state.center;
    if (id === 'elevation') return this.world.hasDemAt(lng, lat);
    return this.world.loadedAround([lng, lat], 300);
  }
  /** Everything inside the fog is in: the world can be shown without anything popping in later. */
  areTilesLoaded() { return this.world.loadedAround(this.camera.state.center, this.uniforms.uFogFar.value); }

  /** GeoJSON features of a layer near the view, like MapLibre (all loaded layers, incl. poi…). */
  querySourceFeatures(_source: string, options: { sourceLayer?: string } = {}): GeoFeature[] {
    if (!options.sourceLayer) return [];
    return this.world.features(options.sourceLayer, this.camera.state.center);
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

  project(p: LngLatLike) {
    this.camera.update();
    const [lng, lat] = toLngLat(p);
    const altitude = this.queryTerrainElevation([lng, lat]) ?? 0;
    return this.camera.project(lng, lat, altitude);
  }
  unproject(point: { x: number; y: number } | [number, number]) {
    this.camera.update();
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    const hit = this.camera.unproject(x, y) ?? this.camera.state.center;
    return { lng: hit[0], lat: hit[1] };
  }

  /** Next time of day: real → morning → day → evening → night → real. */
  cycleTime() {
    this.timeMode = TIME_MODES[(TIME_MODES.indexOf(this.timeMode) + 1) % TIME_MODES.length];
    const [lng, lat] = this.camera.state.center;
    this.modeDate = this.timeMode === 'real' ? null : timeFor(this.timeMode, new Date(), lat, lng);
    this.lightClock = 0;
    this.emit('timemode', { mode: this.timeMode });
    this.triggerRepaint();
    return this.timeMode;
  }

  /** Where the player car is; buildings between it and the camera become see-through. Null turns it off. */
  setFocusCar(at: [number, number] | null, altitude = 0) {
    this.focusCar = at ? { at: [...at], altitude } : null;
  }

  /** First building hit along a shot (like CityBuildings.shoot); `mark` leaves a bullet hole. */
  raycastBuildings(from: [number, number], fromAlt: number, to: [number, number], toAlt: number, mark = false) {
    const hit = this.world.raycastBuildings(from, fromAlt, to, toAlt, this.terrain?.exaggeration ?? 0);
    if (hit && mark) this.addHole(hit.point, hit.altitude, hit.normal);
    return hit ? { point: hit.point, altitude: hit.altitude } : null;
  }

  /** A bullet mark on the ground (roads sit up to 0.15 m above it). */
  markGround(point: [number, number], altitude: number) {
    this.addHole(point, altitude + 0.18, [0, 1, 0]);
  }

  private addHole(at: [number, number], altitude: number, normal: [number, number, number]) {
    this.holes.push({ at: [...at], altitude, normal });
    if (this.holes.length > 512) this.holes.shift();
    this.holesDirty = true;
    this.triggerRepaint();
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

  setPixelRatio(ratio: number) {
    this.renderer.setPixelRatio(ratio);
    this.resize();
  }

  // ---- markers ------------------------------------------------------------
  /** @internal */ addMarker(marker: ThreeMarker) { this.markers.add(marker); this.markerLayer.appendChild(marker.getElement()); this.placeMarker(marker); }
  /** @internal */ removeMarker(marker: ThreeMarker) { this.markers.delete(marker); marker.getElement().remove(); }
  /** @internal */ placeMarker(marker: ThreeMarker) {
    const el = marker.getElement();
    const p = this.project(marker.position());
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
    // stream around what the camera looks at, plus a bit toward the viewer
    this.world.update(cam.state.center);
    worldTime.value = performance.now() / 1000;
    // tiles past the opaque fog are pure fog colour (= sky): skip them entirely
    // high above the city the haze moves out with the camera, so the whole area shows
    const above = Math.max(0, cam.cameraAltitude() - cam.state.elevation);
    this.uniforms.uFogNear.value = 1100 + above * 0.9;
    this.uniforms.uFogFar.value = 2000 + above * 1.1;
    this.world.cullBeyond(cam.state.center, this.uniforms.uFogFar.value + 150);

    const clip = new THREE.Matrix4().copy(cam.mainMatrix).multiply(this.sceneToMercator);
    // The chain mirrors once (mercator y points south). Pick the face side once.
    const side = clip.determinant() > 0 ? THREE.BackSide : THREE.FrontSide;
    if (side !== this.side) { this.side = side; this.world.setMaterialSide(side); }
    this.sceneCamera.projectionMatrix.copy(clip);
    this.sceneCamera.projectionMatrixInverse.copy(clip).invert();

    const perMeter = mercatorPerMeter(this.origin.lat);
    const eye = cam.cameraMercator;
    this.uniforms.uCameraPos.value.set((eye.x - this.origin.x01) / perMeter, eye.z / perMeter, (eye.y - this.origin.y01) / perMeter);
    this.updateLighting(eye, perMeter);
    this.placeHoles(perMeter);
    this.uniforms.uXray.value = this.focusCar ? 1 : 0;
    if (this.focusCar) {
      const c = this.focusCar.at;
      this.uniforms.uCar.value.set((mercatorX01(c[0]) - this.origin.x01) / perMeter, this.focusCar.altitude, (mercatorY01(c[1]) - this.origin.y01) / perMeter);
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
    this.renderer.render(this.scene, this.sceneCamera);
    for (const layer of this.layers) {
      if (!this.fused.includes(layer)) layer.render?.(gl, args);
    }
    this.renderer.resetState();
    for (const marker of this.markers) this.placeMarker(marker);
    this.emit('render', {});
  }

  /** Sun or moon light for this place and moment; recomputed twice a second. */
  private updateLighting(eye: THREE.Vector3, perMeter: number) {
    const now = performance.now();
    if (!this.lighting || now - this.lightClock > 500) {
      this.lightClock = now;
      const [lng, lat] = this.camera.state.center;
      const date = this.modeDate ?? this.fixedTime ?? new Date();
      this.lighting = computeLighting(date, lat, lng);
      const l = this.lighting;
      const u = this.uniforms;
      u.uSun.value.copy(l.dir);
      u.uSunColor.value.copy(l.sun);
      u.uAmbient.value.copy(l.ambient);
      u.uNight.value = l.night;
      u.uFogColor.value.copy(l.sky);
      this.renderer.setClearColor(new THREE.Color().setRGB(l.sky.r, l.sky.g, l.sky.b, THREE.SRGBColorSpace));
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
      if (drag.button === 0 && this.dragPan.enabled) {
        const rect = this.canvas.getBoundingClientRect();
        const a = this.unproject([drag.x - rect.left, drag.y - rect.top]);
        const b = this.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        this.jumpTo({ center: [s.center[0] - (b.lng - a.lng), s.center[1] - (b.lat - a.lat)] });
      } else if (drag.button === 2 && this.dragRotate.enabled) {
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
      if (!this.scrollZoom.enabled) return;
      e.preventDefault();
      this.jumpTo({ zoom: Math.min(22, Math.max(12, this.camera.state.zoom - e.deltaY * 0.0022)) });
    }) as EventListener, { passive: false });
    listen(this.canvas, 'contextmenu', (e) => e.preventDefault());
    listen(window, 'keydown', ((e: KeyboardEvent) => {
      if (e.code !== 'KeyT' || e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      this.cycleTime();
    }) as EventListener);
  }

  remove() {
    this.removed = true;
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
