import { roadStart } from './roadStart';
import { VehiclePose } from './VehiclePose';
import { supportAltitude, type GroundSample } from './groundSupport';
import { vegetationLayer } from '@/rendering/VegetationLayer';
import { BuildingCollisions, type Polygon } from './BuildingCollisions';
import { ThicketCollision } from './Vegetation';
import { WaterCollisionController, type MapFeature } from './WaterCollisionController';
import * as maplibregl from 'maplibre-gl';
import type { Map as LibreMap } from 'maplibre-gl';
import { mapConfig, type City, type Car, vehicleConfig } from '@/config/vehicle.config';
import { cameraConfig, zoomForDistance } from '@/config/camera.config';
import { HOUSE_PALETTE } from './buildings/BuildingStyles';
import { VehicleController, offsetPosition } from './VehicleController';
import { vehicleLayer } from '@/rendering/VehicleLayer';
import { cityLayer, type BuildingPart } from '@/rendering/CityBuildings';
import type { ArchitectureSetting, BuildingDetail } from './buildings/BuildingStyles';
import { collapseCopies, footprintKey, keepVisibleParts, retainNearParts } from './buildings/wallOverlap';

export type Quality = 'low' | 'medium' | 'high';
export type Settings = {
  terrain: boolean;
  follow: boolean;
  sensitivity: number;
  quality: Quality;
  buildingDetail: BuildingDetail;
  architecture: ArchitectureSetting;
};

function roadColor(id: string) {
  const pedestrian = /path|pedestrian|foot|cycle/.test(id);
  const casing = /casing/.test(id);
  if (pedestrian) return casing ? '#d5d0c6' : '#c4c1ba';
  if (/motorway|trunk|primary/.test(id)) return casing ? '#d2cec5' : '#9d9e99';
  if (/secondary|tertiary/.test(id)) return casing ? '#d6d2c9' : '#aaaba5';
  return casing ? '#dbd7ce' : '#b5b5af';
}

const LABEL_LAYER = /^(highway-name-|water_name_|waterway_line_label)/;

function hideBasemapBuildings(map: LibreMap) {
  const layers = map.getStyle()?.layers;
  if (!layers) return;
  for (const layer of layers) {
    // Keep the flat `building` fill alive (opacity 0). If it is layout-hidden,
    // MapLibre drops that source-layer from tiles and the city never builds.
    if (layer.type !== 'fill-extrusion' && layer.id !== 'building-3d') continue;
    if (!map.getLayer(layer.id)) continue;
    if (map.getLayoutProperty(layer.id, 'visibility') !== 'none') map.setLayoutProperty(layer.id, 'visibility', 'none');
  }
  if (map.getLayer('building')) {
    if (map.getLayoutProperty('building', 'visibility') === 'none') map.setLayoutProperty('building', 'visibility', 'visible');
    if (map.getPaintProperty('building', 'fill-opacity') !== 0) map.setPaintProperty('building', 'fill-opacity', 0);
  }
}

function paintCity(map: LibreMap, layer: { id: string; type: string }) {
  const labeled = LABEL_LAYER.test(layer.id);
  if (layer.type === 'fill-extrusion') map.removeLayer(layer.id);
  else if (layer.type === 'symbol' && labeled) {
    map.setLayoutProperty(layer.id, 'visibility', 'visible');
    map.setLayoutProperty(layer.id, 'text-size', ['interpolate', ['linear'], ['zoom'], 15, 13, 18, 16, 20.4, 20]);
    map.setLayoutProperty(layer.id, 'text-pitch-alignment', 'viewport');
    if (/^highway-name-/.test(layer.id)) map.setLayoutProperty(layer.id, 'symbol-spacing', 640);
    map.setPaintProperty(layer.id, 'text-color', '#24312e');
    map.setPaintProperty(layer.id, 'text-halo-color', '#f7f4ea');
    map.setPaintProperty(layer.id, 'text-halo-width', 1.8);
  }
  else if (layer.type === 'symbol') map.setLayoutProperty(layer.id, 'visibility', 'none');
  else if (layer.id === 'building') { map.setLayoutProperty(layer.id, 'visibility', 'visible'); map.setPaintProperty(layer.id, 'fill-opacity', 0); }
  else if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#dcdad3');
  else if (layer.type === 'fill' && /park|grass|wood|farmland|pitch|cemetery/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', /wood/.test(layer.id) ? '#69a577' : '#b1d59b');
  else if (layer.type === 'fill' && /residential/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#e5e2da');
  else if (layer.type === 'fill' && /school|hospital/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#f8dfda');
  else if (layer.type === 'fill' && /water/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#52b8ca');
  else if (layer.type === 'line' && /waterway/.test(layer.id)) map.setPaintProperty(layer.id, 'line-color', '#369fb7');
  else if (layer.type === 'line' && /^(road|bridge)_/.test(layer.id) && !/rail|hatch|one_way/.test(layer.id)) {
    map.setPaintProperty(layer.id, 'line-color', roadColor(layer.id));
    const pedestrian = /path|pedestrian|foot|cycle/.test(layer.id);
    const major = /motorway|trunk|primary/.test(layer.id);
    const casing = /casing/.test(layer.id) ? 1.04 : 1;
    const pavement = pedestrian ? 2 : 5.5;
    const width = (zoom: number) => (pedestrian ? 0.55 : major ? 1.7 : 1) * casing * pavement * zoom;
    map.setPaintProperty(layer.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 13, width(0.7), 16, width(2.2), 18, width(6), 20.2, width(16)]);
  }
}

export class GameEngine {
  collisions = new BuildingCollisions();
  thicket = new ThicketCollision();
  water = new WaterCollisionController();
  collisionDirty = true;
  collisionTime = 0;
  spawnResolved = false;
  private spawnWaits = 0;
  sourceId = '';
  map: LibreMap;
  vehicle: VehicleController;
  renderVehicle = new VehiclePose();
  keys = new Set<string>();
  settings: Settings;
  driving = false;
  altitude = 0;
  modelPitch = 0;
  modelRoll = 0;
  frame = 0;
  disposed = false;
  ready = false;
  distance = cameraConfig.distance;
  orbit = 0;
  pitch = cameraConfig.pitch;
  bearing = 0;
  last = 0;
  accumulator = 0;
  hudTime = 0;
  dragging = false;
  private introCameraKey = '';
  private spawnMarker: maplibregl.Marker | null = null;
  private defaultSpawn: { position: [number, number]; heading: number } | null = null;
  private customSpawn: { position: [number, number]; heading: number } | null = null;
  onSpawnSet: (position: [number, number] | null) => void = () => {};
  private host: HTMLElement;
  private mapShown = false;
  private bootAt = 0;
  private groundHits = 0;
  private lastGround: number | null = null;
  private settleFrames = 0;
  private approach = 0;
  private approachFrom: { lng: number; lat: number; zoom: number; pitch: number; bearing: number } | null = null;
  onApproach: (active: boolean) => void = () => {};
  onBoot: (ready: boolean) => void = () => {};
  message = '';
  cleanups: (() => void)[] = [];

  carScale = 1;
  car: Car;
  city: ReturnType<typeof cityLayer> | null = null;
  vegetation: ReturnType<typeof vegetationLayer> | null = null;
  shownBuildings = new Set<string>();
  syncedAt: [number, number] | null = null;
  fps = 0;
  private fpsFrames = 0;
  private fpsStamp = 0;
  private worldFresh = false;
  private greenedAt: [number, number] | null = null;
  private greenedTerrain: boolean | null = null;
  private remembered = new Map<string, { part: BuildingPart; measured: boolean }>();
  private retained = new Map<string, BuildingPart>();
  private featureReadFailures = new Set<string>();
  private region: string;
  get booted() { return this.mapShown; }
  constructor(el: HTMLElement, city: City, car: Car, settings: Settings, private hud: (speed: number, distance: number, scale: number, fps: number) => void, private status: (s: string) => void) {
    this.host = el;
    el.style.opacity = '0';
    this.bootAt = performance.now();
    this.settings = settings;
    this.car = car;
    this.region = city.country;
    this.vehicle = new VehicleController(city.coords, city.heading);
    this.renderVehicle.reset(this.vehicle);
    this.bearing = city.heading;
    maplibregl.setWorkerUrl('/vendor/maplibre-gl-worker.mjs');
    this.map = new maplibregl.Map({
      container: el,
      style: mapConfig.style,
      center: city.coords,
      zoom: 16.8,
      pitch: 57,
      bearing: city.heading - 25,
      interactive: false,
      maxPitch: 80,
      canvasContextAttributes: { antialias: true },
      attributionControl: { compact: true },
    });
    this.map.on('styledata', () => hideBasemapBuildings(this.map));
    this.map.on('sourcedata', event => {
      if ((event.sourceId === this.sourceId || event.sourceId === 'elevation') && event.sourceDataType === 'content') {
        this.collisionDirty = true;
      }
    });
    this.map.on('error', () => this.say('Часть карты недоступна · проверьте сеть'));
    this.map.on('load', () => {
      if (this.disposed) return;
      this.decorate();
      this.map.addSource('elevation', { type: 'raster-dem', ...mapConfig.dem });
      // Keep map labels below custom 3D geometry so buildings can occlude them.
      this.city = cityLayer(city.coords, parts => {
        this.collisions.update(this.vehicle.position, parts.map(part => part.rings));
      });
      this.map.addLayer(this.city);
      this.vegetation = vegetationLayer(city.coords);
      this.map.addLayer(this.vegetation);
      this.map.addLayer(vehicleLayer(car, this.renderVehicle, () => this.altitude, () => this.modelPitch, () => this.modelRoll, () => this.carScale, (text) => this.say(text)));
      this.applyLabelVisibility();
      this.applySettings(this.settings);
      this.ready = true;
      this.map.setCenterClampedToGround(false);
      this.collisionDirty = true;
      this.say('Ставим машину…');
      // Map click → set custom spawn
      this.map.on('click', (e) => {
        if (!this.driving && this.mapShown) this.setSpawnFromClick(e.lngLat);
      });
      this.map.on('move', () => {
        if (!this.driving && this.mapShown) this.collisionDirty = true;
      });
    });
    const listen = (target: EventTarget, event: string, fn: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(event, fn, options);
      this.cleanups.push(() => target.removeEventListener(event, fn, options));
    };
    listen(window, 'keydown', ((e: KeyboardEvent) => {
      if (!this.driving || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'KeyQ', 'KeyE', 'KeyL'].includes(e.code)) e.preventDefault();
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.keys.add(e.code);
      if (e.code === 'KeyR') this.resetCamera();
      if (e.code === 'KeyL' && !e.repeat) this.toggleLabels();
      if (e.code === 'KeyQ' && !e.repeat) this.resizeCar(1 / 1.4);
      if (e.code === 'KeyE' && !e.repeat) this.resizeCar(1.4);
    }) as EventListener);
    listen(window, 'keyup', ((e: KeyboardEvent) => { this.keys.delete(e.code); }) as EventListener);
    const clear = () => { this.keys.clear(); this.vehicle.speed = 0; this.vehicle.throttle = 0; this.last = 0; this.accumulator = 0; this.renderVehicle.reset(this.vehicle); this.dragging = false; };
    listen(window, 'blur', clear);
    listen(document, 'visibilitychange', clear);
    listen(el, 'contextmenu', (e) => e.preventDefault());
    listen(el, 'pointerdown', ((e: PointerEvent) => {
      if (e.button === 2 && this.driving) { this.dragging = true; el.setPointerCapture(e.pointerId); }
    }) as EventListener);
    listen(el, 'pointerup', () => { this.dragging = false; });
    listen(el, 'pointermove', ((e: PointerEvent) => {
      if (!this.dragging) return;
      this.orbit += e.movementX * 0.22 * this.settings.sensitivity;
      this.pitch = Math.max(cameraConfig.minPitch, Math.min(cameraConfig.maxPitch, this.pitch - e.movementY * 0.12 * this.settings.sensitivity));
    }) as EventListener);
    listen(el, 'wheel', ((e: WheelEvent) => {
      if (!this.driving) return;
      e.preventDefault();
      this.distance = Math.max(cameraConfig.minDistance, Math.min(cameraConfig.maxDistance, this.distance * Math.exp(e.deltaY * 0.001)));
    }) as EventListener, { passive: false });
    this.frame = requestAnimationFrame(this.tick);
  }

  say(text: string) {
    if (this.message === text) return;
    this.message = text;
    this.status(text);
  }

  decorate() {
    const style = this.map.getStyle();
    for (const layer of style.layers) paintCity(this.map, layer);
    hideBasemapBuildings(this.map);
    const source = Object.entries(style.sources).find(([, item]) => item.type === 'vector')?.[0];
    if (!source) return;
    this.sourceId = source;
  }

  labelsOn = true;

  applyLabelVisibility() {
    const visibility = this.labelsOn ? 'visible' : 'none';
    for (const layer of this.map.getStyle().layers) {
      if (LABEL_LAYER.test(layer.id) && this.map.getLayer(layer.id)) this.map.setLayoutProperty(layer.id, 'visibility', visibility);
    }
  }

  toggleLabels() {
    this.labelsOn = !this.labelsOn;
    this.applyLabelVisibility();
  }

  ensureHillshade() {
    if (this.map.getLayer('hillshade')) return;
    const before = this.map.getStyle().layers.find((layer) => layer.type === 'line' && /road|bridge/.test(layer.id))?.id;
    const layer = {
      id: 'hillshade',
      type: 'hillshade' as const,
      source: 'elevation',
      paint: {
        'hillshade-exaggeration': 0.22,
        'hillshade-shadow-color': '#66849b',
        'hillshade-highlight-color': '#fff7ec',
        'hillshade-accent-color': '#a8bfca',
        'hillshade-illumination-direction': 315,
      },
    };
    if (before) this.map.addLayer(layer, before);
    else this.map.addLayer(layer);
  }

  resizeCar(factor: number) {
    const previous = this.carScale;
    const next = previous * factor;
    this.carScale = Math.min(10, Math.max(1, next >= 9.5 ? 10 : next <= 1.08 ? 1 : next));
    this.vehicle.speed *= this.carScale / previous;
    this.hud(this.vehicle.speed * 3.6, this.vehicle.distance, this.carScale, this.fps);
  }

  applySettings(settings: Settings) {
    const terrainChanged = settings.terrain !== this.settings.terrain;
    this.settings = settings;
    if (!this.map.getSource('elevation')) return;
    if (settings.terrain) {
      this.map.setTerrain({ source: 'elevation', exaggeration: 1 });
      this.ensureHillshade();
    } else {
      this.map.setTerrain(null);
      if (this.map.getLayer('hillshade')) this.map.removeLayer('hillshade');
    }
    hideBasemapBuildings(this.map);
    const ratio = settings.quality === 'low' ? 1 : settings.quality === 'medium' ? 1.25 : Math.min(window.devicePixelRatio || 1, 1.5);
    this.map.setPixelRatio(ratio);
    this.city?.configure({ detail: settings.buildingDetail, architecture: settings.architecture, region: this.region });
    if (terrainChanged) { this.collisionDirty = true; this.syncedAt = null; }
  }

  nudgeCamera(dt: number) {
    const yaw = Number(this.keys.has('ArrowRight')) - Number(this.keys.has('ArrowLeft'));
    if (yaw) this.orbit += yaw * dt * 75 * this.settings.sensitivity;
    const zoom = Number(this.keys.has('ArrowDown')) - Number(this.keys.has('ArrowUp'));
    if (!zoom) return;
    const next = this.distance * Math.exp(zoom * dt * 0.9 * this.settings.sensitivity);
    this.distance = Math.max(cameraConfig.minDistance, Math.min(cameraConfig.maxDistance, next));
  }

  resetCamera() {
    this.orbit = 0;
    this.distance = cameraConfig.distance;
    this.pitch = cameraConfig.pitch;
  }

  setSpawnFromClick(lngLat: { lng: number; lat: number }) {
    if (!this.sourceId) return;
    const origin: [number, number] = [lngLat.lng, lngLat.lat];
    const start = roadStart(this.map, this.sourceId, origin, (position, heading) => this.collisions.blocked(position, position, heading));
    const position: [number, number] = start ? start.position : origin;
    const heading = start ? start.heading : this.vehicle.heading;
    this.customSpawn = { position, heading };
    this.vehicle.position = [...position];
    this.vehicle.heading = heading;
    this.bearing = heading * 180 / Math.PI;
    this.renderVehicle.reset(this.vehicle);
    this.collisionDirty = true;
    if (this.settings.terrain) {
      const ground = this.map.queryTerrainElevation(position);
      if (ground != null) this.altitude = ground;
    }
    this.placeSpawnMarker(position);
    this.onSpawnSet(position);
  }

  private placeSpawnMarker(position: [number, number] | null) {
    if (!position) {
      this.spawnMarker?.remove();
      this.spawnMarker = null;
      return;
    }
    if (!this.spawnMarker) {
      const el = document.createElement('div');
      el.className = 'spawn-marker';
      el.innerHTML = `<svg width="30" height="42" viewBox="0 0 30 42" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 27 15 27S30 25.5 30 15C30 6.716 23.284 0 15 0z" fill="#263d38"/><circle cx="15" cy="15" r="6" fill="#e5f1a5"/></svg>`;
      this.spawnMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat(position)
        .addTo(this.map);
    } else {
      this.spawnMarker.setLngLat(position);
    }
    const element = this.spawnMarker.getElement();
    if (element) element.style.display = this.driving ? 'none' : '';
  }

  clearCustomSpawn() {
    this.customSpawn = null;
    if (this.defaultSpawn) {
      this.vehicle.position = [...this.defaultSpawn.position];
      this.vehicle.heading = this.defaultSpawn.heading;
      this.bearing = this.defaultSpawn.heading * 180 / Math.PI;
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
      this.collisionDirty = true;
      this.collisionTime = 0;
      this.placeSpawnMarker(this.defaultSpawn.position);
      if (this.mapShown) this.map.jumpTo(this.introView());
    } else {
      this.placeSpawnMarker(null);
    }
    this.onSpawnSet(null);
  }

  getSpawnPosition(): [number, number] {
    return this.customSpawn ? [this.customSpawn.position[0], this.customSpawn.position[1]] : [this.vehicle.position[0], this.vehicle.position[1]];
  }

  getSpawnHeading(): number {
    return this.customSpawn ? this.customSpawn.heading : this.vehicle.heading;
  }

  buildingsNear(parts: BuildingPart[], focus: [number, number] = this.vehicle.position) {
    const show = (this.driving ? 900 : 1600) ** 2;
    const keep = (this.driving ? 1100 : 2000) ** 2;
    const maxBuildings = this.driving ? 650 : 2500;
    const cos = Math.cos(focus[1] * Math.PI / 180);
    const nearest = (part: BuildingPart) => {
      let best = Infinity;
      for (const point of part.rings[0] ?? []) {
        const east = (point[0] - focus[0]) * 111319.49 * cos;
        const north = (point[1] - focus[1]) * 111319.49;
        const distance = east * east + north * north;
        if (distance < best) best = distance;
      }
      return best;
    };
    const ranked = parts.map((part) => ({ part, distance: nearest(part) })).sort((a, b) => a.distance - b.distance);
    const next = new Set<string>();
    const visible: BuildingPart[] = [];
    for (const item of ranked) {
      if (visible.length >= maxBuildings) break;
      const retain = this.shownBuildings.has(item.part.key) ? item.distance < keep : item.distance < show;
      if (!retain) continue;
      next.add(item.part.key);
      visible.push(item.part);
    }
    this.shownBuildings = next;
    return visible;
  }

  introView() {
    return {
      center: this.vehicle.position as [number, number],
      zoom: 16.8,
      pitch: 57,
      bearing: this.vehicle.heading * 180 / Math.PI - 25,
      elevation: this.altitude,
    };
  }

  revealMap() {
    if (this.mapShown || this.disposed) return;
    this.mapShown = true;
    this.map.jumpTo(this.introView());
    this.introCameraKey = 'locked';
    this.host.style.transition = 'opacity .4s ease';
    this.host.style.opacity = '1';
    this.onBoot(true);
    this.say('Машина готова');
    // Enable drag-pan and click for the intro screen
    this.map.dragPan.enable();
    this.map.scrollZoom.enable();
  }

  private settleBoot() {
    if (this.mapShown || !this.ready) return;
    const waited = performance.now() - this.bootAt;
    if (!this.spawnResolved) {
      this.say('Ставим машину…');
      if (waited > 12000) {
        this.spawnResolved = true;
        this.defaultSpawn = { position: [...this.vehicle.position], heading: this.vehicle.heading };
        this.placeSpawnMarker(this.defaultSpawn.position);
      }
      return;
    }
    if (this.settings.terrain) {
      if (!this.map.isSourceLoaded('elevation')) {
        this.say('Поднимаем рельеф…');
        return;
      }
      const ground = this.map.queryTerrainElevation(this.vehicle.position);
      if (ground == null) {
        this.groundHits = 0;
        this.say('Поднимаем рельеф…');
        if (waited < 10000) return;
      } else {
        const stable = this.lastGround != null && Math.abs(ground - this.lastGround) < 0.35;
        this.groundHits = stable ? this.groundHits + 1 : 0;
        this.lastGround = ground;
        this.altitude = ground;
        if (this.groundHits < 10 && waited < 10000) {
          this.say('Поднимаем рельеф…');
          return;
        }
      }
    } else {
      this.altitude = 0;
    }
    if (!this.map.areTilesLoaded() && waited < 10000) {
      this.say('Грузим улицы…');
      return;
    }
    if (!this.syncedAt) {
      this.collisionDirty = true;
      this.say('Рисуем квартал…');
      if (waited < 14000) return;
    }
    const cells = this.city?.cellCount() ?? 0;
    if ((this.city?.pendingCount() ?? 0) > 0 || this.collisionDirty) {
      this.say('Рисуем кварталы…');
      return;
    }
    if (cells < 1 && waited < 16000) {
      this.settleFrames++;
      this.say('Рисуем квартал…');
      return;
    }
    if (this.settleFrames < 8) {
      this.settleFrames++;
      return;
    }
    this.revealMap();
  }

  setDriving(value: boolean, approach = true) {
    const fromMenu = value && !this.driving && approach;
    this.driving = value;
    this.keys.clear();
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
    this.last = 0;
    this.accumulator = 0;
    this.renderVehicle.reset(this.vehicle);
    if (!value) {
      if (this.spawnMarker) {
        const el = this.spawnMarker.getElement();
        if (el) el.style.display = '';
      }
      const moving = this.approachFrom != null;
      this.approach = 0;
      this.approachFrom = null;
      if (moving) this.onApproach(false);
      if (this.mapShown) {
        const view = this.introView();
        const center = this.map.getCenter();
        if (Math.abs(center.lng - view.center[0]) > 1e-8 || Math.abs(center.lat - view.center[1]) > 1e-8 || Math.abs(this.map.getCenterElevation() - view.elevation) > 0.25 || Math.abs(this.map.getZoom() - view.zoom) > 0.001) {
          this.map.jumpTo(view);
        }
        this.introCameraKey = 'locked';
        // Re-enable map drag for intro
        this.map.dragPan.enable();
        this.map.scrollZoom.enable();
      }
      return;
    }
    if (this.spawnMarker) {
      const el = this.spawnMarker.getElement();
      if (el) el.style.display = 'none';
    }
    // Apply custom spawn before driving starts
    if (fromMenu && this.customSpawn) {
      this.vehicle.position = [...this.customSpawn.position];
      this.vehicle.heading = this.customSpawn.heading;
      this.bearing = this.customSpawn.heading * 180 / Math.PI;
      this.spawnResolved = true;
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
    }
    // Disable map interactivity while driving
    this.map.dragPan.disable();
    this.map.scrollZoom.disable();
    if (!fromMenu) return;
    const center = this.map.getCenter();
    this.approachFrom = { lng: center.lng, lat: center.lat, zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
    this.approach = 1;
    this.onApproach(true);
  }

  noteFrame(now: number) {
    if (!this.fpsStamp) this.fpsStamp = now;
    this.fpsFrames++;
    const span = now - this.fpsStamp;
    if (span < 400) return;
    this.fps = Math.round(this.fpsFrames * 1000 / span);
    this.fpsFrames = 0;
    this.fpsStamp = now;
  }

  plantWheels(dt: number) {
    const settle = (current: number, target: number) => {
      const gap = target - current;
      const rate = 14 + Math.min(22, Math.abs(gap) * 8);
      return current + gap * (1 - Math.exp(-dt * rate));
    };
    if (!this.settings.terrain) {
      this.altitude = settle(this.altitude, 0);
      this.modelPitch = settle(this.modelPitch, 0);
      this.modelRoll = settle(this.modelRoll, 0);
      return;
    }
    const heading = this.renderVehicle.heading;
    const forwardEast = Math.sin(heading);
    const forwardNorth = Math.cos(heading);
    const rightEast = Math.cos(heading);
    const rightNorth = -Math.sin(heading);
    const reach = this.car.length * 0.38 * this.carScale;
    const track = 0.85 * this.carScale;
    const sample = (along: number, side: number) => this.map.queryTerrainElevation(offsetPosition(this.renderVehicle.position, forwardEast * along + rightEast * side, forwardNorth * along + rightNorth * side));
    const frontLeft = sample(reach, -track);
    const frontRight = sample(reach, track);
    const rearLeft = sample(-reach, -track);
    const rearRight = sample(-reach, track);
    const known = [frontLeft, frontRight, rearLeft, rearRight].filter((value): value is number => value != null);
    if (!known.length) return;
    const pair = (a: number | null, b: number | null) => a != null && b != null ? (a + b) / 2 : a ?? b;
    const front = pair(frontLeft, frontRight);
    const rear = pair(rearLeft, rearRight);
    const left = pair(frontLeft, rearLeft);
    const right = pair(frontRight, rearRight);
    const clamp = (value: number) => Math.max(-0.42, Math.min(0.42, value));
    this.modelPitch = settle(this.modelPitch, front != null && rear != null ? clamp(Math.atan2(front - rear, reach * 2)) : this.modelPitch);
    this.modelRoll = settle(this.modelRoll, left != null && right != null ? clamp(Math.atan2(left - right, track * 2)) : this.modelRoll);
    const supports: GroundSample[] = [];
    const add = (along: number, side: number, height: number | null) => {
      if (height != null) supports.push({ along, side, height });
    };
    add(reach, -track, frontLeft);
    add(reach, track, frontRight);
    add(-reach, -track, rearLeft);
    add(-reach, track, rearRight);
    // Include the belly and bumpers when crossing a crest or a sharp bank.
    add(0, 0, sample(0, 0));
    const bumper = this.car.length * 0.5 * this.carScale;
    add(bumper, 0, sample(bumper, 0));
    add(-bumper, 0, sample(-bumper, 0));
    const minimum = supportAltitude(supports, this.modelPitch, this.modelRoll);
    this.altitude = Math.max(minimum, settle(this.altitude, minimum));
  }

  rememberPart(shape: [number, number][][], measuredHeight: number | null, base: number, id: number, levels: number | undefined, kind: string, roofShape: string) {
    const foot = footprintKey(shape);
    const prior = this.remembered.get(foot);
    if (prior && (prior.measured || measuredHeight == null)) return prior.part;
    const height = Math.max(3, Math.min(320, measuredHeight ?? 10));
    const part: BuildingPart = {
      id, rings: shape, height, base, levels, kind, roofShape,
      key: `${Math.round(height)}:${base.toFixed(1)}:${foot}`,
    };
    this.remembered.set(foot, { part, measured: measuredHeight != null });
    return part;
  }

  collectWorld(now: number) {
    this.collisionTime = now;
    this.collisionDirty = false;
    const parts: BuildingPart[] = [];
    for (const feature of this.map.querySourceFeatures(this.sourceId, { sourceLayer: 'building' })) {
      const geometry = feature.geometry;
      const shapes = geometry.type === 'Polygon' ? [geometry.coordinates as Polygon] : geometry.type === 'MultiPolygon' ? geometry.coordinates as Polygon[] : [];
      const props = feature.properties ?? {};
      const reported = Number(props.render_height ?? props.height);
      const measuredHeight = Number.isFinite(reported) && reported > 0 ? reported : null;
      const base = Math.max(0, Number(props.render_min_height ?? props.min_height ?? 0) || 0);
      const rawId = Number(feature.id ?? props.osm_id ?? 0) || 0;
      const levelsValue = Number(props.levels ?? props['building:levels'] ?? props.render_levels ?? 0);
      const levels = levelsValue >= 1 && levelsValue <= 80 ? Math.round(levelsValue) : undefined;
      const kind = String(props.class ?? props.building ?? props.type ?? '');
      const roofShape = String(props.roof_shape ?? props['roof:shape'] ?? '');
      for (const shape of shapes) {
        const anchor = shape[0]?.[0];
        if (!anchor) continue;
        parts.push(this.rememberPart(shape, measuredHeight, base, rawId || Math.round(anchor[0] * 1e5) ^ Math.round(anchor[1] * 1e5), levels, kind, roofShape));
      }
    }
    if (!this.spawnResolved) {
      if (this.customSpawn) {
        // Use the player-chosen spawn point
        if (!this.defaultSpawn) {
          this.defaultSpawn = { position: [...this.vehicle.position], heading: this.vehicle.heading };
        }
        this.vehicle.position = [...this.customSpawn.position];
        this.vehicle.heading = this.customSpawn.heading;
        this.bearing = this.customSpawn.heading * 180 / Math.PI;
        this.spawnResolved = true;
        this.renderVehicle.reset(this.vehicle);
        this.accumulator = 0;
        this.placeSpawnMarker(this.customSpawn.position);
      } else {
        const start = roadStart(this.map, this.sourceId, this.vehicle.position, (position, heading) => this.collisions.blocked(position, position, heading));
        if (start) {
          this.defaultSpawn = { position: [...start.position], heading: start.heading };
          this.vehicle.position = start.position;
          this.vehicle.heading = start.heading;
          this.bearing = start.heading * 180 / Math.PI;
          this.spawnResolved = true;
          this.renderVehicle.reset(this.vehicle);
          this.accumulator = 0;
          this.placeSpawnMarker(start.position);
        } else if (++this.spawnWaits > 12) {
          this.spawnResolved = true;
          this.defaultSpawn = { position: [...this.vehicle.position], heading: this.vehicle.heading };
          this.placeSpawnMarker(this.defaultSpawn.position);
        }
      }
    }
    const center = this.map.getCenter();
    const focus: [number, number] = this.driving ? this.vehicle.position : [center.lng, center.lat];
    const cos = Math.cos(focus[1] * Math.PI / 180);
    const retainRadius = this.driving ? 1050 : 2200;
    const unique = collapseCopies(retainNearParts(keepVisibleParts(parts), this.retained.values(), (part) => {
      let best = Infinity;
      for (const point of part.rings[0] ?? []) {
        const east = (point[0] - focus[0]) * 111319.49 * cos;
        const north = (point[1] - focus[1]) * 111319.49;
        const distance = east * east + north * north;
        if (distance < best) best = distance;
      }
      return best;
    }, retainRadius ** 2));
    const visible = this.buildingsNear(unique, focus);
    if (visible.length) {
      this.retained = new Map(visible.map((part) => [part.key, part]));
      this.city?.sync(visible, this.settings.terrain, focus);
      this.syncedAt = [focus[0], focus[1]];
    }
    const read = (layer: string) => {
      try {
        const features = this.map.querySourceFeatures(this.sourceId, { sourceLayer: layer }) as MapFeature[];
        this.featureReadFailures.delete(layer);
        return features;
      } catch (error) {
        if (!this.featureReadFailures.has(layer)) {
          this.featureReadFailures.add(layer);
          console.error(`Failed to read map source layer "${layer}"`, error);
        }
        return [] as MapFeature[];
      }
    };
    const waterFeatures = read('water');
    const roadFeatures = read('transportation');
    const landuse = read('landuse');
    this.water.collect(this.vehicle.position, waterFeatures, roadFeatures);
    const green = [...read('landcover'), ...landuse, ...read('park')];
    this.thicket.update(this.vehicle.position, green, roadFeatures);
    const greened = this.greenedAt;
    const movedGreen = greened ? Math.hypot((focus[0] - greened[0]) * 111319.49 * cos, (focus[1] - greened[1]) * 111319.49) : Infinity;
    if (movedGreen > 45 || this.greenedTerrain !== this.settings.terrain) {
      this.greenedAt = [focus[0], focus[1]];
      this.greenedTerrain = this.settings.terrain;
      const aheadMeters = this.driving ? 80 : 0;
      const headingRad = this.renderVehicle.heading;
      const greenFocus: [number, number] = aheadMeters > 0 ? offsetPosition(focus, Math.sin(headingRad) * aheadMeters, Math.cos(headingRad) * aheadMeters) : [...focus];
      this.vegetation?.sync({
        green,
        obstacles: [...waterFeatures,
          ...landuse.filter(feature => /^(pitch|playground|track|stadium|parking)$/.test(String(feature.properties?.class ?? ''))),
          ...unique.map(part => ({ geometry: { type: 'Polygon', coordinates: part.rings } }))],
        roads: roadFeatures,
        focus: greenFocus,
      }, this.settings.terrain);
    }
    this.worldFresh = true;
  }

  tick = (now: number) => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    this.noteFrame(now);
    if (!this.ready) return;
    const origin = this.syncedAt;
    const cos = Math.cos(this.vehicle.position[1] * Math.PI / 180);
    const center = this.map.getCenter();
    const checkPoint: [number, number] = this.driving ? this.vehicle.position : [center.lng, center.lat];
    const moved = origin ? Math.hypot((checkPoint[0] - origin[0]) * 111319.49 * cos, (checkPoint[1] - origin[1]) * 111319.49) : Infinity;
    const needCollect = this.collisionDirty || !this.water.covers(this.vehicle.position) || moved >= 40;
    if (needCollect && now - this.collisionTime > 200 && this.sourceId) {
      this.collectWorld(now);
    }
    if (this.driving && !document.hidden) {
      this.accumulator += dt;
      let blocked = false;
      let thicket = false;
      let shore = false;
      while (this.accumulator >= 1 / 60) {
        this.renderVehicle.capture(this.vehicle);
        const previous: [number, number] = [...this.vehicle.position];
        const oldHeading = this.vehicle.heading;
        this.vehicle.step(1 / 60, this.keys, { ...vehicleConfig, acceleration: this.car.acceleration, maxSpeed: this.car.maxSpeed, scale: this.carScale });
        if (this.collisions.blocked(previous, this.vehicle.position, this.vehicle.heading)) {
          this.vehicle.position = previous;
          this.vehicle.heading = oldHeading;
          this.vehicle.speed = 0;
          blocked = true;
        } else if (this.thicket.blocked(previous, this.vehicle.position)) {
          this.vehicle.position = previous;
          this.vehicle.heading = oldHeading;
          this.vehicle.speed = 0;
          thicket = true;
        } else {
          const hit = this.water.resolve(previous, this.vehicle.position, this.vehicle.heading, this.carScale);
          this.vehicle.position = hit.position;
          if (hit.stopped) {
            this.vehicle.speed = 0;
            shore = true;
          }
        }
        this.accumulator -= 1 / 60;
      }
      if (blocked) this.say('Здание · выберите другое направление');
      else if (thicket) this.say('Чаща · здесь не проехать');
      else if (shore) this.say('Берег · в воду нельзя');
      else if (this.message.startsWith('Здание') || this.message.startsWith('Чаща') || this.message.startsWith('Берег')) this.say('');
      this.renderVehicle.update(this.vehicle, this.accumulator * 60);
      this.plantWheels(dt);
      this.nudgeCamera(dt);
      const targetBearing = (this.settings.follow ? this.renderVehicle.heading * 180 / Math.PI : this.bearing) + this.orbit;
      const delta = ((targetBearing - this.bearing + 540) % 360) - 180;
      if (this.settings.follow) this.bearing += delta * (1 - Math.exp(-dt * 5));
      else { this.bearing += this.orbit; this.orbit = 0; }
      const bearingRad = this.bearing * Math.PI / 180;
      const ahead = this.distance * cameraConfig.lookAheadFactor;
      const look = offsetPosition(this.renderVehicle.position, Math.sin(bearingRad) * ahead, Math.cos(bearingRad) * ahead);
      const zoom = zoomForDistance(this.distance, this.renderVehicle.position[1]);
      let center: [number, number] = look;
      let zoomNow = zoom;
      let pitchNow = this.pitch;
      let bearingNow = this.bearing;
      if (this.approachFrom) {
        this.approach = Math.max(0, this.approach - dt / 1.75);
        const t = 1 - this.approach;
        const eased = t * t * (3 - 2 * t);
        const from = this.approachFrom;
        const turn = ((this.bearing - from.bearing + 540) % 360) - 180;
        center = [from.lng + (look[0] - from.lng) * eased, from.lat + (look[1] - from.lat) * eased];
        zoomNow = from.zoom + (zoom - from.zoom) * eased;
        pitchNow = from.pitch + (this.pitch - from.pitch) * eased;
        bearingNow = from.bearing + turn * eased;
        if (this.approach === 0) {
          this.approachFrom = null;
          this.onApproach(false);
        }
      }
      this.map.jumpTo({ center, zoom: zoomNow, pitch: pitchNow, bearing: bearingNow, elevation: this.altitude });
    } else if (!this.driving) {
      this.renderVehicle.reset(this.vehicle);
      if (!this.mapShown) {
        if (this.settings.terrain) {
          const ground = this.map.queryTerrainElevation(this.vehicle.position);
          if (ground != null) this.altitude = ground;
        } else this.altitude = 0;
        const view = this.introView();
        const center = this.map.getCenter();
        if (Math.abs(center.lng - view.center[0]) > 1e-8 || Math.abs(center.lat - view.center[1]) > 1e-8 || Math.abs(this.map.getCenterElevation() - view.elevation) > 0.25 || Math.abs(this.map.getZoom() - view.zoom) > 0.001) this.map.jumpTo(view);
      }
    }
    if (now - this.hudTime > 100) {
      this.hudTime = now;
      this.hud(this.vehicle.speed * 3.6, this.vehicle.distance, this.carScale, this.fps);
    }
    const bootBudget = !this.mapShown && this.spawnResolved ? 24 : 20;
    const budget = !this.spawnResolved ? 0 : this.driving ? (this.worldFresh ? 0 : 1) : (this.mapShown ? 36 : bootBudget);
    const mapCenter = this.map.getCenter();
    const cityFocus: [number, number] = this.driving ? this.renderVehicle.position : [mapCenter.lng, mapCenter.lat];
    this.city?.follow(cityFocus, this.driving ? this.altitude + 1.2 : null, budget, this.driving);
    this.worldFresh = false;
    if (!this.mapShown) this.settleBoot();
    this.map.triggerRepaint();
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.spawnMarker?.remove();
    this.cleanups.forEach((fn) => fn());
    this.map.remove();
  }
}
